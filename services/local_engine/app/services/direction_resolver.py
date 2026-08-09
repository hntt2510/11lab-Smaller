"""Provider-neutral resolution of Studio directions into generation controls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from omnivoice.utils.acoustic_tags import OMNIVOICE_NATIVE_ACOUSTIC_TAGS


STUDIO_FALLBACKS: dict[str, dict[str, Any]] = {
    "calm": {"speed": 0.92, "pause_after_ms": 280, "take_count": 1},
    "excited": {"speed": 1.08, "pause_after_ms": 120, "take_count": 2},
    "sad": {"speed": 0.88, "pause_after_ms": 320, "take_count": 1},
    "serious": {"speed": 0.94, "pause_after_ms": 220, "take_count": 1},
    "happy": {"speed": 1.04, "pause_after_ms": 140, "take_count": 1},
    "angry": {"speed": 1.06, "pause_after_ms": 150, "take_count": 2},
    "nervous": {"speed": 1.03, "pause_after_ms": 160, "take_count": 2},
    "curious": {"speed": 1.02, "pause_after_ms": 180, "take_count": 1},
    "slow": {"speed": 0.82, "pause_after_ms": 350, "take_count": 1},
    "fast": {"speed": 1.12, "pause_after_ms": 90, "take_count": 1},
    "emphasis": {"speed": 1.0, "pause_after_ms": 180, "take_count": 2},
}


@dataclass(frozen=True)
class DirectionExecution:
    direction: str | None
    provider_instruct: str | None = None
    native_tags: tuple[str, ...] = ()
    speed: float = 1.0
    volume: float = 1.0
    pause_after_ms: int = 0
    take_count: int = 1
    warnings: tuple[str, ...] = ()

    def to_preset(self) -> dict[str, Any]:
        return {
            "speed": self.speed,
            "volume": self.volume,
            "pause_after_ms": self.pause_after_ms,
            "take_count": self.take_count,
            "provider_instruct": self.provider_instruct,
            "instruct": self.provider_instruct,
        }


class DirectionCapabilityAdapter:
    """Small provider boundary: future providers can replace only this class."""

    native_tags: frozenset[str] = frozenset()

    def resolve_instruct(self, direction: str) -> str | None:
        return None


class OmniVoiceDirectionAdapter(DirectionCapabilityAdapter):
    native_tags = OMNIVOICE_NATIVE_ACOUSTIC_TAGS

    def resolve_instruct(self, direction: str) -> str | None:
        if direction != "whisper":
            return None
        # Use the model's own validator as the authoritative instruct vocabulary.
        from omnivoice.utils.voice_design import resolve_instruct

        return resolve_instruct("whisper")


_ADAPTERS: dict[str, DirectionCapabilityAdapter] = {"omnivoice": OmniVoiceDirectionAdapter()}


def resolve_direction(direction: str | None, provider_name: str = "omnivoice") -> DirectionExecution:
    if direction is None:
        return DirectionExecution(direction=None)
    normalized = direction.strip().lower()
    adapter = _ADAPTERS.get(provider_name, DirectionCapabilityAdapter())
    if normalized in adapter.native_tags:
        return DirectionExecution(direction=normalized, native_tags=(normalized,))
    provider_instruct = adapter.resolve_instruct(normalized)
    if provider_instruct is not None:
        return DirectionExecution(direction=normalized, provider_instruct=provider_instruct)
    fallback = STUDIO_FALLBACKS.get(normalized)
    if fallback is not None:
        return DirectionExecution(direction=normalized, **fallback)
    return DirectionExecution(
        direction=normalized,
        warnings=(f"Unsupported Studio direction kept in text: {normalized}",),
    )


def is_supported_direction(direction: str, provider_name: str = "omnivoice") -> bool:
    normalized = direction.strip().lower()
    adapter = _ADAPTERS.get(provider_name, DirectionCapabilityAdapter())
    return normalized in adapter.native_tags or adapter.resolve_instruct(normalized) is not None or normalized in STUDIO_FALLBACKS


def studio_presets(provider_name: str = "omnivoice") -> dict[str, dict[str, Any]]:
    return {name: resolve_direction(name, provider_name).to_preset() for name in (*STUDIO_FALLBACKS, "whisper")}
