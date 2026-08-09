"""Parse Script Studio tags into provider-neutral generation segments."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


NATIVE_TAGS = frozenset(
    {
        "laughter",
        "sigh",
        "confirmation-en",
        "question-en",
        "question-ah",
        "question-oh",
        "question-ei",
        "question-yi",
        "surprise-ah",
        "surprise-oh",
        "surprise-wa",
        "surprise-yo",
        "dissatisfaction-hnn",
    }
)

STUDIO_PRESETS: dict[str, dict[str, Any]] = {
    "calm": {
        "speed": 0.92,
        "pause_after_ms": 280,
        "take_count": 1,
    },
    "excited": {
        "speed": 1.05,
        "pause_after_ms": 120,
        "take_count": 2,
    },
    "sad": {"speed": 0.88, "pause_after_ms": 300, "take_count": 1},
    "serious": {
        "speed": 0.94,
        "pause_after_ms": 220,
        "take_count": 1,
    },
    "whisper": {
        "speed": 0.94,
        "volume": 0.86,
        "pause_after_ms": 260,
        "take_count": 1,
        "instruct": "whisper",
    },
    "slow": {"speed": 0.82, "pause_after_ms": 350, "take_count": 1},
    "fast": {"speed": 1.12, "pause_after_ms": 90, "take_count": 1},
    "emphasis": {
        "speed": 1.0,
        "pause_after_ms": 180,
        "take_count": 2,
    },
}

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
    instruct: str | None = None
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
            "instruct": self.instruct,
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
        instruct: str | None = None
        speed = 1.0
        duration: float | None = None
        volume = 1.0
        pause_before = 0
        pause_after = 0
        voice_id = default_voice_id
        native_tags: list[str] = []
        warnings: list[str] = []
        unknown_tags: list[str] = []

        def replace_tag(match: re.Match[str]) -> str:
            nonlocal emotion, instruct, speed, duration, volume
            nonlocal pause_before, pause_after, voice_id

            raw_tag = match.group(1).strip()
            normalized = raw_tag.lower()
            before_text = bool(line[: match.start()].strip())
            if normalized in NATIVE_TAGS:
                native_tags.append(normalized)
                return f"[{normalized}]"

            preset = STUDIO_PRESETS.get(normalized)
            if preset is not None:
                emotion = normalized
                instruct = preset.get("instruct", instruct)
                speed = float(preset.get("speed", speed))
                volume = float(preset.get("volume", volume))
                pause_after = max(pause_after, int(preset.get("pause_after_ms", 0)))
                return ""

            compound = normalized.split()
            compound_preset = STUDIO_PRESETS.get(compound[0]) if compound else None
            if compound_preset is not None:
                emotion = compound[0]
                instruct = compound_preset.get("instruct", instruct)
                speed = float(compound_preset.get("speed", speed))
                volume = float(compound_preset.get("volume", volume))
                pause_after = max(
                    pause_after,
                    int(compound_preset.get("pause_after_ms", 0)),
                )
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
        if emotion in {"excited", "whisper"}:
            warnings.append("Studio direction is best-effort; the reference voice remains dominant.")

        preset = STUDIO_PRESETS.get(emotion or "", {})
        segments.append(
            ScriptSegment(
                id=f"segment-{len(segments) + 1:02d}",
                text=text,
                speaker=speaker,
                voice_id=voice_id,
                emotion=emotion,
                instruct=instruct,
                speed=speed,
                duration=duration,
                pause_before_ms=pending_pause_before + pause_before,
                pause_after_ms=pause_after,
                volume=volume,
                inference_quality="Balanced",
                guidance=2.0,
                take_count=int(preset.get("take_count", 1)),
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
