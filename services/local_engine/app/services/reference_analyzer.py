"""Audio-only reference quality analysis for Voice Library onboarding."""

from __future__ import annotations

import math
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


@dataclass(frozen=True)
class ReferenceAnalysis:
    path: str
    duration_seconds: float
    sample_rate: int
    channels: int
    rms_db: float
    peak_db: float
    clipping_ratio: float
    noise_level: float
    silence_ratio: float
    score: int
    warnings: tuple[str, ...]
    asr_confidence: float | None = None
    language_match: bool | None = None
    background_music_detected: bool | None = None
    multiple_speakers_detected: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "duration_seconds": round(self.duration_seconds, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "rms_db": round(self.rms_db, 2),
            "peak_db": round(self.peak_db, 2),
            "clipping_ratio": round(self.clipping_ratio, 5),
            "noise_level": round(self.noise_level, 4),
            "silence_ratio": round(self.silence_ratio, 4),
            "score": self.score,
            "warnings": list(self.warnings),
            "asr_confidence": self.asr_confidence,
            "language_match": self.language_match,
            "background_music_detected": self.background_music_detected,
            "multiple_speakers_detected": self.multiple_speakers_detected,
        }


def analyze_reference(
    path: str | Path,
    target_language: str | None = None,
) -> ReferenceAnalysis:
    """Analyze measurable signal quality without pretending to run ASR."""

    reference_path = Path(path).expanduser().resolve()
    audio, sample_rate, channels = _load_audio(reference_path)
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    if mono.size == 0:
        raise ValueError("reference audio is empty")

    duration = mono.size / sample_rate
    peak = float(np.max(np.abs(mono)))
    rms = float(np.sqrt(np.mean(np.square(mono))))
    frame_size = max(1, int(sample_rate * 0.02))
    frame_rms = np.asarray(
        [
            np.sqrt(np.mean(np.square(mono[start : start + frame_size])))
            for start in range(0, mono.size, frame_size)
        ]
    )
    silence_ratio = float(np.mean(frame_rms < 0.01))
    noise_level = float(np.percentile(frame_rms, 20) / max(rms, 1e-9))
    clipping_ratio = float(np.mean(np.abs(mono) >= 0.999))
    rms_db = _db(rms)
    peak_db = _db(peak)

    score = 100
    warnings: list[str] = []
    if duration < 3:
        score -= 15
        warnings.append("Reference is shorter than the recommended 3 seconds")
    elif duration > 10:
        score -= 10
        warnings.append("Reference is longer than the recommended 10 seconds")
    if duration > 15:
        score -= 10
        warnings.append("Long references can make cloning less consistent")
    if clipping_ratio > 0.001:
        score -= 20
        warnings.append("Clipping detected")
    if silence_ratio > 0.25:
        score -= min(20, int((silence_ratio - 0.25) * 60))
        warnings.append(f"Silence ratio is {silence_ratio:.0%}")
    if rms_db < -35:
        score -= 15
        warnings.append("Reference volume is very low")
    if noise_level > 0.55:
        score -= 10
        warnings.append("Elevated background noise estimate")

    if target_language:
        warnings.append("Language match requires the optional Whisper analyzer")

    return ReferenceAnalysis(
        path=str(reference_path),
        duration_seconds=duration,
        sample_rate=sample_rate,
        channels=channels,
        rms_db=rms_db,
        peak_db=peak_db,
        clipping_ratio=clipping_ratio,
        noise_level=noise_level,
        silence_ratio=silence_ratio,
        score=max(0, min(100, score)),
        warnings=tuple(warnings),
    )


def _db(value: float) -> float:
    return 20.0 * math.log10(max(value, 1e-9))


def _load_audio(path: Path) -> tuple[np.ndarray, int, int]:
    if not path.is_file():
        raise ValueError(f"reference audio does not exist: {path}")

    try:
        import soundfile as sf

        audio, sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
        return np.asarray(audio), int(sample_rate), int(audio.shape[1])
    except ImportError:
        return _load_pcm_wav(path)
    except RuntimeError as exc:
        raise ValueError(f"unable to decode reference audio: {exc}") from exc


def _load_pcm_wav(path: Path) -> tuple[np.ndarray, int, int]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if sample_width != 2:
        raise ValueError("fallback WAV analyzer only supports 16-bit PCM")
    values = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return values.reshape(-1, channels), sample_rate, channels
