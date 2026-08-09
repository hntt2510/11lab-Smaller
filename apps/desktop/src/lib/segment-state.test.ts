import { describe, expect, it } from "vitest";

import type { ScriptSegment, Take } from "./local-engine";
import { applyStudioPresetToSegment, resolveFullScriptAssembly, resolveSelectedTake, resolveSegmentVoiceId, selectTakeForSegment, updateSegmentById } from "./segment-state";

function segment(id: string): ScriptSegment {
  return {
    id,
    text: "Hello.",
    voice_id: null,
    emotion: null,
    instruct: null,
    speed: 1,
    duration: null,
    pause_before_ms: 0,
    pause_after_ms: 0,
    volume: 1,
    inference_quality: "Balanced",
    guidance: 2,
    take_count: 1,
    pronunciation_overrides: {},
    selected_take: null,
    render_status: "draft",
    native_tags: [],
    warnings: [],
  };
}

function take(id: string, segmentId: string, outputPath: string): Take {
  return { id, project_id: "episode-01", segment_id: segmentId, output_path: outputPath, request_snapshot: {}, created_at: "2026-08-09T00:00:00Z" };
}

describe("canonical Studio segment state", () => {
  it("keeps Inspector edits independent for each selected segment", () => {
    const updated = updateSegmentById(
      updateSegmentById([segment("a"), segment("b")], "a", { speed: 1.37, pause_before_ms: 777 }),
      "b",
      { speed: 0.73, pause_before_ms: 222 },
    );

    expect(updated.find((item) => item.id === "a")).toMatchObject({ speed: 1.37, pause_before_ms: 777 });
    expect(updated.find((item) => item.id === "b")).toMatchObject({ speed: 0.73, pause_before_ms: 222 });
  });

  it("keeps a manual speed override after a Studio preset", () => {
    const preset = applyStudioPresetToSegment(segment("a"), "excited", {
      speed: 1.1,
      pause_after_ms: 120,
      take_count: 2,
    });
    const updated = updateSegmentById([preset], "a", { speed: 1.43 });

    expect(updated[0]).toMatchObject({ emotion: "excited", instruct: null, speed: 1.43, pause_after_ms: 120 });
  });

  it("keeps whisper as the only provider-safe Studio preset instruct", () => {
    const calm = applyStudioPresetToSegment(segment("a"), "calm", { speed: 0.92 });
    const whisper = applyStudioPresetToSegment(segment("b"), "whisper", { instruct: "whisper", speed: 0.83 });

    expect(calm).toMatchObject({ emotion: "calm", instruct: null, speed: 0.92 });
    expect(whisper).toMatchObject({ emotion: "whisper", instruct: "whisper", speed: 0.83 });
  });

  it("resolves dialogue mappings and single narrator voices without fallback", () => {
    const a = { ...segment("a"), speaker: "A" };
    const b = { ...segment("b"), speaker: "B" };

    expect(resolveSegmentVoiceId(a, "dialogue", { A: "voice-adam", B: "voice-bella" }, null)).toBe("voice-adam");
    expect(resolveSegmentVoiceId(b, "dialogue", { A: "voice-adam", B: "voice-bella" }, null)).toBe("voice-bella");
    expect(resolveSegmentVoiceId(a, "single_narrator", {}, "voice-adam")).toBe("voice-adam");
    expect(resolveSegmentVoiceId({ ...a, voice_id: "voice-override" }, "dialogue", { A: "voice-adam" }, null)).toBe("voice-override");
  });

  it("resolves only the selected take belonging to the active segment", () => {
    const takeA = take("take-a", "segment-1", "file-A.wav");
    const takeB = take("take-b", "segment-1", "file-B.wav");
    const segment2Take = take("take-2", "segment-2", "file-2.wav");
    const takes = [takeA, takeB, segment2Take];
    const segments = selectTakeForSegment([segment("segment-1"), segment("segment-2")], "segment-1", takeA.id);

    expect(resolveSelectedTake(segments[0], takes)?.output_path).toBe("file-A.wav");
    expect(resolveSelectedTake(selectTakeForSegment(segments, "segment-1", takeB.id)[0], takes)?.output_path).toBe("file-B.wav");
    expect(resolveSelectedTake(segments[1], takes)).toBeNull();
    expect(resolveSelectedTake({ ...segments[1], selected_take: takeA.id }, takes)).toBeNull();
  });

  it("builds full script inputs from selected takes in script order and reports missing lines", () => {
    const takeA = take("take-a", "segment-1", "file-A.wav");
    const takeB = take("take-b", "segment-2", "file-B.wav");
    const selected = selectTakeForSegment(
      selectTakeForSegment([segment("segment-1"), segment("segment-2"), segment("segment-3")], "segment-1", takeA.id),
      "segment-2",
      takeB.id,
    );
    selected[0].pause_after_ms = 180;
    selected[1].pause_before_ms = 20;

    const assembly = resolveFullScriptAssembly(selected, [takeA, takeB]);

    expect(assembly.sourceTakeIds).toEqual(["take-a", "take-b"]);
    expect(assembly.segments.map((item) => item.audio_path)).toEqual(["file-A.wav", "file-B.wav"]);
    expect(assembly.segments[0]).toMatchObject({ pause_after_ms: 180 });
    expect(assembly.missingSegmentIds).toEqual(["segment-3"]);
  });

  it("changes the full-script source snapshot when a line selects another take", () => {
    const takeA = take("take-a", "segment-1", "file-A.wav");
    const takeB = take("take-b", "segment-1", "file-B.wav");
    const initial = selectTakeForSegment([segment("segment-1")], "segment-1", takeA.id);
    const rebuilt = selectTakeForSegment(initial, "segment-1", takeB.id);

    expect(resolveFullScriptAssembly(initial, [takeA, takeB]).sourceTakeIds).toEqual(["take-a"]);
    expect(resolveFullScriptAssembly(rebuilt, [takeA, takeB]).sourceTakeIds).toEqual(["take-b"]);
    expect(resolveFullScriptAssembly(rebuilt, [takeA, takeB]).segments[0].audio_path).toBe("file-B.wav");
  });
});
