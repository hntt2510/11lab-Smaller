"""Adapter from the local engine contract to the upstream OmniVoice model."""

import gc
import threading
import uuid
from typing import Any, Mapping

import numpy as np

from .base import TTSProvider, TTSRequest, TTSResult, VoiceProfile


class OmniVoiceProvider(TTSProvider):
    """Use the upstream model without exposing it to application callers."""

    def __init__(
        self,
        model_name: str = "k2-fsa/OmniVoice",
        device: str | None = None,
        dtype: str | None = "float16",
        commercial_build: bool = False,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.dtype = dtype
        self.commercial_build = commercial_build
        self._model = None
        self._lock = threading.RLock()

    @property
    def name(self) -> str:
        return "omnivoice"

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        with self._lock:
            if self.commercial_build:
                raise RuntimeError(
                    "The OmniVoice checkpoint is non-commercial and is disabled "
                    "in commercial builds. Configure a licensed provider instead."
                )
            if self.is_loaded:
                return

            import torch

            from omnivoice.models.omnivoice import OmniVoice
            from omnivoice.utils.common import get_best_device

            device = self.device or get_best_device()
            model_kwargs: dict[str, Any] = {"device_map": device}
            if self.dtype:
                model_kwargs["dtype"] = getattr(torch, self.dtype)
            self._model = OmniVoice.from_pretrained(
                self.model_name, **model_kwargs
            )

    def unload(self) -> None:
        with self._lock:
            model = self._model
            self._model = None
            if model is None:
                return

            del model
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass

    def generate(self, request: TTSRequest) -> TTSResult:
        with self._lock:
            self.load()
            model = self._model
            if model is None:
                raise RuntimeError("OmniVoice model is not loaded")

            kwargs = dict(request.options)
            if request.language is not None:
                kwargs["language"] = request.language
            if request.ref_audio is not None:
                kwargs["ref_audio"] = request.ref_audio
            if request.ref_text is not None:
                kwargs["ref_text"] = request.ref_text
            if request.instruct is not None:
                kwargs["instruct"] = request.instruct
            if request.duration is not None:
                kwargs["duration"] = request.duration
            if request.speed is not None:
                kwargs["speed"] = request.speed

            audios = model.generate(text=request.text, **kwargs)
            audio = np.asarray(audios[0], dtype=np.float32)
            return TTSResult(
                audio=audio,
                sampling_rate=model.sampling_rate,
                provider=self.name,
            )

    def transcribe(self, reference_audio: str) -> str:
        with self._lock:
            self.load()
            model = self._model
            if model is None:
                raise RuntimeError("OmniVoice model is not loaded")
            if model._asr_pipe is None:
                model.load_asr_model()
            return model.transcribe(reference_audio)

    def create_voice_profile(
        self,
        reference_audio: str | None,
        reference_transcript: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> VoiceProfile:
        return VoiceProfile(
            id=f"voice-{uuid.uuid4()}",
            provider=self.name,
            reference_audio=reference_audio,
            reference_transcript=reference_transcript,
            metadata=dict(metadata or {}),
        )

    def get_capabilities(self) -> Mapping[str, Any]:
        return {
            "modes": ["auto", "voice_clone", "voice_design"],
            "supports_batch": True,
            "supports_duration": True,
            "supports_speed": True,
            "supported_controls": [
                "num_step",
                "guidance_scale",
                "t_shift",
                "denoise",
                "postprocess_output",
                "layer_penalty_factor",
                "position_temperature",
                "class_temperature",
            ],
        }

    def get_license_info(self) -> Mapping[str, Any]:
        return {
            "license": "CC-BY-NC",
            "commercial_use": False,
            "commercial_build": self.commercial_build,
            "note": "Use a separately licensed provider for commercial builds.",
        }
