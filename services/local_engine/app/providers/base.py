"""Provider contract shared by local and future commercial TTS engines."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np


@dataclass(frozen=True)
class TTSRequest:
    """Provider-neutral request for one synthesis operation."""

    text: str
    language: str | None = None
    ref_audio: str | None = None
    ref_text: str | None = None
    instruct: str | None = None
    duration: float | None = None
    speed: float | None = None
    options: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("text must not be empty")
        if self.duration is not None and self.duration <= 0:
            raise ValueError("duration must be greater than zero")
        if self.speed is not None and self.speed <= 0:
            raise ValueError("speed must be greater than zero")


@dataclass(frozen=True)
class TTSResult:
    """Audio returned by a provider."""

    audio: np.ndarray
    sampling_rate: int
    provider: str
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.audio.ndim != 1:
            raise ValueError("provider audio must be a mono 1-D waveform")
        if self.sampling_rate <= 0:
            raise ValueError("sampling_rate must be greater than zero")


@dataclass(frozen=True)
class VoiceProfile:
    """Provider-neutral metadata for a reusable reference voice."""

    id: str
    provider: str
    reference_audio: str | None = None
    reference_transcript: str | None = None
    reference_language: str | None = None
    name: str = "Untitled voice"
    description: str = ""
    default_preset: str = "Balanced"
    consent: Mapping[str, Any] = field(default_factory=dict)
    local_asset_path: str | None = None
    cloud_sync_status: str = "local"
    version_history: tuple[Mapping[str, Any], ...] = ()
    favorite: bool = False
    tags: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": self.provider,
            "reference_audio": self.reference_audio,
            "reference_transcript": self.reference_transcript,
            "reference_language": self.reference_language,
            "name": self.name,
            "description": self.description,
            "default_preset": self.default_preset,
            "consent": dict(self.consent),
            "local_asset_path": self.local_asset_path,
            "cloud_sync_status": self.cloud_sync_status,
            "version_history": [dict(item) for item in self.version_history],
            "favorite": self.favorite,
            "tags": list(self.tags),
            "metadata": dict(self.metadata),
        }


class TTSProvider(ABC):
    """Interface implemented by every local or remote TTS backend."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Stable provider identifier."""

    @property
    @abstractmethod
    def is_loaded(self) -> bool:
        """Whether the provider model is currently resident."""

    @abstractmethod
    def load(self) -> None:
        """Load model resources required for generation."""

    @abstractmethod
    def unload(self) -> None:
        """Release model resources."""

    @abstractmethod
    def generate(self, request: TTSRequest) -> TTSResult:
        """Generate one waveform."""

    def transcribe(self, reference_audio: str) -> str:
        """Transcribe a reference when the provider exposes an ASR model."""

        raise RuntimeError(f"Provider '{self.name}' does not support transcription")

    @abstractmethod
    def create_voice_profile(
        self,
        reference_audio: str | None,
        reference_transcript: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> VoiceProfile:
        """Create reusable voice metadata without coupling callers to a model."""

    @abstractmethod
    def get_capabilities(self) -> Mapping[str, Any]:
        """Describe supported modes and controls."""

    @abstractmethod
    def get_license_info(self) -> Mapping[str, Any]:
        """Describe the provider license and commercial-use constraints."""
