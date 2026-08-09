import warnings
from importlib.metadata import PackageNotFoundError, version

warnings.filterwarnings("ignore", module="torchaudio")
warnings.filterwarnings(
    "ignore",
    category=SyntaxWarning,
    message="invalid escape sequence",
    module="pydub.utils",
)
warnings.filterwarnings(
    "ignore",
    category=FutureWarning,
    module="torch.distributed.algorithms.ddp_comm_hooks",
)

try:
    __version__ = version("omnivoice")
except PackageNotFoundError:
    __version__ = "0.0.0"

__all__ = ["OmniVoice", "OmniVoiceConfig", "OmniVoiceGenerationConfig"]


def __getattr__(name: str):
    if name not in __all__:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    from omnivoice.models.omnivoice import (
        OmniVoice,
        OmniVoiceConfig,
        OmniVoiceGenerationConfig,
    )

    exports = {
        "OmniVoice": OmniVoice,
        "OmniVoiceConfig": OmniVoiceConfig,
        "OmniVoiceGenerationConfig": OmniVoiceGenerationConfig,
    }
    globals().update(exports)
    return exports[name]
