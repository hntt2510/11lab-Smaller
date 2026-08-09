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
from services.local_engine.app.providers.omnivoice_provider import OmniVoiceProvider
from services.local_engine.app.queue import RenderQueue
from services.local_engine.app.services.project_store import ProjectStore
from services.local_engine.app.services.reference_analyzer import analyze_reference
from services.local_engine.app.services.script_director import parse_script


class FakeProvider(TTSProvider):
    def __init__(self):
        self.requests: list[TTSRequest] = []

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
        self.requests.append(request)
        return TTSResult(
            audio=np.zeros(16, dtype=np.float32),
            sampling_rate=24000,
            provider=self.name,
        )

    def create_voice_profile(self, reference_audio, reference_transcript=None, metadata=None):
        return VoiceProfile(
            id=f"voice-{Path(reference_audio or 'empty').stem}",
            provider=self.name,
            reference_audio=reference_audio,
            reference_transcript=reference_transcript,
        )

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
                first_output = Path(response.headers["X-Output-Path"])
                self.assertTrue(first_output.is_file())
                self.assertEqual(first_output.suffix, ".wav")

                second_response = client.post(
                    "/generate",
                    json={"text": "hello again"},
                    headers={**headers, "Origin": "http://127.0.0.1:1420"},
                )
                self.assertEqual(second_response.status_code, 200)
                second_output = Path(second_response.headers["X-Output-Path"])
                self.assertNotEqual(first_output, second_output)
                self.assertTrue(second_output.is_file())
                exposed = second_response.headers["access-control-expose-headers"]
                self.assertIn("X-Output-Path", exposed)
                self.assertIn("X-Provider", exposed)
                self.assertIn("X-Sampling-Rate", exposed)

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

    def test_dialogue_parser_preserves_speakers_and_studio_tags(self):
        segments = parse_script(
            "A: [calm speed=0.90] Keep calm.\nB: Okay.\n"
            "The time was 10:30 that night.",
            dialogue=True,
        )

        self.assertEqual([segment.speaker for segment in segments], ["A", "B", None])
        self.assertEqual(segments[0].text, "Keep calm.")
        self.assertEqual(segments[0].emotion, "calm")
        self.assertIsNone(segments[0].instruct)
        self.assertEqual(segments[0].speed, 0.90)
        self.assertIn("requires a voice assignment", segments[2].warnings[0])

    def test_parser_preserves_speed_instruction_and_pending_pause(self):
        segments = parse_script(
            "[pause=500]\n[excited speed=1.08] Hello [laughter] world.",
        )

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].text, "Hello [laughter] world.")
        self.assertEqual(segments[0].emotion, "excited")
        self.assertIsNone(segments[0].instruct)
        self.assertEqual(segments[0].speed, 1.08)
        self.assertEqual(segments[0].pause_before_ms, 500)
        self.assertEqual(segments[0].native_tags, ("laughter",))

    def test_studio_presets_keep_emotion_without_unsupported_instruct(self):
        expected = {
            "calm": 0.92,
            "excited": 1.08,
            "sad": 0.88,
            "serious": 0.94,
            "emphasis": 1.0,
            "slow": 0.82,
            "fast": 1.12,
        }
        for emotion, speed in expected.items():
            segment = parse_script(f"[{emotion}] Hello.")[0]
            self.assertEqual(segment.emotion, emotion)
            self.assertIsNone(segment.instruct)
            self.assertEqual(segment.speed, speed)

    def test_calm_parser_result_has_no_provider_instruct(self):
        segment = parse_script("[calm speed=0.92] Hello.")[0]

        self.assertEqual(segment.emotion, "calm")
        self.assertIsNone(segment.instruct)
        self.assertEqual(segment.speed, 0.92)

    def test_excited_parser_result_has_no_provider_instruct(self):
        segment = parse_script("[excited speed=1.37] Hello.")[0]

        self.assertEqual(segment.emotion, "excited")
        self.assertIsNone(segment.instruct)
        self.assertEqual(segment.speed, 1.37)

    def test_whisper_preset_remains_a_valid_provider_instruct(self):
        segment = parse_script("[whisper speed=0.83] Hello.")[0]

        self.assertEqual(segment.emotion, "whisper")
        self.assertEqual(segment.instruct, "whisper")
        self.assertEqual(segment.speed, 0.83)

    def test_direction_engine_resolves_emotions_reactions_and_unknown_tags_per_line(self):
        segments = parse_script(
            "A: [calm] Bình tĩnh nào.\n"
            "B: [excited] Ủa! Thiệt luôn hả?\n"
            "A: [whisper] Ê... nhỏ tiếng thôi.\n"
            "B: [laughter] Hahaha, ông nói thật à?\n"
            "A: [terrified] À... ừm... tôi cũng không biết nữa.",
            dialogue=True,
        )

        self.assertEqual([segment.speaker for segment in segments], ["A", "B", "A", "B", "A"])
        self.assertEqual([segment.direction for segment in segments[:3]], ["calm", "excited", "whisper"])
        self.assertEqual([segment.provider_instruct for segment in segments[:3]], [None, None, "whisper"])
        self.assertEqual(segments[1].speed, 1.08)
        self.assertEqual(segments[3].native_tags, ("laughter",))
        self.assertIn("[laughter]", segments[3].text)
        self.assertIn("À... ừm...", segments[4].text)
        self.assertIn("[terrified]", segments[4].text)
        self.assertTrue(any("Unknown studio tags" in warning for warning in segments[4].warnings))

    def test_direction_engine_supports_all_studio_fallbacks_without_provider_instruct(self):
        for direction in ("calm", "excited", "sad", "serious", "happy", "angry", "nervous", "curious", "slow", "fast", "emphasis"):
            segment = parse_script(f"[{direction}] Hello.")[0]
            self.assertEqual(segment.direction, direction)
            self.assertIsNone(segment.provider_instruct)
            if direction == "emphasis":
                self.assertEqual(segment.take_count, 2)
            else:
                self.assertNotEqual(segment.speed, 1.0)

    def test_studio_preset_api_matches_parser_metadata(self):
        client = TestClient(create_app(OmniVoiceProvider(), token="secret"))
        response = client.get(
            "/script/presets", headers={"Authorization": "Bearer secret"}
        )

        self.assertEqual(response.status_code, 200)
        presets = response.json()
        calm = parse_script("[calm] Hello.")[0]
        whisper = parse_script("[whisper] Hello.")[0]
        self.assertEqual(calm.speed, presets["calm"]["speed"])
        self.assertEqual(calm.pause_after_ms, presets["calm"]["pause_after_ms"])
        self.assertIsNone(calm.instruct)
        self.assertEqual(whisper.instruct, presets["whisper"]["instruct"])

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

    def test_generation_uses_the_reference_of_each_selected_voice(self):
        with TemporaryDirectory() as workspace:
            workspace_path = Path(workspace)
            first_reference = workspace_path / "first.wav"
            second_reference = workspace_path / "second.wav"
            waveform = np.sin(np.linspace(0, 20, 24000)).astype(np.float32)
            first_reference.write_bytes(encode_wav(waveform, 24000))
            second_reference.write_bytes(encode_wav(waveform, 24000))

            provider = FakeProvider()
            store = ProjectStore(workspace)
            with TestClient(create_app(provider, token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}
                profiles = []
                for name, reference, transcript in (
                    ("Voice A", first_reference, "First reference transcript"),
                    ("Voice B", second_reference, "Second reference transcript"),
                ):
                    response = client.post(
                        "/voices",
                        json={
                            "name": name,
                            "reference_audio": str(reference),
                            "reference_transcript": transcript,
                            "consent_confirmed": True,
                        },
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 200)
                    profiles.append(response.json())

                for profile in profiles:
                    response = client.post(
                        "/generate",
                        json={
                            "text": "Generate with this voice",
                            "ref_audio": profile["reference_audio"],
                            "ref_text": profile["reference_transcript"],
                        },
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 200)

            self.assertEqual(provider.requests[0].ref_audio, str(first_reference))
            self.assertEqual(provider.requests[0].ref_text, "First reference transcript")
            self.assertEqual(provider.requests[1].ref_audio, str(second_reference))
            self.assertEqual(provider.requests[1].ref_text, "Second reference transcript")

    def test_generation_preserves_safe_segment_controls_and_selected_voice_reference(self):
        with TemporaryDirectory() as workspace:
            workspace_path = Path(workspace)
            first_reference = workspace_path / "voice-a.wav"
            second_reference = workspace_path / "voice-b.wav"
            waveform = np.sin(np.linspace(0, 20, 24000)).astype(np.float32)
            first_reference.write_bytes(encode_wav(waveform, 24000))
            second_reference.write_bytes(encode_wav(waveform, 24000))

            provider = FakeProvider()
            store = ProjectStore(workspace)
            with TestClient(create_app(provider, token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}
                for name, reference in (("Voice A", first_reference), ("Voice B", second_reference)):
                    response = client.post(
                        "/voices",
                        json={
                            "name": name,
                            "reference_audio": str(reference),
                            "consent_confirmed": True,
                        },
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 200)

                for source in (
                    "[calm speed=0.92] Hello world.",
                    "[excited speed=1.25] Hello world.",
                    "[whisper speed=0.91] Hello world.",
                ):
                    segment = parse_script(source)[0]
                    response = client.post(
                        "/generate",
                        json={
                            "text": segment.text,
                            "instruct": segment.instruct,
                            "speed": 1.37 if segment.emotion == "calm" else segment.speed,
                            "ref_audio": str(second_reference),
                            "options": {"guidance_scale": 2.73},
                        },
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 200)

            self.assertEqual([request.instruct for request in provider.requests], [None, None, "whisper"])
            self.assertEqual([request.speed for request in provider.requests], [1.37, 1.25, 0.91])
            self.assertTrue(all(request.options["guidance_scale"] == 2.73 for request in provider.requests))
            self.assertTrue(all(request.ref_audio == str(second_reference) for request in provider.requests))

    def test_omnivoice_provider_rejects_invalid_instruct_before_model_inference(self):
        class CapturingModel:
            sampling_rate = 24000

            def __init__(self):
                self.calls = []

            def generate(self, text, **kwargs):
                self.calls.append((text, kwargs))
                return [np.zeros(16, dtype=np.float32)]

        provider = OmniVoiceProvider()
        model = CapturingModel()
        provider._model = model

        with self.assertRaisesRegex(ValueError, "Unsupported instruct items"):
            provider.generate(TTSRequest(text="Hello", instruct="calm"))
        self.assertEqual(model.calls, [])

        provider.generate(TTSRequest(text="Hello", instruct="whisper"))
        self.assertEqual(model.calls[0][1]["instruct"], "whisper")

    def test_project_save_preserves_parsed_segment_metadata(self):
        with TemporaryDirectory() as workspace:
            store = ProjectStore(workspace)
            with TestClient(create_app(FakeProvider(), token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}
                parsed = client.post(
                    "/script/parse",
                    json={"source": "[pause=777]\n[excited speed=1.37] Hello."},
                    headers=headers,
                )
                self.assertEqual(parsed.status_code, 200)
                segments = parsed.json()["segments"]

                saved = client.put(
                    "/projects/segment-metadata",
                    json={"name": "Segment metadata", "source": "source", "segments": segments},
                    headers=headers,
                )
                self.assertEqual(saved.status_code, 200)
                project = client.get("/projects/segment-metadata", headers=headers)
                self.assertEqual(project.status_code, 200)

            segment = project.json()["segments"][0]
            self.assertEqual(segment["text"], "Hello.")
            self.assertEqual(segment["emotion"], "excited")
            self.assertIsNone(segment["instruct"])
            self.assertEqual(segment["speed"], 1.37)
            self.assertEqual(segment["pause_before_ms"], 777)

    def test_project_save_preserves_inspector_edits(self):
        with TemporaryDirectory() as workspace:
            store = ProjectStore(workspace)
            segment = parse_script("[calm] Hello.")[0].to_dict()
            segment.update(
                speed=1.37,
                guidance=2.73,
                pause_before_ms=777,
                pause_after_ms=333,
                volume=0.88,
            )
            with TestClient(create_app(FakeProvider(), token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}
                response = client.put(
                    "/projects/inspector-edits",
                    json={"name": "Inspector edits", "source": "source", "segments": [segment]},
                    headers=headers,
                )
                self.assertEqual(response.status_code, 200)
                project = client.get("/projects/inspector-edits", headers=headers)
                self.assertEqual(project.status_code, 200)

            saved = project.json()["segments"][0]
            self.assertEqual(saved["speed"], 1.37)
            self.assertEqual(saved["guidance"], 2.73)
            self.assertEqual(saved["pause_before_ms"], 777)
            self.assertEqual(saved["pause_after_ms"], 333)
            self.assertEqual(saved["volume"], 0.88)

    def test_project_persists_generation_mode_mapping_and_appended_takes(self):
        with TemporaryDirectory() as workspace:
            workspace_path = Path(workspace)
            output_path = workspace_path / "generated.wav"
            output_path.write_bytes(encode_wav(np.zeros(16, dtype=np.float32), 24000))
            store = ProjectStore(workspace)
            with TestClient(create_app(FakeProvider(), token="secret", project_store=store)) as client:
                headers = {"Authorization": "Bearer secret"}
                saved = client.put(
                    "/projects/dialogue",
                    json={
                        "name": "Dialogue",
                        "source": "A: One.\nB: Two.",
                        "segments": [
                            {"id": "segment-01", "speaker": "A", "text": "One."},
                            {"id": "segment-02", "speaker": "B", "text": "Two."},
                        ],
                        "generation_mode": "dialogue",
                        "speaker_voice_map": {"A": "voice-adam", "B": "voice-bella"},
                        "selected_narrator_voice_id": "voice-adam",
                    },
                    headers=headers,
                )
                self.assertEqual(saved.status_code, 200)
                first_take = client.post(
                    "/projects/dialogue/takes",
                    json={
                        "segment_id": "segment-01",
                        "output_path": str(output_path),
                        "request_snapshot": {"speed": 1.37, "ref_audio": "adam.wav"},
                    },
                    headers=headers,
                )
                second_take = client.post(
                    "/projects/dialogue/takes",
                    json={
                        "segment_id": "segment-01",
                        "output_path": str(output_path),
                        "request_snapshot": {"speed": 1.43, "ref_audio": "adam.wav"},
                    },
                    headers=headers,
                )
                project = client.get("/projects/dialogue", headers=headers)
                takes = client.get("/projects/dialogue/takes", headers=headers)

            self.assertEqual(first_take.status_code, 200)
            self.assertEqual(second_take.status_code, 200)
            self.assertNotEqual(first_take.json()["id"], second_take.json()["id"])
            self.assertEqual(project.json()["generation_mode"], "dialogue")
            self.assertEqual(project.json()["speaker_voice_map"], {"A": "voice-adam", "B": "voice-bella"})
            self.assertEqual([take["request_snapshot"]["speed"] for take in takes.json()], [1.37, 1.43])


if __name__ == "__main__":
    unittest.main()
