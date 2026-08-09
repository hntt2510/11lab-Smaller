"""Loopback FastAPI service for Tauri or another local desktop client."""

import argparse
import logging
import secrets
from dataclasses import replace
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from .audio import encode_wav
from .providers.base import TTSProvider, TTSRequest
from .providers.omnivoice_provider import OmniVoiceProvider
from .queue import RenderQueue
from .services.audio_pipeline import (
    MASTERING_PRESETS,
    export_mp3,
    export_srt,
    process_audio,
    quality_check,
)
from .services.pronunciation_service import (
    PronunciationEntry,
    apply_pronunciations,
    find_suspicious_terms,
)
from .services.project_store import ProjectStore
from .services.reference_analyzer import analyze_reference
from .services.script_director import parse_script

logger = logging.getLogger(__name__)

DESKTOP_ORIGINS = (
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "http://tauri.localhost",
    "tauri://localhost",
)
REFERENCE_EXTENSIONS = {".wav", ".mp3"}
MAX_REFERENCE_BYTES = 50 * 1024 * 1024


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    language: str | None = None
    ref_audio: str | None = None
    ref_text: str | None = None
    instruct: str | None = None
    duration: float | None = Field(default=None, gt=0)
    speed: float | None = Field(default=None, gt=0)
    options: dict[str, Any] = Field(default_factory=dict)


class QueueRequest(GenerateRequest):
    output_filename: str | None = None
    max_attempts: int | None = Field(default=None, ge=1, le=10)


class ScriptParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1)
    default_voice_id: str | None = None


class ReferenceAnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    target_language: str | None = None


class ReferenceTranscribeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)


class VoiceCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    reference_audio: str | None = None
    reference_transcript: str | None = None
    reference_language: str | None = None
    description: str = ""
    default_preset: str = "Balanced"
    consent_type: str | None = None
    consent_confirmed: bool = False
    favorite: bool = False
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    source: str = ""
    segments: list[dict[str, Any]] = Field(default_factory=list)
    pronunciation_entries: list[dict[str, Any]] = Field(default_factory=list)


class PronunciationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    term: str = Field(min_length=1)
    pronunciation: str = Field(min_length=1)
    language: str | None = None
    scope: str = "project"
    voice_id: str | None = None
    project_id: str | None = None
    segment_id: str | None = None


class PronunciationPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    entries: list[dict[str, Any]] = Field(default_factory=list)


class AudioProcessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_path: str = Field(min_length=1)
    output_filename: str | None = None
    output_format: Literal["wav", "mp3"] = "wav"
    trim_start: float = Field(default=0.0, ge=0)
    trim_end: float | None = Field(default=None, gt=0)
    fade_in: float = Field(default=0.0, ge=0)
    fade_out: float = Field(default=0.0, ge=0)
    volume: float = Field(default=1.0, gt=0)
    silence_before: float = Field(default=0.0, ge=0)
    silence_after: float = Field(default=0.0, ge=0)
    preset: str = "Raw"


class AudioQualityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    expected_duration: float | None = Field(default=None, gt=0)


class SrtExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    segments: list[dict[str, Any]] = Field(default_factory=list)
    output_filename: str | None = None


