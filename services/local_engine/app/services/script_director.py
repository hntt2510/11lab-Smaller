"""Parse Script Studio tags into provider-neutral generation segments."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .direction_resolver import is_supported_direction, resolve_direction, studio_presets

# Kept as an API compatibility alias; all values are resolved centrally.
STUDIO_PRESETS = studio_presets()

_TAG_PATTERN = re.compile(r"\[([^\]]+)\]")
_SPEED_PATTERN = re.compile(r"^speed\s*=\s*(0?\.\d+|\d+(?:\.\d+)?)$", re.I)
_PAUSE_PATTERN = re.compile(r"^pause\s*=\s*(\d+)$", re.I)
_DURATION_PATTERN = re.compile(r"^duration\s*=\s*(\d+(?:\.\d+)?)$", re.I)
_VOICE_PATTERN = re.compile(r"^voice\s*=\s*([\w.-]+)$", re.I)
_SPEAKER_PREFIX_PATTERN = re.compile(
    r"^(?P<speaker>[A-Za-z][A-Za-z _-]{0,63}):\s*(?P<text>.+)$"
)


@dataclass(frozen=True)
class ScriptSegment:
    """A single directed line ready for generation or editing."""

    id: str
    text: str
    speaker: str | None = None
    voice_id: str | None = None
    emotion: str | None = None
    direction: str | None = None
    instruct: str | None = None
    provider_instruct: str | None = None
    speed: float = 1.0
    duration: float | None = None
    pause_before_ms: int = 0
    pause_after_ms: int = 0
    volume: float = 1.0
    inference_quality: str = "Balanced"
    guidance: float = 2.0
    take_count: int = 1
    pronunciation_overrides: dict[str, str] = field(default_factory=dict)
    selected_take: str | None = None
    render_status: str = "draft"
    native_tags: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "speaker": self.speaker,
            "voice_id": self.voice_id,
            "emotion": self.emotion,
            "direction": self.direction,
            "instruct": self.instruct,
            "provider_instruct": self.provider_instruct,
            "speed": self.speed,
            "duration": self.duration,
            "pause_before_ms": self.pause_before_ms,
            "pause_after_ms": self.pause_after_ms,
            "volume": self.volume,
            "inference_quality": self.inference_quality,
            "guidance": self.guidance,
            "take_count": self.take_count,
            "pronunciation_overrides": dict(self.pronunciation_overrides),
            "selected_take": self.selected_take,
            "render_status": self.render_status,
            "native_tags": list(self.native_tags),
            "warnings": list(self.warnings),
        }


def parse_script(
    source: str,
    default_voice_id: str | None = None,
    dialogue: bool = False,
    provider_name: str = "omnivoice",
) -> list[ScriptSegment]:
    """Parse continuous text into independent direction spans.

    New direction and native reaction tags are semantic boundaries.  Direction
    fallback pauses are kept only at a source/chunk end; internal boundaries
    use no invented pause so Goal 06 assembles continuous narration naturally.
    """

    if not source.strip():
        return []

    chunks: list[tuple[str | None, str]] = []
    if dialogue:
        for raw_line in source.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            match = _SPEAKER_PREFIX_PATTERN.match(line)
            chunks.append((match.group("speaker").strip() if match else None, match.group("text").strip() if match else line))
    else:
        continuous = " ".join(line.strip() for line in source.splitlines() if line.strip())
        if continuous:
            chunks.append((None, continuous))

    segments: list[ScriptSegment] = []
    pending_pause_before = 0

    def new_state(direction: str | None = None, native_tag: str | None = None) -> dict[str, Any]:
        execution = resolve_direction(direction, provider_name)
        return {
            "text": "",
            "emotion": native_tag or direction,
            "direction": native_tag or direction,
            "instruct": execution.provider_instruct,
            "provider_instruct": execution.provider_instruct,
            "speed": execution.speed,
            "duration": None,
            "volume": execution.volume,
            "take_count": execution.take_count,
            "fallback_pause_after": execution.pause_after_ms,
            "explicit_pause_after": 0,
            "pause_before": 0,
            "voice_id": default_voice_id,
            "native_tags": [native_tag] if native_tag else [],
            "warnings": [],
        }

    for speaker, content in chunks:
        current = new_state()

        def emit(*, internal_boundary: bool) -> None:
            nonlocal current, pending_pause_before
            text = current["text"].strip()
            if not text:
                return
            warnings = list(current["warnings"])
            if dialogue and speaker is None:
                warnings.append("Dialogue line has no speaker prefix and requires a voice assignment.")
            if current["direction"]:
                warnings.append("Studio direction is best-effort; the reference voice remains dominant.")
            segments.append(ScriptSegment(
                id=f"segment-{len(segments) + 1:02d}", text=text, speaker=speaker,
                voice_id=current["voice_id"], emotion=current["emotion"], direction=current["direction"],
                instruct=current["instruct"], provider_instruct=current["provider_instruct"], speed=current["speed"],
                duration=current["duration"], pause_before_ms=pending_pause_before + current["pause_before"],
                pause_after_ms=current["explicit_pause_after"] if internal_boundary else max(current["fallback_pause_after"], current["explicit_pause_after"]),
                volume=current["volume"], inference_quality="Balanced", guidance=2.0,
                take_count=current["take_count"], native_tags=tuple(current["native_tags"]), warnings=tuple(warnings),
            ))
            pending_pause_before = 0

        def apply_options(options: list[str]) -> None:
            for option in options:
                speed_match = _SPEED_PATTERN.match(option)
                pause_match = _PAUSE_PATTERN.match(option)
                duration_match = _DURATION_PATTERN.match(option)
                voice_match = _VOICE_PATTERN.match(option)
                if speed_match:
                    current["speed"] = float(speed_match.group(1))
                elif pause_match:
                    current["explicit_pause_after"] = max(current["explicit_pause_after"], int(pause_match.group(1)))
                elif duration_match:
                    current["duration"] = float(duration_match.group(1))
                elif voice_match:
                    current["voice_id"] = voice_match.group(1)
                else:
                    current["warnings"].append(f"Unknown studio tag kept in text: {option}")

        cursor = 0
        for match in _TAG_PATTERN.finditer(content):
            current["text"] += content[cursor:match.start()]
            raw_tag = match.group(1).strip()
            normalized = raw_tag.lower()
            pause_match = _PAUSE_PATTERN.match(normalized)
            if pause_match:
                pause_ms = int(pause_match.group(1))
                if current["text"].strip():
                    current["explicit_pause_after"] = max(current["explicit_pause_after"], pause_ms)
                else:
                    pending_pause_before += pause_ms
                cursor = match.end()
                continue
            execution = resolve_direction(normalized, provider_name)
            if execution.native_tags:
                emit(internal_boundary=True)
                current = new_state(native_tag=normalized)
                current["text"] = f"[{normalized}]"
            elif is_supported_direction(normalized, provider_name):
                emit(internal_boundary=True)
                current = new_state(direction=normalized)
            else:
                parts = normalized.split()
                if parts and is_supported_direction(parts[0], provider_name) and not resolve_direction(parts[0], provider_name).native_tags:
                    emit(internal_boundary=True)
                    current = new_state(direction=parts[0])
                    apply_options(parts[1:])
                elif _SPEED_PATTERN.match(normalized):
                    current["speed"] = float(_SPEED_PATTERN.match(normalized).group(1))
                elif _DURATION_PATTERN.match(normalized):
                    current["duration"] = float(_DURATION_PATTERN.match(normalized).group(1))
                elif _VOICE_PATTERN.match(normalized):
                    current["voice_id"] = _VOICE_PATTERN.match(normalized).group(1)
                else:
                    current["text"] += match.group(0)
                    current["warnings"].append(f"Unknown studio tag kept in text: {raw_tag}")
            cursor = match.end()
        current["text"] += content[cursor:]
        emit(internal_boundary=False)

    if segments and pending_pause_before:
        last = segments[-1]
        segments[-1] = ScriptSegment(**{**last.to_dict(), "pause_after_ms": max(last.pause_after_ms, pending_pause_before), "native_tags": tuple(last.native_tags), "warnings": tuple(last.warnings)})
    return segments
