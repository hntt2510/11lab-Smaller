import shutil
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from fastapi.testclient import TestClient

from services.local_engine.app.main import create_app
from services.local_engine.app.services.audio_pipeline import (
    export_srt,
    export_mp3,
    load_audio,
    process_audio,
    quality_check,
    write_audio,
)
from services.local_engine.app.services.project_store import ProjectStore
from services.local_engine.tests.test_provider_contract import FakeProvider


def _write_fixture(path: Path) -> None:
    sample_rate = 1_000
    seconds = np.arange(sample_rate, dtype=np.float32) / sample_rate
    body = (0.5 * np.sin(2 * np.pi * 8 * seconds[200:800])).astype(np.float32)
    audio = np.concatenate(
        (np.zeros(200, dtype=np.float32), body, np.zeros(200, dtype=np.float32))
    )[:, None]
    write_audio(path, audio, sample_rate)


class AudioPipelineTest(unittest.TestCase):
    def test_process_applies_trim_fade_volume_and_silence(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            output = root / "edits" / "processed.wav"
            _write_fixture(source)

            result = process_audio(
                source,
                output,
                trim_start=0.1,
                trim_end=0.9,
                fade_in=0.1,
                fade_out=0.1,
                volume=0.5,
                silence_before=0.05,
                silence_after=0.05,
            )

            self.assertTrue(output.is_file())
            self.assertAlmostEqual(result.metrics.duration_seconds, 0.9, places=2)
            edited, _ = load_audio(output)
            self.assertAlmostEqual(float(edited[0, 0]), 0.0, places=3)
            self.assertAlmostEqual(float(edited[-1, 0]), 0.0, places=3)

    def test_quality_checker_reports_quiet_silent_audio(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "silent.wav"
            write_audio(path, np.zeros((1_000, 1), dtype=np.float32), 1_000)

            result = quality_check(path, expected_duration=0.5)

            self.assertFalse(result["passed"])
            self.assertIn("Loudness is very low", result["warnings"])
            self.assertIn("Silence ratio is 100%", result["warnings"])
            self.assertTrue(any("Duration differs" in warning for warning in result["warnings"]))

    def test_srt_export_respects_pause_and_duration(self):
        subtitles = export_srt(
            [
                {"text": "First line", "duration": 0.75, "pause_after_ms": 250},
                {"text": "Second line", "duration": 1.25, "pause_before_ms": 500},
            ]
        )

        self.assertIn("00:00:00,000 --> 00:00:00,750", subtitles)
        self.assertIn("00:00:01,500 --> 00:00:02,750", subtitles)

    def test_audio_endpoints_write_wav_mp3_quality_and_srt(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            _write_fixture(source)
            store = ProjectStore(root)

            with TestClient(create_app(FakeProvider(), token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}

                presets = client.get("/audio/presets", headers=headers)
                self.assertEqual(presets.status_code, 200)
                self.assertIn("Podcast", presets.json()["presets"])

                wav_voice = client.post(
                    "/voices/upload",
                    files={"file": ("narrator.wav", source.read_bytes(), "audio/wav")},
                    data={
                        "name": "Narrator WAV",
                        "reference_language": "en",
                        "consent_type": "owned_voice",
                        "consent_confirmed": "true",
                    },
                    headers=headers,
                )
                self.assertEqual(wav_voice.status_code, 200)
                wav_profile = wav_voice.json()
                self.assertEqual(Path(wav_profile["local_asset_path"]).suffix, ".wav")
                self.assertIn("reference_analysis", wav_profile["metadata"])

                mp3_source = root / "source.mp3"
                export_mp3(source, mp3_source)
                mp3_voice = client.post(
                    "/voices/upload",
                    files={"file": ("narrator.mp3", mp3_source.read_bytes(), "audio/mpeg")},
                    data={
                        "name": "Narrator MP3",
                        "reference_language": "en",
                        "consent_type": "owned_voice",
                        "consent_confirmed": "true",
                    },
                    headers=headers,
                )
                self.assertEqual(mp3_voice.status_code, 200)
                self.assertEqual(Path(mp3_voice.json()["local_asset_path"]).suffix, ".mp3")

                invalid_voice = client.post(
                    "/voices/upload",
                    files={"file": ("broken.wav", b"not audio", "audio/wav")},
                    data={"name": "Broken", "consent_confirmed": "true"},
                    headers=headers,
                )
                self.assertEqual(invalid_voice.status_code, 422)

                generated = client.post(
                    "/generate",
                    json={"text": "generated"},
                    headers=headers,
                )
                self.assertEqual(generated.status_code, 200)
                generated_path = Path(generated.headers["X-Output-Path"])
                self.assertTrue(generated_path.is_file())
                downloaded = client.get(
                    "/audio/file",
                    params={"path": str(generated_path)},
                    headers=headers,
                )
                self.assertEqual(downloaded.status_code, 200)
                self.assertTrue(downloaded.content.startswith(b"RIFF"))

                processed = client.post(
                    "/audio/process",
                    json={
                        "source_path": str(source),
                        "output_filename": "edits/take.wav",
                        "trim_start": 0.1,
                        "trim_end": 0.9,
                        "preset": "Raw",
                    },
                    headers=headers,
                )
                self.assertEqual(processed.status_code, 200)
                processed_path = Path(processed.json()["output_path"])
                self.assertTrue(processed_path.is_file())

                quality = client.post(
                    "/audio/quality",
                    json={"path": str(processed_path), "expected_duration": 0.8},
                    headers=headers,
                )
                self.assertEqual(quality.status_code, 200)
                self.assertIn("metrics", quality.json())

                subtitles = client.post(
                    "/audio/export/srt",
                    json={
                        "output_filename": "exports/timing.srt",
                        "segments": [{"text": "Hello", "duration": 0.5}],
                    },
                    headers=headers,
                )
                self.assertEqual(subtitles.status_code, 200)
                self.assertTrue(Path(subtitles.json()["output_path"]).is_file())

                traversal = client.post(
                    "/audio/process",
                    json={"source_path": str(source), "output_filename": "../escape.wav"},
                    headers=headers,
                )
                self.assertEqual(traversal.status_code, 422)

                if shutil.which("ffmpeg"):
                    mp3 = client.post(
                        "/audio/process",
                        json={
                            "source_path": str(source),
                            "output_filename": "exports/take.mp3",
                            "output_format": "mp3",
                        },
                        headers=headers,
                    )
                    self.assertEqual(mp3.status_code, 200)
                    self.assertTrue(Path(mp3.json()["output_path"]).is_file())


if __name__ == "__main__":
    unittest.main()