def create_app(
    provider: TTSProvider | None = None,
    token: str | None = None,
    render_queue: RenderQueue | None = None,
    project_store: ProjectStore | None = None,
) -> FastAPI:
    """Create an authenticated loopback API around a provider instance."""

    app = FastAPI(title="OmniVoice Local Engine", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(DESKTOP_ORIGINS),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.state.provider = provider or OmniVoiceProvider()
    app.state.token = token or secrets.token_urlsafe(32)
    app.state.render_queue = render_queue
    app.state.project_store = project_store
    app.state.workspace = (
        project_store.workspace
        if project_store is not None
        else render_queue.workspace
        if render_queue is not None
        else None
    )
    if render_queue is not None:
        app.router.add_event_handler("shutdown", render_queue.shutdown)
    if project_store is not None:
        app.router.add_event_handler("shutdown", project_store.close)

    def require_token(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {app.state.token}"
        if not secrets.compare_digest(authorization or "", expected):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid local engine token",
            )

    @app.get("/health", dependencies=[Depends(require_token)])
    def health(request: Request) -> dict[str, Any]:
        engine: TTSProvider = request.app.state.provider
        return {
            "status": "ok",
            "provider": engine.name,
            "model_loaded": engine.is_loaded,
            "queue_enabled": request.app.state.render_queue is not None,
            "store_enabled": request.app.state.project_store is not None,
        }

    @app.get("/capabilities", dependencies=[Depends(require_token)])
    def capabilities(request: Request) -> dict[str, Any]:
        engine: TTSProvider = request.app.state.provider
        return {
            "provider": engine.name,
            "capabilities": dict(engine.get_capabilities()),
            "license": dict(engine.get_license_info()),
        }

    @app.post("/model/load", dependencies=[Depends(require_token)])
    def load_model(request: Request) -> dict[str, Any]:
        engine: TTSProvider = request.app.state.provider
        try:
            engine.load()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"status": "loaded", "provider": engine.name}

    @app.post("/model/unload", dependencies=[Depends(require_token)])
    def unload_model(request: Request) -> dict[str, Any]:
        engine: TTSProvider = request.app.state.provider
        engine.unload()
        return {"status": "unloaded", "provider": engine.name}

    @app.post("/generate", dependencies=[Depends(require_token)])
    def generate(payload: GenerateRequest, request: Request) -> Response:
        engine: TTSProvider = request.app.state.provider
        try:
            result = engine.generate(TTSRequest(**payload.model_dump()))
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        wav_bytes = encode_wav(result.audio, result.sampling_rate)
        headers = {
            "X-Provider": result.provider,
            "X-Sampling-Rate": str(result.sampling_rate),
        }
        workspace: Path | None = request.app.state.workspace
        if workspace is not None:
            output_path = workspace / f"generated-{secrets.token_hex(8)}.wav"
            output_path.write_bytes(wav_bytes)
            headers["X-Output-Path"] = str(output_path)

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers=headers,
        )

    @app.post("/script/parse", dependencies=[Depends(require_token)])
    def parse_script_route(payload: ScriptParseRequest) -> dict[str, Any]:
        try:
            segments = parse_script(payload.source, payload.default_voice_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "segments": [segment.to_dict() for segment in segments],
            "suspicious_terms": find_suspicious_terms(payload.source),
        }

    @app.post("/references/analyze", dependencies=[Depends(require_token)])
    def analyze_reference_route(payload: ReferenceAnalyzeRequest) -> dict[str, Any]:
        try:
            return analyze_reference(payload.path, payload.target_language).to_dict()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/references/transcribe", dependencies=[Depends(require_token)])
    def transcribe_reference(
        payload: ReferenceTranscribeRequest,
        request: Request,
    ) -> dict[str, str]:
        engine: TTSProvider = request.app.state.provider
        try:
            return {"text": engine.transcribe(payload.path)}
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/voices", dependencies=[Depends(require_token)])
    def list_voices(request: Request) -> list[dict[str, Any]]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        return [voice.to_dict() for voice in store.list_voices()]

    @app.post("/voices", dependencies=[Depends(require_token)])
    def create_voice(payload: VoiceCreateRequest, request: Request) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        if payload.reference_audio and not payload.consent_confirmed:
            raise HTTPException(
                status_code=422,
                detail="Voice consent must be confirmed before saving a reference",
            )

        metadata = dict(payload.metadata)
        if payload.reference_audio:
            try:
                analysis = analyze_reference(payload.reference_audio)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            metadata["reference_analysis"] = analysis.to_dict()

        engine: TTSProvider = request.app.state.provider
        profile = engine.create_voice_profile(
            payload.reference_audio,
            payload.reference_transcript,
            metadata,
        )
        profile = replace(
            profile,
            name=payload.name,
            reference_language=payload.reference_language,
            description=payload.description,
            default_preset=payload.default_preset,
            consent={
                "type": payload.consent_type,
                "confirmed": payload.consent_confirmed,
            },
            local_asset_path=payload.reference_audio,
            favorite=payload.favorite,
            tags=tuple(payload.tags),
            metadata=metadata,
        )
        return store.save_voice(profile).to_dict()

    @app.post("/voices/upload", dependencies=[Depends(require_token)])
    async def upload_voice(
        request: Request,
        file: UploadFile = File(...),
        name: str = Form(...),
        reference_transcript: str = Form(""),
        reference_language: str | None = Form(default=None),
        default_preset: str = Form("Balanced"),
        consent_type: str = Form("owned_voice"),
        consent_confirmed: bool = Form(False),
    ) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        workspace: Path | None = request.app.state.workspace
        if store is None or workspace is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in REFERENCE_EXTENSIONS:
            raise HTTPException(status_code=422, detail="Only WAV and MP3 reference files are supported")
        content = await file.read(MAX_REFERENCE_BYTES + 1)
        if len(content) > MAX_REFERENCE_BYTES:
            raise HTTPException(status_code=413, detail="Reference audio must be 50 MB or smaller")

        reference_dir = workspace / "references"
        reference_dir.mkdir(parents=True, exist_ok=True)
        reference_path = reference_dir / f"{secrets.token_urlsafe(12)}{suffix}"
        reference_path.write_bytes(content)
        try:
            payload = VoiceCreateRequest(
                name=name,
                reference_audio=str(reference_path),
                reference_transcript=reference_transcript or None,
                reference_language=reference_language,
                default_preset=default_preset,
                consent_type=consent_type,
                consent_confirmed=consent_confirmed,
            )
            return create_voice(payload, request)
        except (HTTPException, ValueError):
            reference_path.unlink(missing_ok=True)
            raise

    @app.get("/voices/{voice_id}", dependencies=[Depends(require_token)])
    def get_voice(voice_id: str, request: Request) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        profile = store.get_voice(voice_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Voice profile not found")
        return profile.to_dict()

    @app.put("/projects/{project_id}", dependencies=[Depends(require_token)])
    def save_project(
        project_id: str,
        payload: ProjectSaveRequest,
        request: Request,
    ) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        project = store.save_project(
            project_id,
            payload.name,
            payload.source,
            payload.segments,
            payload.pronunciation_entries,
        )
        return project.to_dict()

    @app.get("/projects/{project_id}", dependencies=[Depends(require_token)])
    def get_project(project_id: str, request: Request) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project.to_dict()

    @app.get("/pronunciation", dependencies=[Depends(require_token)])
    def list_pronunciation(
        request: Request,
        project_id: str | None = None,
    ) -> list[dict[str, Any]]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        return [entry.to_dict() for entry in store.list_pronunciations(project_id)]

    @app.post("/pronunciation", dependencies=[Depends(require_token)])
    def create_pronunciation(
        payload: PronunciationCreateRequest,
        request: Request,
    ) -> dict[str, Any]:
        store: ProjectStore | None = request.app.state.project_store
        if store is None:
            raise HTTPException(status_code=503, detail="Project store is disabled")
        try:
            entry = PronunciationEntry(
                id=secrets.token_urlsafe(12),
                term=payload.term,
                pronunciation=payload.pronunciation,
                language=payload.language,
                scope=payload.scope,
                voice_id=payload.voice_id,
                project_id=payload.project_id,
                segment_id=payload.segment_id,
            )
            return store.save_pronunciation(entry).to_dict()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/pronunciation/preview", dependencies=[Depends(require_token)])
    def pronunciation_preview(payload: PronunciationPreviewRequest) -> dict[str, Any]:
        try:
            entries = [PronunciationEntry(**entry) for entry in payload.entries]
            return {"text": apply_pronunciations(payload.text, entries)}
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/audio/presets", dependencies=[Depends(require_token)])
    def audio_presets() -> dict[str, list[str]]:
        return {"presets": list(MASTERING_PRESETS)}

    @app.get("/audio/file", dependencies=[Depends(require_token)])
    def audio_file(path: str, request: Request) -> FileResponse:
        workspace: Path | None = request.app.state.workspace
        if workspace is None:
            raise HTTPException(status_code=503, detail="Workspace is disabled")
        candidate = Path(path).expanduser().resolve()
        if candidate == workspace or not candidate.is_relative_to(workspace):
            raise HTTPException(status_code=422, detail="audio path must stay inside the workspace")
        if candidate.suffix.lower() not in {".wav", ".mp3", ".srt"}:
            raise HTTPException(status_code=422, detail="only WAV, MP3 and SRT files can be served")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="audio file not found")
        media_type = {
            ".mp3": "audio/mpeg",
            ".srt": "application/x-subrip",
        }.get(candidate.suffix.lower(), "audio/wav")
        return FileResponse(candidate, media_type=media_type, filename=candidate.name)

    @app.post("/audio/process", dependencies=[Depends(require_token)])
    def process_audio_route(
        payload: AudioProcessRequest,
        request: Request,
    ) -> dict[str, Any]:
        workspace: Path | None = request.app.state.workspace
        if workspace is None:
            raise HTTPException(status_code=503, detail="Workspace is disabled")
        try:
            suffix = ".mp3" if payload.output_format == "mp3" else ".wav"
            output_name = payload.output_filename or f"processed-{secrets.token_hex(8)}{suffix}"
            output_path = _resolve_workspace_path(workspace, output_name, suffix)
            if payload.output_format == "wav":
                result = process_audio(
                    payload.source_path,
                    output_path,
                    trim_start=payload.trim_start,
                    trim_end=payload.trim_end,
                    fade_in=payload.fade_in,
                    fade_out=payload.fade_out,
                    volume=payload.volume,
                    silence_before=payload.silence_before,
                    silence_after=payload.silence_after,
                    preset=payload.preset,
                )
                return result.to_dict()

            temporary_wav = workspace / f".processed-{secrets.token_hex(8)}.wav"
            try:
                result = process_audio(
                    payload.source_path,
                    temporary_wav,
                    trim_start=payload.trim_start,
                    trim_end=payload.trim_end,
                    fade_in=payload.fade_in,
                    fade_out=payload.fade_out,
                    volume=payload.volume,
                    silence_before=payload.silence_before,
                    silence_after=payload.silence_after,
                    preset=payload.preset,
                )
                exported = export_mp3(temporary_wav, output_path)
                return {
                    "output_path": exported,
                    "preset": result.preset,
                    "metrics": result.metrics.to_dict(),
                    "warnings": list(result.warnings),
                }
            finally:
                if temporary_wav.exists():
                    temporary_wav.unlink()
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/audio/quality", dependencies=[Depends(require_token)])
    def audio_quality_route(
        payload: AudioQualityRequest,
    ) -> dict[str, Any]:
        try:
            return quality_check(payload.path, payload.expected_duration)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/audio/export/srt", dependencies=[Depends(require_token)])
    def export_srt_route(
        payload: SrtExportRequest,
        request: Request,
    ) -> dict[str, str]:
        workspace: Path | None = request.app.state.workspace
        if workspace is None:
            raise HTTPException(status_code=503, detail="Workspace is disabled")
        try:
            output_name = payload.output_filename or f"subtitles-{secrets.token_hex(8)}.srt"
            output_path = _resolve_workspace_path(workspace, output_name, ".srt")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(export_srt(payload.segments), encoding="utf-8")
            return {"output_path": str(output_path)}
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/queue", dependencies=[Depends(require_token)])
    def enqueue(payload: QueueRequest, request: Request) -> dict[str, Any]:
        queue: RenderQueue | None = request.app.state.render_queue
        if queue is None:
            raise HTTPException(status_code=503, detail="Render queue is disabled")

        values = payload.model_dump()
        output_filename = values.pop("output_filename")
        max_attempts = values.pop("max_attempts")
        try:
            job = queue.submit(
                TTSRequest(**values),
                output_filename=output_filename,
                max_attempts=max_attempts,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return job.to_dict()

    @app.get("/queue", dependencies=[Depends(require_token)])
    def list_queue(request: Request, limit: int = 50) -> list[dict[str, Any]]:
        queue: RenderQueue | None = request.app.state.render_queue
        if queue is None:
            raise HTTPException(status_code=503, detail="Render queue is disabled")
        try:
            return [job.to_dict() for job in queue.list(limit)]
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/queue/{job_id}", dependencies=[Depends(require_token)])
    def get_queue_job(job_id: str, request: Request) -> dict[str, Any]:
        queue: RenderQueue | None = request.app.state.render_queue
        if queue is None:
            raise HTTPException(status_code=503, detail="Render queue is disabled")
        job = queue.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Render job not found")
        return job.to_dict()

    @app.post("/queue/{job_id}/cancel", dependencies=[Depends(require_token)])
    def cancel_queue_job(job_id: str, request: Request) -> dict[str, Any]:
        queue: RenderQueue | None = request.app.state.render_queue
        if queue is None:
            raise HTTPException(status_code=503, detail="Render queue is disabled")
        job = queue.cancel(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Render job not found")
        return job.to_dict()

    return app


def _resolve_workspace_path(workspace: Path, filename: str, suffix: str) -> Path:
    candidate = (workspace / filename).resolve()
    if candidate == workspace or not candidate.is_relative_to(workspace):
        raise ValueError("output path must stay inside the workspace")
    if candidate.suffix.lower() != suffix:
        raise ValueError(f"output path must use the {suffix} extension")
    return candidate


def main() -> None:
    parser = argparse.ArgumentParser(description="OmniVoice local inference engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--model", default="k2-fsa/OmniVoice")
    parser.add_argument("--device", default=None)
    parser.add_argument("--workspace", default="workspace")
    parser.add_argument("--token", default=None)
    args = parser.parse_args()

    token = args.token or secrets.token_urlsafe(32)
    provider = OmniVoiceProvider(model_name=args.model, device=args.device)
    render_queue = RenderQueue(provider, Path(args.workspace))
    project_store = ProjectStore(Path(args.workspace))
    app = create_app(
        provider=provider,
        token=token,
        render_queue=render_queue,
        project_store=project_store,
    )
    logger.info("Local engine token: %s", token)

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
