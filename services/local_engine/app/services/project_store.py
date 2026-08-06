"""Local SQLite persistence for voices, projects and pronunciation entries."""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..providers.base import VoiceProfile
from .pronunciation_service import PronunciationEntry


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ProjectDocument:
    id: str
    name: str
    source: str
    segments: tuple[dict[str, Any], ...]
    pronunciation_entries: tuple[dict[str, Any], ...]
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "segments": [dict(segment) for segment in self.segments],
            "pronunciation_entries": [dict(entry) for entry in self.pronunciation_entries],
            "updated_at": self.updated_at,
        }


class ProjectStore:
    """Small thread-safe store that survives local-engine restarts."""

    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.db_path = self.workspace / "studio.sqlite3"
        self._lock = threading.RLock()
        self._closed = False
        self._connection = sqlite3.connect(self.db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._initialize()

    def save_voice(self, profile: VoiceProfile) -> VoiceProfile:
        values = profile.to_dict()
        with self._lock:
            self._connection.execute(
                """
                INSERT OR REPLACE INTO voice_profiles (
                    id, provider, name, reference_audio, reference_transcript,
                    reference_language, description, default_preset, consent_json,
                    local_asset_path, cloud_sync_status, version_history_json,
                    favorite, tags_json, metadata_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    values["id"],
                    values["provider"],
                    values["name"],
                    values["reference_audio"],
                    values["reference_transcript"],
                    values["reference_language"],
                    values["description"],
                    values["default_preset"],
                    json.dumps(values["consent"]),
                    values["local_asset_path"],
                    values["cloud_sync_status"],
                    json.dumps(values["version_history"]),
                    int(values["favorite"]),
                    json.dumps(values["tags"]),
                    json.dumps(values["metadata"]),
                    _now(),
                ),
            )
            self._connection.commit()
        return profile

    def list_voices(self) -> list[VoiceProfile]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM voice_profiles ORDER BY favorite DESC, updated_at DESC"
            ).fetchall()
        return [self._voice_from_row(row) for row in rows]

    def get_voice(self, voice_id: str) -> VoiceProfile | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM voice_profiles WHERE id = ?", (voice_id,)
            ).fetchone()
        return self._voice_from_row(row) if row else None

    def save_project(
        self,
        project_id: str,
        name: str,
        source: str,
        segments: Iterable[dict[str, Any]],
        pronunciation_entries: Iterable[dict[str, Any]] = (),
    ) -> ProjectDocument:
        updated_at = _now()
        segment_list = [dict(segment) for segment in segments]
        pronunciation_list = [dict(entry) for entry in pronunciation_entries]
        with self._lock:
            self._connection.execute(
                """
                INSERT OR REPLACE INTO projects (
                    id, name, source, segments_json, pronunciation_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    name,
                    source,
                    json.dumps(segment_list),
                    json.dumps(pronunciation_list),
                    updated_at,
                ),
            )
            self._connection.commit()
        return ProjectDocument(
            id=project_id,
            name=name,
            source=source,
            segments=tuple(segment_list),
            pronunciation_entries=tuple(pronunciation_list),
            updated_at=updated_at,
        )

    def get_project(self, project_id: str) -> ProjectDocument | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            return None
        return ProjectDocument(
            id=row["id"],
            name=row["name"],
            source=row["source"],
            segments=tuple(json.loads(row["segments_json"])),
            pronunciation_entries=tuple(json.loads(row["pronunciation_json"])),
            updated_at=row["updated_at"],
        )

    def save_pronunciation(self, entry: PronunciationEntry) -> PronunciationEntry:
        values = entry.to_dict()
        with self._lock:
            self._connection.execute(
                """
                INSERT OR REPLACE INTO pronunciation_entries (
                    id, term, pronunciation, language, scope, voice_id,
                    project_id, segment_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                tuple(values[key] for key in (
                    "id", "term", "pronunciation", "language", "scope",
                    "voice_id", "project_id", "segment_id",
                )),
            )
            self._connection.commit()
        return entry

    def list_pronunciations(self, project_id: str | None = None) -> list[PronunciationEntry]:
        query = "SELECT * FROM pronunciation_entries"
        params: tuple[Any, ...] = ()
        if project_id is not None:
            query += " WHERE project_id = ? OR scope = 'global'"
            params = (project_id,)
        query += " ORDER BY term COLLATE NOCASE"
        with self._lock:
            rows = self._connection.execute(query, params).fetchall()
        return [
            PronunciationEntry(
                id=row["id"],
                term=row["term"],
                pronunciation=row["pronunciation"],
                language=row["language"],
                scope=row["scope"],
                voice_id=row["voice_id"],
                project_id=row["project_id"],
                segment_id=row["segment_id"],
            )
            for row in rows
        ]

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._connection.close()
            self._closed = True

    def _initialize(self) -> None:
        with self._lock:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS voice_profiles (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    name TEXT NOT NULL,
                    reference_audio TEXT,
                    reference_transcript TEXT,
                    reference_language TEXT,
                    description TEXT NOT NULL,
                    default_preset TEXT NOT NULL,
                    consent_json TEXT NOT NULL,
                    local_asset_path TEXT,
                    cloud_sync_status TEXT NOT NULL,
                    version_history_json TEXT NOT NULL,
                    favorite INTEGER NOT NULL,
                    tags_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source TEXT NOT NULL,
                    segments_json TEXT NOT NULL,
                    pronunciation_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pronunciation_entries (
                    id TEXT PRIMARY KEY,
                    term TEXT NOT NULL,
                    pronunciation TEXT NOT NULL,
                    language TEXT,
                    scope TEXT NOT NULL,
                    voice_id TEXT,
                    project_id TEXT,
                    segment_id TEXT
                );
                """
            )
            self._connection.commit()

    @staticmethod
    def _voice_from_row(row: sqlite3.Row) -> VoiceProfile:
        return VoiceProfile(
            id=row["id"],
            provider=row["provider"],
            reference_audio=row["reference_audio"],
            reference_transcript=row["reference_transcript"],
            reference_language=row["reference_language"],
            name=row["name"],
            description=row["description"],
            default_preset=row["default_preset"],
            consent=json.loads(row["consent_json"]),
            local_asset_path=row["local_asset_path"],
            cloud_sync_status=row["cloud_sync_status"],
            version_history=tuple(json.loads(row["version_history_json"])),
            favorite=bool(row["favorite"]),
            tags=tuple(json.loads(row["tags_json"])),
            metadata=json.loads(row["metadata_json"]),
        )
