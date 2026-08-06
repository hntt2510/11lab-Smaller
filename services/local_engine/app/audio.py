"""Small audio helpers shared by the local engine and render queue."""

import io
import wave

import numpy as np


def encode_wav(audio: np.ndarray, sampling_rate: int) -> bytes:
    """Encode a mono floating-point waveform as PCM16 WAV bytes."""

    if audio.ndim != 1:
        raise ValueError("audio must be a mono 1-D waveform")
    if sampling_rate <= 0:
        raise ValueError("sampling_rate must be greater than zero")

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sampling_rate)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()
