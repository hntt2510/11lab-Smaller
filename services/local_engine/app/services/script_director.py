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
    """Parse one segment per non-empty line, preserving native model tags."""

    if not source.strip():
        return []

    segments: list[ScriptSegment] = []
    pending_pause_before = 0
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        speaker: str | None = None
        if dialogue:
            speaker_match = _SPEAKER_PREFIX_PATTERN.match(line)
            if speaker_match is not None:
                speaker = speaker_match.group("speaker").strip()
                line = speaker_match.group("text").strip()

        emotion: str | None = None
        direction: str | None = None
        instruct: str | None = None
        provider_instruct: str | None = None
        speed = 1.0
        duration: float | None = None
        volume = 1.0
        take_count = 1
        pause_before = 0
        pause_after = 0
        voice_id = default_voice_id
        native_tags: list[str] = []
        warnings: list[str] = []
        unknown_tags: list[str] = []

        def replace_tag(match: re.Match[str]) -> str:
            nonlocal emotion, direction, instruct, provider_instruct, speed, duration, volume, take_count
            nonlocal pause_before, pause_after, voice_id

            raw_tag = match.group(1).strip()
            normalized = raw_tag.lower()
            before_text = bool(line[: match.start()].strip())
            execution = resolve_direction(normalized, provider_name)
            if execution.native_tags:
                native_tags.extend(execution.native_tags)
                return f"[{normalized}]"

            if is_supported_direction(normalized, provider_name):
                emotion = normalized
                direction = normalized
                provider_instruct = execution.provider_instruct
                instruct = provider_instruct
                speed = execution.speed
                volume = execution.volume
                pause_after = max(pause_after, execution.pause_after_ms)
                take_count = execution.take_count
                return ""

            compound = normalized.split()
            compound_execution = resolve_direction(compound[0], provider_name) if compound else None
            if compound and is_supported_direction(compound[0], provider_name) and not compound_execution.native_tags:
                emotion = compound[0]
                direction = compound[0]
                provider_instruct = compound_execution.provider_instruct
                instruct = provider_instruct
                speed = compound_execution.speed
                volume = compound_execution.volume
                pause_after = max(pause_after, compound_execution.pause_after_ms)
                take_count = compound_execution.take_count
                for option in compound[1:]:
                    option_speed = _SPEED_PATTERN.match(option)
                    option_pause = _PAUSE_PATTERN.match(option)
                    option_duration = _DURATION_PATTERN.match(option)
                    option_voice = _VOICE_PATTERN.match(option)
                    if option_speed:
                        speed = float(option_speed.group(1))
                    elif option_pause:
                        pause_after = max(pause_after, int(option_pause.group(1)))
                    elif option_duration:
                        duration = float(option_duration.group(1))
                    elif option_voice:
                        voice_id = option_voice.group(1)
                    else:
                        unknown_tags.append(option)
                return ""

            speed_match = _SPEED_PATTERN.match(normalized)
            if speed_match:
                speed = float(speed_match.group(1))
                return ""

            pause_match = _PAUSE_PATTERN.match(normalized)
            if pause_match:
                pause_ms = int(pause_match.group(1))
                if before_text:
                    pause_after = max(pause_after, pause_ms)
                else:
                    pause_before = max(pause_before, pause_ms)
                return ""

            duration_match = _DURATION_PATTERN.match(normalized)
            if duration_match:
                duration = float(duration_match.group(1))
                return ""

            voice_match = _VOICE_PATTERN.match(normalized)
            if voice_match:
                voice_id = voice_match.group(1)
                return ""

            unknown_tags.append(raw_tag)
            return match.group(0)

        text = _TAG_PATTERN.sub(replace_tag, line).strip()
        if not text:
            pause_only = _PAUSE_PATTERN.fullmatch(line.strip("[] "))
            if pause_only:
                pending_pause_before += int(pause_only.group(1))
            continue

        if unknown_tags:
            warnings.append("Unknown studio tags kept in text: " + ", ".join(unknown_tags))
        if dialogue and speaker is None:
            warnings.append("Dialogue line has no speaker prefix and requires a voice assignment.")
        if direction:
            warnings.append("Studio direction is best-effort; the reference voice remains dominant.")
        segments.append(
            ScriptSegment(
                id=f"segment-{len(segments) + 1:02d}",
                text=text,
                speaker=speaker,
                voice_id=voice_id,
                emotion=emotion,
                direction=direction,
                instruct=instruct,
                provider_instruct=provider_instruct,
                speed=speed,
                duration=duration,
                pause_before_ms=pending_pause_before + pause_before,
                pause_after_ms=pause_after,
                volume=volume,
                inference_quality="Balanced",
                guidance=2.0,
                take_count=take_count,
                native_tags=tuple(native_tags),
                warnings=tuple(warnings),
            )
        )
        pending_pause_before = 0

    if segments and pending_pause_before:
        last = segments[-1]
        segments[-1] = ScriptSegment(
            **{
                **last.to_dict(),
                "pause_after_ms": max(last.pause_after_ms, pending_pause_before),
                "native_tags": tuple(last.native_tags),
                "warnings": tuple(last.warnings),
            }
        )
    return segments
