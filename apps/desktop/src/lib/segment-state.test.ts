import { describe, expect, it } from "vitest";

import type { ScriptSegment } from "./local-engine";
import { applyStudioPresetToSegment, resolveSegmentVoiceId, updateSegmentById } from "./segment-state";

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
});
