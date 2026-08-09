import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalEngineClient } from "./local-engine";

describe("LocalEngineClient.generate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the persisted output path exposed by the generation response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["wav"]), {
      status: 200,
      headers: { "X-Output-Path": "C:/workspace/generated.wav" },
    })));

    const generated = await new LocalEngineClient("http://127.0.0.1:8000", "token").generate({ text: "Hello" });

    expect(generated.outputPath).toBe("C:/workspace/generated.wav");
  });

  it("submits selected take paths to the full-script assembler", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_path: "C:/workspace/full-script.wav",
      duration: 1.2,
      segments: [{ segment_id: "segment-01", start: 0, end: 1.2 }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new LocalEngineClient("http://127.0.0.1:8000", "token").assembleAudio([
      { segment_id: "segment-01", audio_path: "C:/workspace/take-b.wav", pause_before_ms: 0, pause_after_ms: 120 },
    ]);

    expect(result.output_path).toBe("C:/workspace/full-script.wav");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8000/audio/assemble", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ segments: [{ segment_id: "segment-01", audio_path: "C:/workspace/take-b.wav", pause_before_ms: 0, pause_after_ms: 120 }], output_filename: undefined }),
    }));
  });

  it("includes a backend error detail in failed local-engine requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: "selected take must be an existing workspace WAV file",
    }), { status: 422 })));

    await expect(new LocalEngineClient("http://127.0.0.1:8000", "token").assembleAudio([])).rejects.toThrow(
      "Local engine request failed (422): selected take must be an existing workspace WAV file",
    );
  });

  it("hydrates a typed persisted project document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "episode-01", name: "Night signal", source: "[calm] Hello.", segments: [], pronunciation_entries: [],
      generation_mode: "single_narrator", speaker_voice_map: {}, selected_narrator_voice_id: "voice-1", updated_at: "2026-08-09T00:00:00Z",
    }), { status: 200 })));

    const project = await new LocalEngineClient("http://127.0.0.1:8000", "token").getProject("episode-01");

    expect(project).toMatchObject({ id: "episode-01", generation_mode: "single_narrator", selected_narrator_voice_id: "voice-1" });
  });
});
