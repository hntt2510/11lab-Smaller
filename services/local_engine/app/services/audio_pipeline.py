"""Lightweight waveform editing, mastering, quality checks and export."""

from __future__ import annotations

import math
import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np


MASTERING_PRESETS: dict[str, dict[str, Any]] = {
    "Raw": {"trim_silence": False, "high_pass": False, "compress": False, "target_rms_db": None},
    "YouTube Narration": {"trim_silence": True, "high_pass": True, "compress": True, "target_rms_db": -16.0},
    "Documentary": {"trim_silence": True, "high_pass": True, "compress": True, "target_rms_db": -18.0},
    "Podcast": {"trim_silence": True, "high_pass": True, "compress": True, "target_rms_db": -16.0},
    "Product Review": {"trim_silence": True, "high_pass": True, "compress": True, "target_rms_db": -15.0},
    "Short-form / TikTok": {"trim_silence": True, "high_pass": True, "compress": True, "target_rms_db": -14.0},
}


@dataclass(frozen=True)
class AudioMetrics:
    duration_seconds: float
    sample_rate: int
    channels: int
    rms_db: float
    peak_db: float
    clipping_ratio: float
    silence_ratio: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "duration_seconds": round(self.duration_seconds, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "rms_db": round(self.rms_db, 2),
            "peak_db": round(self.peak_db, 2),
            "clipping_ratio": round(self.clipping_ratio, 5),
            "silence_ratio": round(self.silence_ratio, 4),
        }


@dataclass(frozen=True)
class AudioProcessResult:
    output_path: str
    preset: str
    metrics: AudioMetrics
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "output_path": self.output_path,
            "preset": self.preset,
            "metrics": self.metrics.to_dict(),
            "warnings": list(self.warnings),
        }


def process_audio(
    source_path: str | Path,
    output_path: str | Path,
    *,
    trim_start: float = 0.0,
    trim_end: float | None = None,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
    volume: float = 1.0,
    silence_before: float = 0.0,
    silence_after: float = 0.0,
    preset: str = "Raw",
) -> AudioProcessResult:
    """Apply non-destructive edit parameters and write a new WAV file."""

    if preset not in MASTERING_PRESETS:
        raise ValueError(f"Unknown mastering preset: {preset}")
    if trim_start < 0 or (trim_end is not None and trim_end <= trim_start):
        raise ValueError("trim range is invalid")
    if min(fade_in, fade_out, silence_before, silence_after) < 0:
        raise ValueError("fade and silence values must not be negative")
    if volume <= 0:
        raise ValueError("volume must be greater than zero")

    audio, sample_rate = load_audio(source_path)
    if audio.shape[0] == 0:
        raise ValueError("source audio is empty")
    start = int(round(trim_start * sample_rate))
    end = audio.shape[0] if trim_end is None else int(round(trim_end * sample_rate))
    if start >= audio.shape[0] or end > audio.shape[0] or end <= start:
        raise ValueError("trim range exceeds source duration")
    audio = audio[start:end].copy()
    audio *= float(volume)

    audio = add_silence(audio, sample_rate, silence_before, silence_after)
    audio = apply_fades(audio, sample_rate, fade_in, fade_out)
    audio = master_audio(audio, sample_rate, preset)

    destination = Path(output_path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_audio(destination, audio, sample_rate)
    metrics = measure_audio(audio, sample_rate)
    return AudioProcessResult(
        output_path=str(destination),
        preset=preset,
        metrics=metrics,
        warnings=quality_warnings(metrics),
    )


def load_audio(path: str | Path) -> tuple[np.ndarray, int]:
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"audio file does not exist: {source}")
    try:
        import soundfile as sf

        data, sample_rate = sf.read(str(source), always_2d=True, dtype="float32")
        return np.asarray(data), int(sample_rate)
    except ImportError:
        return _load_pcm_wav(source)
    except RuntimeError as exc:
        raise ValueError(f"unable to decode audio: {exc}") from exc


def write_audio(path: str | Path, audio: np.ndarray, sample_rate: int) -> None:
    destination = Path(path)
    if destination.suffix.lower() != ".wav":
        raise ValueError("write_audio currently writes WAV output only")
    try:
        import soundfile as sf

        sf.write(str(destination), audio, sample_rate, format="WAV")
        return
    except ImportError:
        pass

    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(destination), "wb") as wav:
        wav.setnchannels(int(pcm.shape[1] if pcm.ndim == 2 else 1))
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def measure_audio(audio: np.ndarray, sample_rate: int) -> AudioMetrics:
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    rms = float(np.sqrt(np.mean(np.square(mono)))) if mono.size else 0.0
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    frame_size = max(1, int(sample_rate * 0.02))
    frame_rms = np.asarray(
        [
            np.sqrt(np.mean(np.square(mono[start : start + frame_size])))
            for start in range(0, mono.size, frame_size)
        ]
    )
    silence_ratio = float(np.mean(frame_rms < 0.01)) if frame_rms.size else 1.0
    return AudioMetrics(
        duration_seconds=mono.size / sample_rate if sample_rate else 0.0,
        sample_rate=sample_rate,
        channels=int(audio.shape[1] if audio.ndim == 2 else 1),
        rms_db=_db(rms),
        peak_db=_db(peak),
        clipping_ratio=float(np.mean(np.abs(mono) >= 0.999)) if mono.size else 0.0,
        silence_ratio=silence_ratio,
    )


