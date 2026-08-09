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
});
