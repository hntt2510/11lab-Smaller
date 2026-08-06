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
  voice_id?: string | null;
  emotion?: string | null;
  instruct?: string | null;
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
      throw new Error(`Local engine request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  health(): Promise<EngineHealth> {
    return this.request<EngineHealth>("/health");
  }

  parseScript(source: string, defaultVoiceId?: string): Promise<{
    segments: ScriptSegment[];
    suspicious_terms: string[];
  }> {
    return this.request<{ segments: ScriptSegment[]; suspicious_terms: string[] }>("/script/parse", {
      method: "POST",
      body: JSON.stringify({ source, default_voice_id: defaultVoiceId }),
    });
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

  saveProject(projectId: string, payload: {
    name: string;
    source: string;
    segments: ScriptSegment[];
    pronunciation_entries?: Record<string, unknown>[];
  }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  generate(payload: GeneratePayload): Promise<Blob> {
    return fetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Generation failed (${response.status})`);
      }
      return response.blob();
    });
  }
}

export function getLocalEngineClient(): LocalEngineClient | null {
  const bootstrap = window.__OMNIVOICE_ENGINE__;
  const baseUrl = bootstrap?.baseUrl ?? import.meta.env.VITE_LOCAL_ENGINE_URL;
  const token = bootstrap?.token ?? import.meta.env.VITE_LOCAL_ENGINE_TOKEN;
  if (!baseUrl || !token) return null;
  return new LocalEngineClient(baseUrl, token);
}
