import unittest
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from fastapi.testclient import TestClient

from services.local_engine.app.main import create_app
from services.local_engine.app.audio import encode_wav
from services.local_engine.app.providers.base import (
    TTSProvider,
    TTSRequest,
    TTSResult,
    VoiceProfile,
)
from services.local_engine.app.queue import RenderQueue
from services.local_engine.app.services.project_store import ProjectStore
from services.local_engine.app.services.reference_analyzer import analyze_reference
from services.local_engine.app.services.script_director import parse_script


class FakeProvider(TTSProvider):
    @property
    def name(self):
        return "fake"

    @property
    def is_loaded(self):
        return True

    def load(self):
        pass

    def unload(self):
        pass

    def generate(self, request):
        return TTSResult(
            audio=np.zeros(16, dtype=np.float32),
            sampling_rate=24000,
            provider=self.name,
        )

    def create_voice_profile(self, reference_audio, reference_transcript=None, metadata=None):
        return VoiceProfile(id="voice-test", provider=self.name)

    def get_capabilities(self):
        return {"modes": ["auto"]}

    def get_license_info(self):
        return {"commercial_use": True}


class ProviderContractTest(unittest.TestCase):
    def test_request_rejects_invalid_values(self):
        with self.assertRaises(ValueError):
            TTSRequest(text=" ")
        with self.assertRaises(ValueError):
            TTSRequest(text="hello", speed=0)

    def test_provider_returns_contract_result(self):
        result = FakeProvider().generate(TTSRequest(text="hello"))
        self.assertEqual(result.provider, "fake")
        self.assertEqual(result.sampling_rate, 24000)
        self.assertEqual(result.audio.ndim, 1)

    def test_api_requires_loopback_token(self):
        client = TestClient(create_app(FakeProvider(), token="secret"))

        self.assertEqual(client.get("/health").status_code, 401)
        response = client.get(
            "/health", headers={"Authorization": "Bearer secret"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["provider"], "fake")

    def test_api_allows_desktop_cors_preflight(self):
        client = TestClient(create_app(FakeProvider(), token="secret"))

        response = client.options(
            "/health",
            headers={
                "Origin": "http://127.0.0.1:1420",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["access-control-allow-origin"],
            "http://127.0.0.1:1420",
        )

    def test_request_returns_wav_and_queue_persists_output(self):
        with TemporaryDirectory() as workspace:
            provider = FakeProvider()
            queue = RenderQueue(provider, workspace)
            with TestClient(
                create_app(provider, token="secret", render_queue=queue)
            ) as client:
                headers = {"Authorization": "Bearer secret"}
                response = client.post(
                    "/generate",
                    json={"text": "hello"},
                    headers=headers,
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "audio/wav")
                self.assertTrue(response.content.startswith(b"RIFF"))

                response = client.post(
                    "/queue",
                    json={"text": "queued", "output_filename": "nested/out.wav"},
                    headers=headers,
                )
                self.assertEqual(response.status_code, 200)
                job_id = response.json()["id"]

                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    job = queue.get(job_id)
                    if job and job.status == "completed":
                        break
                    time.sleep(0.01)

                self.assertIsNotNone(job)
                self.assertEqual(job.status, "completed")
                self.assertTrue(Path(job.output_path).is_file())

                with self.assertRaises(ValueError):
                    queue.submit(TTSRequest(text="blocked"), "../outside.wav")

    def test_script_director_maps_studio_and_native_tags(self):
        segments = parse_script(
            "[calm] The first line.\n[pause=500]\n"
            "[excited speed=1.08] The second line!\n[laughter] A reaction.",
            default_voice_id="voice-01",
        )

        self.assertEqual(len(segments), 3)
        self.assertEqual(segments[0].emotion, "calm")
        self.assertEqual(segments[0].speed, 0.92)
        self.assertEqual(segments[1].pause_before_ms, 500)
        self.assertEqual(segments[1].take_count, 2)
        self.assertEqual(segments[1].speed, 1.08)
        self.assertEqual(segments[2].native_tags, ("laughter",))
        self.assertIn("[laughter]", segments[2].text)

    def test_voice_reference_and_project_api_persist(self):
        with TemporaryDirectory() as workspace:
            reference_path = Path(workspace) / "reference.wav"
            waveform = np.sin(np.linspace(0, 20, 24000)).astype(np.float32)
            reference_path.write_bytes(encode_wav(waveform, 24000))
            analysis = analyze_reference(reference_path)
            self.assertEqual(analysis.sample_rate, 24000)
            self.assertGreaterEqual(analysis.score, 0)

            store = ProjectStore(workspace)
            with TestClient(
                create_app(FakeProvider(), token="secret", project_store=store)
            ) as client:
                headers = {"Authorization": "Bearer secret"}
                parse_response = client.post(
                    "/script/parse",
                    json={"source": "[calm] Hello SAP."},
                    headers=headers,
                )
                self.assertEqual(parse_response.status_code, 200)
                self.assertEqual(parse_response.json()["segments"][0]["emotion"], "calm")

                voice_response = client.post(
                    "/voices",
                    json={
                        "name": "Atlas",
                        "reference_audio": str(reference_path),
                        "reference_language": "en",
                        "consent_type": "owned_voice",
                        "consent_confirmed": True,
                    },
                    headers=headers,
                )
                self.assertEqual(voice_response.status_code, 200)
                self.assertEqual(voice_response.json()["name"], "Atlas")

                project_response = client.put(
                    "/projects/episode-01",
                    json={
                        "name": "Night signal",
                        "source": "[calm] Hello SAP.",
                        "segments": parse_response.json()["segments"],
                    },
                    headers=headers,
                )
                self.assertEqual(project_response.status_code, 200)
                loaded = client.get(
                    "/projects/episode-01", headers=headers
                )
                self.assertEqual(loaded.status_code, 200)
                self.assertEqual(loaded.json()["name"], "Night signal")

                pronunciation_response = client.post(
                    "/pronunciation",
                    json={
                        "term": "SAP",
                        "pronunciation": "ess ay pee",
                        "project_id": "episode-01",
                    },
                    headers=headers,
                )
                self.assertEqual(pronunciation_response.status_code, 200)
                preview = client.post(
                    "/pronunciation/preview",
                    json={
                        "text": "SAP is ready",
                        "entries": [pronunciation_response.json()],
                    },
                    headers=headers,
                )
                self.assertEqual(preview.json()["text"], "ess ay pee is ready")


if __name__ == "__main__":
    unittest.main()
