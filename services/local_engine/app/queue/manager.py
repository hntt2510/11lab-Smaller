"""Single-worker durable render queue for local synthesis jobs."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..audio import encode_wav
from ..providers.base import TTSProvider, TTSRequest


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class RenderJob:
    id: str
    status: str
    request: TTSRequest
    output_path: str
    attempts: int
    max_attempts: int
    error: str | None
    created_at: str
    updated_at: str
    completed_at: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "request": {
                "text": self.request.text,
                "language": self.request.language,
                "ref_audio": self.request.ref_audio,
                "ref_text": self.request.ref_text,
                "instruct": self.request.instruct,
                "duration": self.request.duration,
                "speed": self.request.speed,
                "options": dict(self.request.options),
            },
            "output_path": self.output_path,
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
        }


class RenderQueue:
    """Persist and process one synthesis job at a time.

    Jobs left in ``running`` state are returned to ``queued`` on restart so a
    crashed sidecar can resume them without losing the request.
    """

    def __init__(
        self,
        provider: TTSProvider,
        workspace: str | Path,
        max_attempts: int = 2,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least one")

        self.provider = provider
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.db_path = self.workspace / "render-queue.sqlite3"
        self.max_attempts = max_attempts
        self._db_lock = threading.RLock()
        self._wake = threading.Condition(self._db_lock)
        self._stop = False
        self._closed = False
        self._connection = sqlite3.connect(
            self.db_path, check_same_thread=False
        )
        self._connection.row_factory = sqlite3.Row
        self._initialize_db()
        self._recover_running_jobs()
        self._worker = threading.Thread(
            target=self._run_worker,
            name="omnivoice-render-queue",
            daemon=True,
        )
        self._worker.start()

    def submit(
        self,
        request: TTSRequest,
        output_filename: str | None = None,
        max_attempts: int | None = None,
    ) -> RenderJob:
        job_id = f"render-{uuid.uuid4()}"
        output_path = self._resolve_output_path(
            output_filename or f"{job_id}.wav"
        )
        now = _now()
        attempts_limit = (
            self.max_attempts if max_attempts is None else max_attempts
        )
        if attempts_limit < 1:
            raise ValueError("max_attempts must be at least one")

        with self._wake:
            if self._stop:
                raise RuntimeError("render queue is shut down")
            self._connection.execute(
                """
                INSERT INTO render_jobs (
                    id, status, request_json, output_path, attempts,
                    max_attempts, error, created_at, updated_at, completed_at
                ) VALUES (?, 'queued', ?, ?, 0, ?, NULL, ?, ?, NULL)
                """,
                (
                    job_id,
                    json.dumps(self._request_to_dict(request)),
                    str(output_path),
                    attempts_limit,
                    now,
                    now,
                ),
            )
            self._connection.commit()
            self._wake.notify()
        job = self.get(job_id)
        if job is None:
            raise RuntimeError("render job was not persisted")
        return job

    def get(self, job_id: str) -> RenderJob | None:
        with self._db_lock:
            row = self._connection.execute(
                "SELECT * FROM render_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return self._row_to_job(row) if row else None

    def list(self, limit: int = 50) -> list[RenderJob]:
        if limit < 1:
            raise ValueError("limit must be at least one")
        with self._db_lock:
            rows = self._connection.execute(
                """
                SELECT * FROM render_jobs
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def cancel(self, job_id: str) -> RenderJob | None:
        with self._wake:
            now = _now()
            self._connection.execute(
                """
                UPDATE render_jobs
                SET status = 'cancelled', error = NULL, updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (now, job_id),
            )
            self._connection.commit()
            self._wake.notify()
        return self.get(job_id)

    def shutdown(self, wait: bool = True) -> None:
        with self._wake:
            if self._closed:
                return
            self._stop = True
            self._wake.notify_all()
        if wait and self._worker.is_alive():
            self._worker.join()
        if not self._worker.is_alive():
            with self._db_lock:
                self._connection.close()
                self._closed = True

    def _initialize_db(self) -> None:
        with self._db_lock:
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS render_jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    output_path TEXT NOT NULL,
                    attempts INTEGER NOT NULL,
                    max_attempts INTEGER NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT
                )
                """
            )
            self._connection.commit()

    def _recover_running_jobs(self) -> None:
        with self._db_lock:
            now = _now()
            self._connection.execute(
                """
                UPDATE render_jobs
                SET status = 'queued', error = 'Recovered after engine restart',
                    updated_at = ?
                WHERE status = 'running'
                """,
                (now,),
            )
            self._connection.commit()

    def _run_worker(self) -> None:
        while True:
            with self._wake:
                job = self._claim_next_job()
                while job is None and not self._stop:
                    self._wake.wait()
                    job = self._claim_next_job()
                if self._stop:
                    return

            self._process(job)

    def _claim_next_job(self) -> RenderJob | None:
        now = _now()
        self._connection.execute("BEGIN IMMEDIATE")
        row = self._connection.execute(
            """
            SELECT * FROM render_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            self._connection.commit()
            return None

        self._connection.execute(
            """
            UPDATE render_jobs
            SET status = 'running', attempts = attempts + 1, updated_at = ?
            WHERE id = ?
            """,
            (now, row["id"]),
        )
        self._connection.commit()
        updated = self._connection.execute(
            "SELECT * FROM render_jobs WHERE id = ?", (row["id"],)
        ).fetchone()
        return self._row_to_job(updated)

    def _process(self, job: RenderJob) -> None:
        try:
            result = self.provider.generate(job.request)
            output_path = Path(job.output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self.workspace / f".{job.id}.tmp"
            temp_path.write_bytes(encode_wav(result.audio, result.sampling_rate))
            os.replace(temp_path, output_path)
        except Exception as exc:  # Queue failures must be persisted for retry/UI.
            self._mark_failed(job, str(exc))
            return

        with self._db_lock:
            now = _now()
            self._connection.execute(
                """
                UPDATE render_jobs
                SET status = 'completed', error = NULL, updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (now, now, job.id),
            )
            self._connection.commit()

    def _mark_failed(self, job: RenderJob, error: str) -> None:
        status = "queued" if job.attempts < job.max_attempts else "failed"
        with self._wake:
            now = _now()
            self._connection.execute(
                """
                UPDATE render_jobs
                SET status = ?, error = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, error, now, job.id),
            )
            self._connection.commit()
            if status == "queued":
                self._wake.notify()

    def _resolve_output_path(self, output_filename: str) -> Path:
        candidate = (self.workspace / output_filename).resolve()
        if not candidate.is_relative_to(self.workspace):
            raise ValueError("output path must stay inside the workspace")
        if candidate.suffix.lower() != ".wav":
            raise ValueError("output path must use the .wav extension")
        return candidate

    @staticmethod
    def _request_to_dict(request: TTSRequest) -> dict[str, Any]:
        return {
            "text": request.text,
            "language": request.language,
            "ref_audio": request.ref_audio,
            "ref_text": request.ref_text,
            "instruct": request.instruct,
            "duration": request.duration,
            "speed": request.speed,
            "options": dict(request.options),
        }

    @classmethod
    def _row_to_job(cls, row: sqlite3.Row) -> RenderJob:
        request = TTSRequest(**json.loads(row["request_json"]))
        return RenderJob(
            id=row["id"],
            status=row["status"],
            request=request,
            output_path=row["output_path"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            error=row["error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            completed_at=row["completed_at"],
        )
