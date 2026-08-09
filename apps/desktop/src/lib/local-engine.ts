export type EngineHealth = {
  status: "ok" | "offline";
  provider: string;
  model_loaded: boolean;
  queue_enabled: boolean;
};

export type GeneratePayload = {
  text: string;
  language?: string;
  ref_audio?: string;
  ref_text?: string;
  instruct?: string;
  duration?: number;
  speed?: number;
  options?: Record<string, unknown>;
};

export type ScriptSegment = {
  id: string;
  text: string;
  speaker?: string | null;
  voice_id?: string | null;
  emotion?: string | null;
  direction?: string | null;
  instruct?: string | null;
  provider_instruct?: string | null;
  speed: number;
  duration?: number | null;
  pause_before_ms: number;
  pause_after_ms: number;
  volume: number;
  inference_quality: string;
  guidance: number;
  take_count: number;
  pronunciation_overrides: Record<string, string>;
  selected_take?: string | null;
  render_status: string;
  native_tags: string[];
  warnings: string[];
};

export type StudioPreset = {
  speed?: number;
  volume?: number;
  pause_after_ms?: number;
  take_count?: number;
  instruct?: string;
  provider_instruct?: string | null;
};

export type VoiceProfile = {
  id: string;
  provider: string;
  name: string;
  reference_audio?: string | null;
  reference_transcript?: string | null;
  reference_language?: string | null;
  description: string;
  default_preset: string;
  consent: Record<string, unknown>;
  local_asset_path?: string | null;
  cloud_sync_status: string;
  version_history: Record<string, unknown>[];
  favorite: boolean;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type ReferenceAnalysis = {
  path: string;
  duration_seconds: number;
  sample_rate: number;
  channels: number;
  rms_db: number;
  peak_db: number;
  clipping_ratio: number;
  noise_level: number;
  silence_ratio: number;
  score: number;
  warnings: string[];
  asr_confidence?: number | null;
  language_match?: boolean | null;
};

export type AudioEditOptions = {
  source_path: string;
  output_filename?: string;
  output_format?: "wav" | "mp3";
  trim_start?: number;
  trim_end?: number | null;
  fade_in?: number;
  fade_out?: number;
  volume?: number;
  silence_before?: number;
  silence_after?: number;
  preset?: string;
};

export type AudioProcessResult = {
  output_path: string;
  preset: string;
  metrics: Record<string, number>;
  warnings: string[];
};

export type AudioQualityResult = {
  metrics: Record<string, number>;
  passed: boolean;
  warnings: string[];
};

export type SrtExportResult = {
  output_path: string;
};

export type GeneratedAudio = {
  blob: Blob;
  outputPath: string | null;
};

export type Take = {
  id: string;
  project_id: string;
  segment_id: string;
  output_path: string;
  request_snapshot: Record<string, unknown>;
  created_at: string;
};

export type AudioAssemblySegment = {
  segment_id: string;
  audio_path: string;
  pause_before_ms: number;
  pause_after_ms: number;
};

export type AudioAssemblyResult = {
  output_path: string;
  duration: number;
  segments: Array<{ segment_id: string; start: number; end: number }>;
};

export type GenerationMode = "dialogue" | "single_narrator";

type EngineBootstrap = {
  baseUrl: string;
  token: string;
};

declare global {
  interface Window {
    __OMNIVOICE_ENGINE__?: EngineBootstrap;
  }
}

export class LocalEngineClient {
  constructor(
    private readonly baseUrl = "http://127.0.0.1:8000",
    private readonly token = "",
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(await this.errorFromResponse(response));
    }
    return response.json() as Promise<T>;
  }

  private async errorFromResponse(response: Response): Promise<string> {
    let detail: string | undefined;
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === "string" && body.detail.trim()) detail = body.detail;
    } catch {
      // Preserve a status-only error when the local engine did not return JSON.
    }
    return `Local engine request failed (${response.status})${detail ? `: ${detail}` : ""}`;
  }

  health(): Promise<EngineHealth> {
    return this.request<EngineHealth>("/health");
  }

  parseScript(source: string, mode: GenerationMode, defaultVoiceId?: string): Promise<{
    segments: ScriptSegment[];
    suspicious_terms: string[];
  }> {
    return this.request<{ segments: ScriptSegment[]; suspicious_terms: string[] }>("/script/parse", {
      method: "POST",
      body: JSON.stringify({ source, mode, default_voice_id: defaultVoiceId }),
    });
  }

  getStudioPresets(): Promise<Record<string, StudioPreset>> {
    return this.request<Record<string, StudioPreset>>("/script/presets");
  }

  analyzeReference(path: string, targetLanguage?: string): Promise<ReferenceAnalysis> {
    return this.request<ReferenceAnalysis>("/references/analyze", {
      method: "POST",
      body: JSON.stringify({ path, target_language: targetLanguage }),
    });
  }

  transcribeReference(path: string): Promise<{ text: string }> {
    return this.request<{ text: string }>("/references/transcribe", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  listVoices(): Promise<VoiceProfile[]> {
    return this.request<VoiceProfile[]>("/voices");
  }

  async uploadVoice(file: File, payload: {
    name: string;
    reference_transcript?: string;
    reference_language?: string;
    default_preset?: string;
    consent_type?: string;
    consent_confirmed: boolean;
  }): Promise<VoiceProfile> {
    const form = new FormData();
    form.append("file", file);
    form.append("name", payload.name);
    form.append("reference_transcript", payload.reference_transcript ?? "");
    form.append("reference_language", payload.reference_language ?? "");
    form.append("default_preset", payload.default_preset ?? "Balanced");
    form.append("consent_type", payload.consent_type ?? "owned_voice");
    form.append("consent_confirmed", String(payload.consent_confirmed));

    const response = await fetch(`${this.baseUrl}/voices/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    if (!response.ok) {
      let detail = `Voice upload failed (${response.status})`;
      try {
        const error = await response.json() as { detail?: string };
        if (error.detail) detail = error.detail;
      } catch {
        // Keep the status-based error when the server response is not JSON.
      }
      throw new Error(detail);
    }
    return response.json() as Promise<VoiceProfile>;
  }

  saveProject(projectId: string, payload: {
    name: string;
    source: string;
    segments: ScriptSegment[];
    pronunciation_entries?: Record<string, unknown>[];
    generation_mode: GenerationMode;
    speaker_voice_map: Record<string, string>;
    selected_narrator_voice_id?: string | null;
  }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  createTake(projectId: string, payload: {
    segment_id: string;
    output_path: string;
    request_snapshot: Record<string, unknown>;
  }): Promise<Take> {
    return this.request<Take>(`/projects/${encodeURIComponent(projectId)}/takes`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listTakes(projectId: string): Promise<Take[]> {
    return this.request<Take[]>(`/projects/${encodeURIComponent(projectId)}/takes`);
  }

  async generate(payload: GeneratePayload): Promise<GeneratedAudio> {
    const response = await fetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Generation failed (${response.status})`);
    }
    return {
      blob: await response.blob(),
      outputPath: response.headers.get("X-Output-Path"),
    };
  }

  processAudio(payload: AudioEditOptions): Promise<AudioProcessResult> {
    return this.request<AudioProcessResult>("/audio/process", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  qualityCheck(path: string, expectedDuration?: number): Promise<AudioQualityResult> {
    return this.request<AudioQualityResult>("/audio/quality", {
      method: "POST",
      body: JSON.stringify({ path, expected_duration: expectedDuration }),
    });
  }

  assembleAudio(segments: AudioAssemblySegment[], outputFilename?: string): Promise<AudioAssemblyResult> {
    return this.request<AudioAssemblyResult>("/audio/assemble", {
      method: "POST",
      body: JSON.stringify({ segments, output_filename: outputFilename }),
    });
  }

  exportSrt(segments: ScriptSegment[], outputFilename?: string): Promise<SrtExportResult> {
    return this.request<SrtExportResult>("/audio/export/srt", {
      method: "POST",
      body: JSON.stringify({ segments, output_filename: outputFilename }),
    });
  }

  async fetchFile(path: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/audio/file?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(await this.errorFromResponse(response));
    }
    return response.blob();
  }

  fetchAudio(path: string): Promise<Blob> {
    return this.fetchFile(path);
  }
}

export function getLocalEngineClient(): LocalEngineClient | null {
  const bootstrap = window.__OMNIVOICE_ENGINE__;
  const baseUrl = bootstrap?.baseUrl ?? import.meta.env.VITE_LOCAL_ENGINE_URL;
  const token = bootstrap?.token ?? import.meta.env.VITE_LOCAL_ENGINE_TOKEN;
  if (!baseUrl || !token) return null;
  return new LocalEngineClient(baseUrl, token);
}