def quality_check(
    path: str | Path,
    expected_duration: float | None = None,
) -> dict[str, Any]:
    audio, sample_rate = load_audio(path)
    metrics = measure_audio(audio, sample_rate)
    warnings = quality_warnings(metrics)
    if expected_duration is not None:
        delta = abs(metrics.duration_seconds - expected_duration)
        if delta > max(0.25, expected_duration * 0.12):
            warnings.append(f"Duration differs from target by {delta:.2f} seconds")
    return {"metrics": metrics.to_dict(), "passed": not warnings, "warnings": warnings}


def quality_warnings(metrics: AudioMetrics) -> list[str]:
    warnings: list[str] = []
    if metrics.clipping_ratio > 0.001:
        warnings.append("Clipping detected")
    if metrics.rms_db < -36:
        warnings.append("Loudness is very low")
    if metrics.silence_ratio > 0.35:
        warnings.append(f"Silence ratio is {metrics.silence_ratio:.0%}")
    if metrics.duration_seconds <= 0.05:
        warnings.append("Output is nearly empty")
    return warnings


def master_audio(audio: np.ndarray, sample_rate: int, preset: str) -> np.ndarray:
    settings = MASTERING_PRESETS[preset]
    result = audio.copy()
    if settings["trim_silence"]:
        result = trim_silence(result, sample_rate)
    if settings["high_pass"]:
        result = high_pass(result, sample_rate, cutoff=75.0)
    if settings["compress"]:
        result = compress(result, threshold=0.55, ratio=3.0)
    target_rms_db = settings["target_rms_db"]
    if target_rms_db is not None:
        rms = float(np.sqrt(np.mean(np.square(result))))
        if rms > 1e-7:
            gain = min(12.0, 10 ** ((target_rms_db - _db(rms)) / 20.0))
            result *= gain
    return np.clip(result, -0.891, 0.891)


def trim_silence(audio: np.ndarray, sample_rate: int, threshold: float = 0.01) -> np.ndarray:
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    active = np.flatnonzero(np.abs(mono) >= threshold)
    if active.size == 0:
        return audio[:0]
    padding = int(sample_rate * 0.03)
    start = max(0, int(active[0]) - padding)
    end = min(audio.shape[0], int(active[-1]) + padding + 1)
    return audio[start:end]


def add_silence(
    audio: np.ndarray,
    sample_rate: int,
    before: float,
    after: float,
) -> np.ndarray:
    channels = audio.shape[1] if audio.ndim == 2 else 1
    shape = lambda seconds: (int(round(seconds * sample_rate)), channels)
    before_audio = np.zeros(shape(before), dtype=np.float32)
    after_audio = np.zeros(shape(after), dtype=np.float32)
    body = audio if audio.ndim == 2 else audio[:, None]
    return np.concatenate((before_audio, body, after_audio), axis=0)


def apply_fades(audio: np.ndarray, sample_rate: int, fade_in: float, fade_out: float) -> np.ndarray:
    result = audio.copy()
    if result.ndim == 1:
        result = result[:, None]
    if fade_in:
        count = min(result.shape[0], int(round(fade_in * sample_rate)))
        if count:
            result[:count] *= np.linspace(0.0, 1.0, count, dtype=np.float32)[:, None]
    if fade_out:
        count = min(result.shape[0], int(round(fade_out * sample_rate)))
        if count:
            result[-count:] *= np.linspace(1.0, 0.0, count, dtype=np.float32)[:, None]
    return result


def high_pass(audio: np.ndarray, sample_rate: int, cutoff: float) -> np.ndarray:
    result = audio.copy()
    if result.ndim == 1:
        result = result[:, None]
    dt = 1.0 / sample_rate
    rc = 1.0 / (2.0 * math.pi * cutoff)
    alpha = rc / (rc + dt)
    for channel in range(result.shape[1]):
        values = result[:, channel]
        previous_input = float(values[0]) if len(values) else 0.0
        for index in range(1, len(values)):
            current_input = float(values[index])
            values[index] = alpha * (values[index - 1] + current_input - previous_input)
            previous_input = current_input
    return result


def compress(audio: np.ndarray, threshold: float, ratio: float) -> np.ndarray:
    magnitude = np.abs(audio)
    over = magnitude > threshold
    compressed = threshold + (magnitude - threshold) / ratio
    return np.where(over, np.sign(audio) * compressed, audio)


def export_mp3(source_wav: str | Path, output_mp3: str | Path) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("FFmpeg is required for MP3 export")
    source = Path(source_wav).expanduser().resolve()
    destination = Path(output_mp3).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", str(source), "-codec:a", "libmp3lame", "-q:a", "2", str(destination)],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(exc.stderr.strip() or "FFmpeg MP3 export failed") from exc
    return str(destination)


def export_srt(segments: Iterable[dict[str, Any]]) -> str:
    """Build an SRT timeline from parsed script segments."""

    cursor = 0.0
    blocks: list[str] = []
    for index, segment in enumerate(segments, start=1):
        cursor += float(segment.get("pause_before_ms", 0)) / 1000.0
        duration = segment.get("duration")
        if duration is None:
            duration = max(0.2, len(str(segment.get("text", ""))) / 13.0)
        start = cursor
        end = start + float(duration)
        blocks.append(
            f"{index}\n{_srt_time(start)} --> {_srt_time(end)}\n{segment.get('text', '').strip()}\n"
        )
        cursor = end + float(segment.get("pause_after_ms", 0)) / 1000.0
    return "\n".join(blocks)


def _srt_time(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _db(value: float) -> float:
    return 20.0 * math.log10(max(value, 1e-9))


def _load_pcm_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if sample_width != 2:
        raise ValueError("fallback WAV pipeline only supports 16-bit PCM")
    values = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return values.reshape(-1, channels), sample_rate
