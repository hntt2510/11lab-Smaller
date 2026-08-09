import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import {
  EngineHealth,
  GenerationMode,
  ReferenceAnalysis,
  ScriptSegment,
  StudioPreset,
  Take,
  VoiceProfile,
  getLocalEngineClient,
} from "./lib/local-engine";
import type { AudioEditOptions } from "./lib/local-engine";
import { applyStudioPresetToSegment, type EditableSegmentPatch, resolveSelectedTake, resolveSegmentVoiceId, selectTakeForSegment, updateSegmentById } from "./lib/segment-state";
import { WaveformEditor } from "./components/WaveformEditor";

gsap.registerPlugin(useGSAP);

type ViewKey = "home" | "voices" | "studio" | "batch" | "history";
type RenderStatus = "ready" | "rendering" | "complete";

type NavItem = {
  key: ViewKey;
  label: string;
  short: string;
  count?: string;
};

type VoiceCard = {
  id: string;
  name: string;
  detail: string;
  score: number;
  tone: string;
  tag: string;
};

const navItems: NavItem[] = [
  { key: "home", label: "Overview", short: "O" },
  { key: "voices", label: "Voice lab", short: "V", count: "04" },
  { key: "studio", label: "Script studio", short: "S" },
  { key: "batch", label: "Batch render", short: "B" },
  { key: "history", label: "Render history", short: "H", count: "12" },
];

const initialSegments: ScriptSegment[] = [
  {
    id: "segment-01",
    text: "Tonight, the signal arrives from a place no map can name.",
    voice_id: null,
    emotion: "calm",
    instruct: null,
    speed: 0.92,
    duration: null,
    pause_before_ms: 0,
    pause_after_ms: 280,
    volume: 1,
    inference_quality: "Balanced",
    guidance: 2,
    take_count: 1,
    pronunciation_overrides: {},
    selected_take: null,
    render_status: "draft",
    native_tags: [],
    warnings: [],
  },
  {
    id: "segment-02",
    text: "At first, it sounds like static. Then it starts answering back.",
    voice_id: null,
    emotion: null,
    instruct: null,
    speed: 1,
    duration: null,
    pause_before_ms: 500,
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
  },
  {
    id: "segment-03",
    text: "This is where the quiet side of the story changes everything.",
    voice_id: null,
    emotion: "emphasis",
    instruct: null,
    speed: 1.08,
    duration: null,
    pause_before_ms: 0,
    pause_after_ms: 180,
    volume: 1,
    inference_quality: "Balanced",
    guidance: 2,
    take_count: 2,
    pronunciation_overrides: {},
    selected_take: null,
    render_status: "draft",
    native_tags: [],
    warnings: [],
  },
];

const scriptSource = "[calm] Tonight, the signal arrives from a place no map can name.\n[pause=500]\n[curious] At first, it sounds like static. Then it starts answering back.\n[excited speed=1.08] This is where the quiet side of the story changes everything.";

function voiceToCard(profile: VoiceProfile): VoiceCard {
  return {
    id: profile.id,
    name: profile.name,
    detail: `${profile.default_preset} / ${profile.reference_language ?? "language agnostic"}`,
    score: Number((profile.metadata.reference_analysis as { score?: number } | undefined)?.score ?? 0),
    tone: profile.favorite ? "orange" : "blue",
    tag: profile.cloud_sync_status === "local" ? "LOCAL ONLY" : "SYNCED",
  };
}

const viewMeta: Record<ViewKey, { eyebrow: string; title: string; detail: string }> = {
  home: {
    eyebrow: "WORKSPACE / OVERVIEW",
    title: "Make the voice feel inevitable.",
    detail: "A local-first studio for shaping narration one intentional line at a time.",
  },
  voices: {
    eyebrow: "VOICE LAB / LIBRARY",
    title: "Voices with a point of view.",
    detail: "Keep references, transcripts, and performance presets close to the work.",
  },
  studio: {
    eyebrow: "SCRIPT STUDIO / EPISODE 01",
    title: "A signal from the quiet side.",
    detail: "Direct each line, audition the take, and keep the pacing in your hands.",
  },
  batch: {
    eyebrow: "BATCH RENDER / QUEUE",
    title: "Many lines. One steady rhythm.",
    detail: "Queue scenes for local rendering without losing the shape of the project.",
  },
  history: {
    eyebrow: "RENDER HISTORY / LOCAL",
    title: "Nothing good gets lost.",
    detail: "Find every take, output, and revision from this workspace.",
  },
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatSegmentDuration(duration: number | null | undefined) {
  return duration ? `${duration.toFixed(1)}s` : "--";
}

function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [activeView, setActiveView] = useState<ViewKey>("studio");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>("segment-02");
  const [scriptSegments, setScriptSegments] = useState<ScriptSegment[]>(initialSegments);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("single_narrator");
  const [speakerVoiceMap, setSpeakerVoiceMap] = useState<Record<string, string>>({});
  const [selectedNarratorVoiceId, setSelectedNarratorVoiceId] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [generateAllProgress, setGenerateAllProgress] = useState<{ current: number; total: number } | null>(null);
  const [sourceDraft, setSourceDraft] = useState(scriptSource);
  const [renderStatus, setRenderStatus] = useState<RenderStatus>("ready");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewAudioPath, setPreviewAudioPath] = useState<string | null>(null);
  const [previewedSegmentId, setPreviewedSegmentId] = useState<string | null>(null);
  const [previewedTakeId, setPreviewedTakeId] = useState<string | null>(null);
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [studioPresets, setStudioPresets] = useState<Record<string, StudioPreset> | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [engineHealth, setEngineHealth] = useState<EngineHealth>({
    status: "offline",
    provider: "omnivoice",
    model_loaded: false,
    queue_enabled: false,
  });
  const engineOnline = engineHealth.status === "ok";

  const { contextSafe } = useGSAP(
    () => {
      const motion = gsap.matchMedia();
      motion.add(
        {
          reduceMotion: "(prefers-reduced-motion: reduce)",
          fullMotion: "(prefers-reduced-motion: no-preference)",
        },
        (context) => {
          const reduceMotion = Boolean(context.conditions?.reduceMotion);
          const timeline = gsap.timeline({
            defaults: {
              duration: reduceMotion ? 0 : 0.55,
              ease: "power3.out",
            },
          });
          timeline
            .from(".sidebar", { x: -24, autoAlpha: 0 })
            .from(".topbar", { y: -12, autoAlpha: 0 }, "<0.12")
            .from(".view-frame", { y: 18, autoAlpha: 0 }, "<0.08")
            .from(".reveal-card", { y: 14, autoAlpha: 0, stagger: 0.06 }, "<0.14");
        },
      );
      return () => motion.revert();
    },
    { scope: shellRef },
  );

  useEffect(() => {
    if (renderStatus !== "rendering") return;
    const timer = window.setTimeout(() => setRenderStatus("complete"), 1500);
    return () => window.clearTimeout(timer);
  }, [renderStatus]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    return () => {
      if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
    };
  }, [previewAudioUrl]);

  useEffect(() => {
    const client = getLocalEngineClient();
    if (!client) return;

    let mounted = true;
    client
      .health()
      .then((health) => mounted && setEngineHealth(health))
      .catch(() => {
        if (mounted) setEngineHealth((current) => ({ ...current, status: "offline" }));
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const client = getLocalEngineClient();
    if (!client) return;
    client.getStudioPresets().then(setStudioPresets).catch(() => undefined);
  }, []);

  useEffect(() => {
    const client = getLocalEngineClient();
    if (!client) return;
    client.listVoices().then(setVoiceProfiles).catch(() => undefined);
  }, []);

  const selectedSegment = selectedSegmentId
    ? scriptSegments.find((segment) => segment.id === selectedSegmentId) ?? null
    : null;
  const effectiveVoiceId = selectedSegment ? resolveSegmentVoiceId(selectedSegment, generationMode, speakerVoiceMap, selectedNarratorVoiceId) : null;
  const selectedVoice = effectiveVoiceId
    ? voiceProfiles.find((profile) => profile.id === effectiveVoiceId) ?? null
    : null;
  const selectedTake = resolveSelectedTake(selectedSegment, takes);
  const isSelectedTakePreviewed = Boolean(selectedTake)
    && previewedSegmentId === selectedSegmentId
    && previewedTakeId === selectedTake.id;
  const selectedPreviewAudioUrl = isSelectedTakePreviewed ? previewAudioUrl : null;
  const selectedPreviewAudioPath = isSelectedTakePreviewed ? previewAudioPath : null;

  useEffect(() => {
    const client = getLocalEngineClient();
    if (!selectedSegment || !selectedTake || !client) {
      setPreviewedSegmentId(selectedSegmentId);
      setPreviewedTakeId(null);
      setPreviewAudioPath(null);
      setPreviewAudioUrl(null);
      return;
    }
    if (previewedSegmentId === selectedSegment.id && previewedTakeId === selectedTake.id) return;

    let cancelled = false;
    setPreviewedSegmentId(selectedSegment.id);
    setPreviewedTakeId(selectedTake.id);
    setPreviewAudioPath(null);
    setPreviewAudioUrl(null);
    client.fetchAudio(selectedTake.output_path)
      .then((blob) => {
        if (cancelled) return;
        setPreviewAudioPath(selectedTake.output_path);
        setPreviewAudioUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!cancelled) setToast("Selected take audio is unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSegmentId, selectedSegment?.id, selectedTake?.id, selectedTake?.output_path]);

  const dialogueSpeakers = Array.from(new Set(
    scriptSegments.flatMap((segment) => segment.speaker ? [segment.speaker] : []),
  ));
  const selectVoice = (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    setSelectedNarratorVoiceId(voiceId);
  };

  const updateSelectedSegment = contextSafe((patch: Partial<Pick<ScriptSegment, "speed" | "duration" | "guidance" | "pause_before_ms" | "pause_after_ms" | "volume">>) => {
    if (!selectedSegmentId) return;
    setScriptSegments((current) => updateSegmentById(current, selectedSegmentId, patch));
  });

  const selectTake = contextSafe((take: Take) => {
    if (take.segment_id !== selectedSegmentId) return;
    setScriptSegments((current) => selectTakeForSegment(current, take.segment_id, take.id));
  });

  const applyStudioPreset = contextSafe((emotion: string) => {
    const preset = studioPresets?.[emotion];
    if (!selectedSegmentId || !preset) {
      setToast("Studio presets are unavailable");
      return;
    }
    setScriptSegments((current) => current.map((segment) => (
      segment.id === selectedSegmentId
        ? applyStudioPresetToSegment(segment, emotion, preset)
        : segment
    )));
  });

  const chooseView = contextSafe((view: ViewKey) => {
    if (view === activeView) return;
    setActiveView(view);
    gsap.fromTo(
      ".view-frame",
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.34, ease: "power2.out", overwrite: true },
    );
  });

  const parseDraft = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client) {
      setToast("Connect the local engine to parse Script Studio tags");
      return;
    }
    try {
      const parsed = await client.parseScript(sourceDraft, generationMode);
      setScriptSegments(parsed.segments);
      setSelectedSegmentId(parsed.segments[0]?.id ?? null);
      setSpeakerVoiceMap((current) => Object.fromEntries(
        Array.from(new Set(parsed.segments.flatMap((segment) => segment.speaker ? [segment.speaker] : [])))
          .flatMap((speaker) => current[speaker] ? [[speaker, current[speaker]]] : []),
      ));
      setToast(`Parsed ${parsed.segments.length} directed lines`);
    } catch {
      setToast("Script parser is unavailable");
    }
  });

  const saveProject = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client) {
      setToast("Project saved locally in this preview");
      return;
    }
    try {
      await client.saveProject("episode-01", {
        name: "Night signal",
        source: sourceDraft,
        segments: scriptSegments,
        generation_mode: generationMode,
        speaker_voice_map: speakerVoiceMap,
        selected_narrator_voice_id: selectedNarratorVoiceId,
      });
      setToast("Project autosaved to the local workspace");
    } catch {
      setToast("Autosave is unavailable; keeping the local draft");
    }
  });

  const generateSegment = async (segment: ScriptSegment, profiles: VoiceProfile[]) => {
    const client = getLocalEngineClient();
    if (!client) throw new Error("Local engine is unavailable");
    const voiceId = resolveSegmentVoiceId(segment, generationMode, speakerVoiceMap, selectedNarratorVoiceId);
    const voice = voiceId ? profiles.find((profile) => profile.id === voiceId) : undefined;
    if (!voice?.reference_audio) throw new Error("No usable voice is assigned");
    const requestSnapshot = {
      text: segment.text, voice_id: voice.id, ref_audio: voice.reference_audio,
      ref_text: voice.reference_transcript ?? null, instruct: segment.instruct,
      duration: segment.duration, speed: segment.speed,
      options: { num_step: 32, guidance_scale: segment.guidance, postprocess_output: true },
    };
    const generated = await client.generate({
      text: segment.text,
      ref_audio: voice.reference_audio,
      ref_text: voice.reference_transcript ?? undefined,
      instruct: segment.instruct ?? undefined,
      duration: segment.duration ?? undefined,
      speed: segment.speed,
      options: requestSnapshot.options,
    });
    if (!generated.outputPath) throw new Error("Generation succeeded, but the local engine did not expose the persisted output path.");
    const take = await client.createTake("episode-01", {
      segment_id: segment.id,
      output_path: generated.outputPath,
      request_snapshot: requestSnapshot,
    });
    setTakes((current) => [...current, take]);
    setScriptSegments((current) => current.map((item) => item.id === segment.id
      ? { ...item, selected_take: take.id, render_status: "complete" }
      : item));
    return { take, voice };
  };

  const generateTake = contextSafe(async () => {
    if (!selectedSegment || generateAllProgress) return;
    const client = getLocalEngineClient();
    if (!client) {
      setToast("Connect the local engine before generating a take");
      return;
    }
    const profiles = await client.listVoices();
    setVoiceProfiles(profiles);
    setRenderStatus("rendering");
    try {
      const result = await generateSegment(selectedSegment, profiles);
      setRenderStatus("complete");
      setToast(`Take created using ${result.voice.name}`);
    } catch (error) {
      setRenderStatus("ready");
      setScriptSegments((current) => current.map((item) => item.id === selectedSegment.id
        ? { ...item, render_status: "failed", warnings: [...item.warnings, error instanceof Error ? error.message : "Generation failed"] }
        : item));
      setToast(error instanceof Error ? error.message : "Take generation failed");
    }
  });

  const generateAll = contextSafe(async () => {
    if (generateAllProgress || scriptSegments.length === 0) return;
    const client = getLocalEngineClient();
    if (!client) {
      setToast("Connect the local engine before generating all lines");
      return;
    }
    const profiles = await client.listVoices();
    setVoiceProfiles(profiles);
    let completed = 0;
    let failed = 0;
    setGenerateAllProgress({ current: 0, total: scriptSegments.length });
    for (let index = 0; index < scriptSegments.length; index += 1) {
      const segment = scriptSegments[index];
      setGenerateAllProgress({ current: index + 1, total: scriptSegments.length });
      setScriptSegments((current) => current.map((item) => item.id === segment.id ? { ...item, render_status: "rendering" } : item));
      try {
        await generateSegment(segment, profiles);
        completed += 1;
      } catch (error) {
        failed += 1;
        setScriptSegments((current) => current.map((item) => item.id === segment.id
          ? { ...item, render_status: "failed", warnings: [...item.warnings, error instanceof Error ? error.message : "Generation failed"] }
          : item));
      }
    }
    setGenerateAllProgress(null);
    setToast(failed ? `${completed} generated, ${failed} failed` : `${completed} lines generated`);
  });

  const processAudioEdit = contextSafe(async (options: Omit<AudioEditOptions, "source_path">) => {
    const client = getLocalEngineClient();
    if (!client || !selectedPreviewAudioPath) {
      setToast("Generate a local take before applying waveform edits");
      return;
    }
    try {
      const result = await client.processAudio({ ...options, source_path: selectedPreviewAudioPath, output_format: "wav" });
      const blob = await client.fetchAudio(result.output_path);
      setPreviewAudioPath(result.output_path);
      setPreviewAudioUrl(URL.createObjectURL(blob));
      setToast(result.warnings.length ? result.warnings[0] : "Waveform edit applied");
    } catch {
      setToast("Audio edit failed; keeping the current take");
    }
  });

  const runQualityCheck = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !selectedPreviewAudioPath) {
      setToast("Generate a local take before running quality check");
      return;
    }
    try {
      const result = await client.qualityCheck(selectedPreviewAudioPath);
      setToast(result.passed ? "Quality check passed" : result.warnings.join(" / "));
    } catch {
      setToast("Quality checker is unavailable");
    }
  });

  const exportMp3 = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !selectedPreviewAudioPath) {
      setToast("Generate a local take before exporting MP3");
      return;
    }
    try {
      const result = await client.processAudio({ source_path: selectedPreviewAudioPath, output_format: "mp3", preset: "Raw" });
      downloadBlob(await client.fetchAudio(result.output_path), "episode-01.mp3");
      setToast("MP3 export downloaded");
    } catch {
      setToast("MP3 export failed; check that FFmpeg is installed");
    }
  });

  const exportWav = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !selectedPreviewAudioPath) {
      setToast("Generate a local take before exporting WAV");
      return;
    }
    try {
      downloadBlob(await client.fetchAudio(selectedPreviewAudioPath), "episode-01.wav");
      setToast("WAV export downloaded");
    } catch {
      setToast("WAV export failed");
    }
  });

  const exportSrt = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client) {
      setToast("Connect the local engine to export subtitles");
      return;
    }
    try {
      const result = await client.exportSrt(scriptSegments, "episode-01.srt");
      downloadBlob(await client.fetchFile(result.output_path), "episode-01.srt");
      setToast("SRT export downloaded");
    } catch {
      setToast("SRT export failed");
    }
  });

  const meta = viewMeta[activeView];

  return (
    <div className="app-shell" ref={shellRef}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">OMNI<span>VOICE</span></div>
            <div className="brand-caption">STUDIO / LOCAL FIRST</div>
          </div>
        </div>

        <div className="workspace-switcher">
          <span className="tiny-label">WORKSPACE</span>
          <strong>Night signal</strong>
          <span className="switcher-dot" />
        </div>

        <nav className="main-nav" aria-label="Primary navigation">
          <span className="nav-heading">Navigate</span>
          {navItems.map((item) => (
            <button
              className={`nav-item ${activeView === item.key ? "active" : ""}`}
              key={item.key}
              onClick={() => chooseView(item.key)}
              type="button"
            >
              <span className="nav-mark">{item.short}</span>
              <span className="nav-label">{item.label}</span>
              {item.count && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="engine-card" onClick={() => setShowDiagnostics(true)} type="button">
            <span className={`engine-led ${engineOnline ? "" : "offline"}`} />
            <span className="engine-copy">
              <span className="tiny-label">LOCAL ENGINE</span>
              <strong>{engineOnline ? "GPU ready" : "Connect to run"}</strong>
            </span>
            <span className="engine-arrow">-&gt;</span>
          </button>
          <div className="sidebar-footer-line">
            <span>OMNIVOICE 0.2</span>
            <span>WIN / NVIDIA</span>
          </div>
        </div>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div className="breadcrumb">
            <span>PROJECTS</span>
            <b>/</b>
            <strong>EPISODE 01</strong>
          </div>
          <div className="topbar-actions">
            <button className="quiet-button" onClick={() => setShowDiagnostics(true)} type="button">
              <span className={`status-dot ${engineOnline ? "" : "offline"}`} />
              {engineOnline ? "System nominal" : "Engine not connected"}
            </button>
            <button className="avatar-button" type="button" aria-label="Open account menu">HN</button>
          </div>
        </header>

        <div className="view-frame">
          <section className="hero-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" />{meta.eyebrow}</div>
              <h1>{meta.title}</h1>
              <p className="hero-detail">{meta.detail}</p>
            </div>
            <div className="hero-actions">
              <button className="outline-button" type="button" onClick={saveProject}>Save project</button>
              <button className="primary-button" type="button" onClick={generateAll} disabled={Boolean(generateAllProgress)}>
                <span className="button-spark">+</span>
                {generateAllProgress ? `Generating ${generateAllProgress.current} / ${generateAllProgress.total}` : "Generate all"}
              </button>
            </div>
          </section>

          {activeView === "studio" ? (
            <StudioView
              onSelect={setSelectedSegmentId}
              selectedSegmentId={selectedSegmentId}
              renderStatus={renderStatus}
              onGenerate={generateTake}
              audioUrl={selectedPreviewAudioUrl}
              onProcessEdit={processAudioEdit}
              onQualityCheck={runQualityCheck}
              onExportWav={exportWav}
              onExportMp3={exportMp3}
              onExportSrt={exportSrt}
              onReplaceTake={generateTake}
              segments={scriptSegments}
              generationMode={generationMode}
              speakerVoiceMap={speakerVoiceMap}
              selectedNarratorVoiceId={selectedNarratorVoiceId}
              voices={voiceProfiles}
              isGeneratingAll={Boolean(generateAllProgress)}
              onModeChange={(mode) => { setGenerationMode(mode); setToast("Mode changed. Parse the source to apply it."); }}
              onSpeakerVoiceChange={(speaker, voiceId) => setSpeakerVoiceMap((current) => ({ ...current, [speaker]: voiceId }))}
              onNarratorVoiceChange={selectVoice}
              onGenerateAll={generateAll}
              sourceDraft={sourceDraft}
              onSourceChange={setSourceDraft}
              onParse={parseDraft}
            />
          ) : (
            <OverviewView
              view={activeView}
              onOpenStudio={() => chooseView("studio")}
              voiceProfiles={voiceProfiles}
              selectedVoiceId={selectedVoiceId}
              onSelectVoice={selectVoice}
              onVoiceCreated={(profile) => {
                setVoiceProfiles((current) => [profile, ...current.filter((voice) => voice.id !== profile.id)]);
                selectVoice(profile.id);
              }}
            />
          )}
        </div>
      </main>

      <aside className="inspector-column">
        <div className="inspector-head">
          <div>
            <span className="tiny-label">INSPECTOR</span>
            <h2>{activeView === "studio" ? "Line direction" : "Workspace pulse"}</h2>
          </div>
        </div>
        {activeView === "studio" ? (
          <StudioInspector renderStatus={renderStatus} onGenerate={generateTake} selectedSegment={selectedSegment} selectedVoice={selectedVoice} selectedVoiceId={effectiveVoiceId} presets={studioPresets} takes={takes} onSelectTake={selectTake} onUpdateSegment={updateSelectedSegment} onApplyPreset={applyStudioPreset} />
        ) : (
          <DiagnosticsMini onOpen={() => setShowDiagnostics(true)} />
        )}
      </aside>

      {showDiagnostics && <DiagnosticsModal onClose={() => setShowDiagnostics(false)} />}
      {toast && <div className="toast"><span className="toast-mark">OK</span>{toast}</div>}
    </div>
  );
}

function StudioView({
  onSelect,
  selectedSegmentId,
  renderStatus,
  onGenerate,
  audioUrl,
  onProcessEdit,
  onQualityCheck,
  onExportWav,
  onExportMp3,
  onExportSrt,
  onReplaceTake,
  segments,
  generationMode,
  speakerVoiceMap,
  selectedNarratorVoiceId,
  voices,
  isGeneratingAll,
  onModeChange,
  onSpeakerVoiceChange,
  onNarratorVoiceChange,
  onGenerateAll,
  sourceDraft,
  onSourceChange,
  onParse,
}: {
  onSelect: (id: string) => void;
  selectedSegmentId: string | null;
  renderStatus: RenderStatus;
  onGenerate: () => void;
  audioUrl: string | null;
  onProcessEdit: (options: Omit<AudioEditOptions, "source_path">) => void;
  onQualityCheck: () => void;
  onExportWav: () => void;
  onExportMp3: () => void;
  onExportSrt: () => void;
  onReplaceTake: () => void;
  segments: ScriptSegment[];
  generationMode: GenerationMode;
  speakerVoiceMap: Record<string, string>;
  selectedNarratorVoiceId: string | null;
  voices: VoiceProfile[];
  isGeneratingAll: boolean;
  onModeChange: (mode: GenerationMode) => void;
  onSpeakerVoiceChange: (speaker: string, voiceId: string) => void;
  onNarratorVoiceChange: (voiceId: string) => void;
  onGenerateAll: () => void;
  sourceDraft: string;
  onSourceChange: (source: string) => void;
  onParse: () => void;
}) {
  return (
    <div className="studio-grid">
      <section className="script-board reveal-card">
        <div className="board-toolbar">
          <div className="board-context"><span className="scene-index">01</span><span>OPENING / 00:00 - 00:28</span></div>
          <div className="board-tools"><button type="button">Split</button><button type="button" onClick={onParse}>Parse</button><button className="more-button" type="button">...</button></div>
        </div>
        <details className="source-drawer">
          <summary>Source tags / {sourceDraft.split("\n").filter(Boolean).length} lines</summary>
          <textarea value={sourceDraft} onChange={(event) => onSourceChange(event.target.value)} aria-label="Script source tags" />
          <button type="button" onClick={onParse}>Parse into segments -&gt;</button>
        </details>
        <GenerationModePanel
          mode={generationMode}
          segments={segments}
          speakerVoiceMap={speakerVoiceMap}
          selectedNarratorVoiceId={selectedNarratorVoiceId}
          voices={voices}
          isGenerating={isGeneratingAll}
          onModeChange={onModeChange}
          onSpeakerVoiceChange={onSpeakerVoiceChange}
          onNarratorVoiceChange={onNarratorVoiceChange}
          onGenerateAll={onGenerateAll}
        />
        <div className="script-list">
          {segments.map((segment) => (
            <button
              className={`script-line ${selectedSegmentId === segment.id ? "selected" : ""}`}
              key={segment.id}
              onClick={() => onSelect(segment.id)}
              type="button"
            >
              <span className="line-number">{segment.id.replace("segment-", "")}</span>
              <span className="line-copy">
                {segment.emotion && <span className={`tag-pill tag-${segment.emotion}`}>[{segment.emotion}]</span>}
                <span className="line-text">{segment.text}</span>
                {segment.warnings.length > 0 && <span className="tag-pill" title={segment.warnings.join(" / ")}>!</span>}
              </span>
              <span className="line-duration">{formatSegmentDuration(segment.duration)}</span>
              <span className="line-grip">::</span>
            </button>
          ))}
        </div>
        <button className="add-line" type="button"><span>+</span> Add a line</button>
        <div className="board-note"><span className="note-pin" />Reference voice is strongest when the line stays under 10 seconds.</div>
      </section>

      <section className="transport-panel reveal-card">
        <div className="transport-topline">
          <div><span className="tiny-label">TIMELINE</span><strong>Take B / Natural</strong></div>
          <span className={`render-state ${renderStatus}`}><i />{renderStatus === "rendering" ? "Rendering" : renderStatus === "complete" ? "Ready to review" : "Draft"}</span>
        </div>
        <WaveformEditor
          audioUrl={audioUrl}
          onProcess={onProcessEdit}
          onQualityCheck={onQualityCheck}
          onExportWav={onExportWav}
          onExportMp3={onExportMp3}
          onReplaceTake={onReplaceTake}
        />
        <div className="transport-bottom">
          <div className="take-strip"><span className="active-take">A</span><span>B</span><span>C</span><span className="take-label">3 takes</span></div>
          <div className="transport-export-actions">
            <button className="export-button" type="button" onClick={onGenerate}>Render WAV <span>-&gt;</span></button>
            <button className="export-button" type="button" onClick={onExportSrt}>Export SRT <span>-&gt;</span></button>
          </div>
        </div>
        <div className="render-meter" />
      </section>
    </div>
  );
}

function GenerationModePanel({ mode, segments, speakerVoiceMap, selectedNarratorVoiceId, voices, isGenerating, onModeChange, onSpeakerVoiceChange, onNarratorVoiceChange, onGenerateAll }: { mode: GenerationMode; segments: ScriptSegment[]; speakerVoiceMap: Record<string, string>; selectedNarratorVoiceId: string | null; voices: VoiceProfile[]; isGenerating: boolean; onModeChange: (mode: GenerationMode) => void; onSpeakerVoiceChange: (speaker: string, voiceId: string) => void; onNarratorVoiceChange: (voiceId: string) => void; onGenerateAll: () => void }) {
  const speakers = Array.from(new Set(segments.flatMap((segment) => segment.speaker ? [segment.speaker] : [])));
  return <section className="generation-mode-panel">
    <div className="mode-buttons"><button className={mode === "dialogue" ? "active" : ""} disabled={isGenerating} onClick={() => onModeChange("dialogue")} type="button">Dialogue</button><button className={mode === "single_narrator" ? "active" : ""} disabled={isGenerating} onClick={() => onModeChange("single_narrator")} type="button">Single Narrator</button></div>
    {mode === "dialogue" ? <div className="speaker-mapping">{speakers.length ? speakers.map((speaker) => <label key={speaker}>{speaker}<select disabled={isGenerating} value={speakerVoiceMap[speaker] ?? ""} onChange={(event) => onSpeakerVoiceChange(speaker, event.target.value)}><option value="">Assign voice</option>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>) : <span>Parse dialogue to detect speakers.</span>}</div> : <label className="narrator-mapping">Narrator<select disabled={isGenerating} value={selectedNarratorVoiceId ?? ""} onChange={(event) => onNarratorVoiceChange(event.target.value)}><option value="">Select voice</option>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>}
    <button className="primary-button generate-all-button" disabled={isGenerating || segments.length === 0} onClick={onGenerateAll} type="button">{isGenerating ? "Generating all..." : `Generate all (${segments.length})`}</button>
  </section>;
}

function StudioInspector({ renderStatus, onGenerate, selectedSegment, selectedVoice, selectedVoiceId, presets, takes, onSelectTake, onUpdateSegment, onApplyPreset }: { renderStatus: RenderStatus; onGenerate: () => void; selectedSegment: ScriptSegment | null; selectedVoice: VoiceProfile | null; selectedVoiceId: string | null; presets: Record<string, StudioPreset> | null; takes: Take[]; onSelectTake: (take: Take) => void; onUpdateSegment: (patch: EditableSegmentPatch) => void; onApplyPreset: (emotion: string) => void }) {
  const voiceLabel = selectedVoice
    ? `${selectedVoice.name} / ${selectedVoice.default_preset}`
    : selectedVoiceId
      ? "Voice profile unavailable"
      : "No voice selected";
  const emotion = selectedSegment?.emotion ?? "No direction";
  const segmentTakes = takes.filter((take) => take.segment_id === selectedSegment?.id);
  return (
    <div className="inspector-scroll">
      <div className="selection-label"><span className="selection-number">{selectedSegment?.id.replace("segment-", "") ?? "--"}</span><div><span className="tiny-label">SELECTED LINE</span><strong>{emotion} / {formatSegmentDuration(selectedSegment?.duration)}</strong></div></div>
      <div className="voice-select"><div className="voice-avatar">{selectedVoice?.name.slice(0, 2).toUpperCase() ?? "--"}</div><div><span className="tiny-label">VOICE PROFILE</span><strong>{voiceLabel}</strong></div><span className="select-chevron">v</span></div>
      <div className="inspector-section"><div className="section-heading"><span>Direction</span><span className="unit-label">STUDIO PRESET</span></div><div className="emotion-grid">{presets ? Object.keys(presets).map((preset, index) => <button className={`emotion ${emotion === preset ? "active" : ""}`} key={preset} onClick={() => onApplyPreset(preset)} type="button" disabled={!selectedSegment}><span>{String(index + 1).padStart(2, "0")}</span>{preset}</button>) : <span className="unit-label">Presets unavailable</span>}</div><small>{selectedSegment?.instruct ? `Provider instruct: ${selectedSegment.instruct}` : "Studio direction only; no provider instruct"}</small></div>
      <div className="inspector-section sliders"><div className="section-heading"><span>Performance</span><span className="unit-label">{selectedSegment?.inference_quality ?? "Balanced"}</span></div><NumericField disabled={!selectedSegment} label="Speed" value={selectedSegment?.speed ?? null} min={0.01} step={0.01} onChange={(speed) => onUpdateSegment({ speed: speed as number })} /><NumericField disabled={!selectedSegment} label="Duration" value={selectedSegment?.duration ?? null} min={0.01} step={0.1} nullable onChange={(duration) => onUpdateSegment({ duration })} /><NumericField disabled={!selectedSegment} label="Guidance" value={selectedSegment?.guidance ?? null} min={0} step={0.01} onChange={(guidance) => onUpdateSegment({ guidance: guidance as number })} /><NumericField disabled={!selectedSegment} label="Pause before" value={selectedSegment?.pause_before_ms ?? null} min={0} step={1} integer onChange={(pause_before_ms) => onUpdateSegment({ pause_before_ms: pause_before_ms as number })} /><NumericField disabled={!selectedSegment} label="Pause after" value={selectedSegment?.pause_after_ms ?? null} min={0} step={1} integer onChange={(pause_after_ms) => onUpdateSegment({ pause_after_ms: pause_after_ms as number })} /><NumericField disabled={!selectedSegment} label="Volume" value={selectedSegment?.volume ?? null} min={0} step={0.01} onChange={(volume) => onUpdateSegment({ volume: volume as number })} /></div>
      <div className="instruct-note"><span className="note-symbol">i</span><p>{selectedSegment?.warnings.length ? selectedSegment.warnings.join(" / ") : "Studio tags are best-effort direction. The reference voice still leads the performance."}</p></div>
      <button className={`inspector-generate ${renderStatus === "rendering" ? "busy" : ""}`} onClick={onGenerate} type="button"><span>{renderStatus === "rendering" ? "Rendering take..." : "Generate new take"}</span><span>-&gt;</span></button>
      <div className="take-list"><div className="section-heading"><span>Takes for this line</span><span className="unit-label">{segmentTakes.length}</span></div>{segmentTakes.length ? segmentTakes.map((take, index) => <button className="take-row" key={take.id} onClick={() => onSelectTake(take)} type="button"><span className={`take-badge ${selectedSegment?.selected_take === take.id ? "selected" : ""}`}>{index + 1}</span><span><strong>Take {index + 1}</strong><small>{take.output_path}</small></span></button>) : <p>No takes for this line yet.</p>}</div>
    </div>
  );
}

function NumericField({ disabled = false, label, value, min, step, integer = false, nullable = false, onChange }: { disabled?: boolean; label: string; value: number | null; min: number; step: number; integer?: boolean; nullable?: boolean; onChange: (value: number | null) => void }) {
  const updateValue = (raw: string) => {
    if (raw === "" && nullable) {
      onChange(null);
      return;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < min || (integer && !Number.isInteger(numeric))) return;
    onChange(numeric);
  };
  return <label className="inspector-field"><span>{label}</span><input aria-label={label} disabled={disabled || (value === null && !nullable)} min={min} step={step} type="number" value={value ?? ""} onChange={(event) => updateValue(event.target.value)} placeholder={nullable ? "Auto" : undefined} /></label>;
}

function OverviewView({ view, onOpenStudio, voiceProfiles, selectedVoiceId, onSelectVoice, onVoiceCreated }: { view: ViewKey; onOpenStudio: () => void; voiceProfiles: VoiceProfile[]; selectedVoiceId: string | null; onSelectVoice: (id: string) => void; onVoiceCreated: (profile: VoiceProfile) => void }) {
  if (view === "voices") {
    return <VoiceLibraryView onOpenStudio={onOpenStudio} voiceProfiles={voiceProfiles} selectedVoiceId={selectedVoiceId} onSelectVoice={onSelectVoice} onVoiceCreated={onVoiceCreated} />;
  }

  if (view === "home") {
    return <div className="overview-grid"><div className="metric-card accent-card reveal-card"><span className="tiny-label">THIS WEEK / RENDERED</span><strong>08<span>h</span>42</strong><p>across 31 approved takes</p><div className="mini-spark"><i /><i /><i /><i /><i /><i /><i /></div></div><div className="metric-card reveal-card"><span className="tiny-label">ACTIVE VOICES</span><strong>04</strong><p>2 local-only / 2 synced</p><div className="voice-dots"><i /><i /><i /><i /></div></div><div className="quick-card reveal-card"><span className="tiny-label">QUICK START</span><h3>Continue the night signal.</h3><button className="primary-button" onClick={onOpenStudio} type="button">Open script studio -&gt;</button></div><div className="recent-card reveal-card"><div className="section-heading"><span>Recent projects</span><button type="button">View all</button></div><div className="recent-row"><span className="project-color orange" /><span><strong>Night signal</strong><small>Edited 4 min ago / 3 scenes</small></span><b>82%</b></div><div className="recent-row"><span className="project-color blue" /><span><strong>Field notes / 04</strong><small>Edited yesterday / 8 scenes</small></span><b>Ready</b></div></div></div>;
  }

  const label = view === "batch" ? "queued scenes" : "rendered outputs";
  return <div className="empty-view reveal-card"><div className="empty-stamp">{view === "batch" ? "B" : "H"}</div><span className="tiny-label">{view.toUpperCase()} / FOUNDATION</span><h3>The {label} are ready for the next pass.</h3><p>This foundation view is wired to the same local-first workspace. The next feature slice will connect it to persistent project data.</p><button className="outline-button" onClick={onOpenStudio} type="button">Back to studio -&gt;</button></div>;
}

function VoiceLibraryView({ onOpenStudio, voiceProfiles, selectedVoiceId, onSelectVoice, onVoiceCreated }: { onOpenStudio: () => void; voiceProfiles: VoiceProfile[]; selectedVoiceId: string | null; onSelectVoice: (id: string) => void; onVoiceCreated: (profile: VoiceProfile) => void }) {
  const voices = voiceProfiles.map(voiceToCard);
  const [showAnalyzer, setShowAnalyzer] = useState(false);

  const selected = voices.find((voice) => voice.id === selectedVoiceId);
  return (
    <div className="voice-library-grid">
      <section className="voice-library-panel reveal-card">
        <div className="library-head"><div><span className="tiny-label">VOICE LIBRARY / {voices.length.toString().padStart(2, "0")} PROFILES</span><h2>Find the voice before the line.</h2></div><button className="primary-button" type="button" onClick={() => setShowAnalyzer(true)}><span className="button-spark">+</span> Add reference</button></div>
        <div className="voice-card-list">
          {voices.length === 0 ? <p className="empty-library">Add a reference to create a voice profile.</p> : voices.map((voice) => <button className={`voice-card voice-${voice.tone} ${selected?.id === voice.id ? "selected" : ""}`} key={voice.id} type="button" onClick={() => onSelectVoice(voice.id)}><span className="voice-card-orb">{voice.name.slice(0, 2).toUpperCase()}</span><span className="voice-card-copy"><strong>{voice.name}</strong><small>{voice.detail}</small><em>{voice.tag}</em></span><span className="voice-score"><b>{voice.score || "--"}</b><small>SCORE</small></span></button>)}
        </div>
        <div className="library-footer"><span>References are local by default.</span><button type="button" onClick={onOpenStudio}>Use selected voice in Studio -&gt;</button></div>
      </section>
      <section className="reference-panel reveal-card">
        <div className="reference-head"><span className="tiny-label">REFERENCE QUALITY</span><span className="quality-state">{selected?.name ?? "No voice"}</span></div>
        <div className="quality-score"><div className="quality-ring"><strong>{selected?.score || 0}</strong><small>/ 100</small></div><div><span className="tiny-label">CURRENT SCORE</span><h3>{selected?.score && selected.score >= 85 ? "Ready to direct" : "Needs a cleaner take"}</h3><p>Short, dry references keep the clone stable across languages.</p></div></div>
        <div className="quality-checks"><QualityCheck label="Length" value="07.4 sec" state="good" /><QualityCheck label="Silence ratio" value="12%" state="good" /><QualityCheck label="Clipping" value="0.02%" state="warn" /><QualityCheck label="ASR confidence" value="Not scanned" state="muted" /></div>
        <button className="outline-button analyzer-button" type="button" onClick={() => setShowAnalyzer(true)}>Run full analyzer -&gt;</button>
      </section>
      {showAnalyzer && (
        <ReferenceAnalyzerPanel
          onClose={() => setShowAnalyzer(false)}
          onCreated={(profile) => {
            onVoiceCreated(profile);
          }}
        />
      )}
    </div>
  );
}

function QualityCheck({ label, value, state }: { label: string; value: string; state: "good" | "warn" | "muted" }) {
  return <div className="quality-check"><span className={`quality-mark ${state}`}>{state === "good" ? "OK" : state === "warn" ? "!" : "--"}</span><span>{label}</span><b>{value}</b></div>;
}

function ReferenceAnalyzerPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (profile: VoiceProfile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState("");
  const [consent, setConsent] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ReferenceAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const selectFile = (nextFile: File | undefined) => {
    if (!nextFile) return;
    const extension = nextFile.name.toLowerCase().slice(nextFile.name.lastIndexOf("."));
    if (extension !== ".wav" && extension !== ".mp3") {
      setError("Chỉ hỗ trợ file .wav hoặc .mp3");
      return;
    }
    setError(null);
    setFile(nextFile);
    setName((current) => current || nextFile.name.replace(/\.[^/.]+$/, ""));
  };

  const saveVoice = async () => {
    const client = getLocalEngineClient();
    if (!client) {
      setError("Local engine chưa kết nối");
      return;
    }
    if (!file || !name.trim()) {
      setError("Hãy chọn file và đặt tên voice");
      return;
    }
    if (!consent) {
      setError("Bạn phải xác nhận quyền sử dụng giọng nói");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const profile = await client.uploadVoice(file, {
        name: name.trim(),
        reference_transcript: transcript.trim(),
        reference_language: language.trim() || undefined,
        consent_type: "owned_voice",
        consent_confirmed: true,
      });
      const referenceAnalysis = profile.metadata.reference_analysis as ReferenceAnalysis | undefined;
      setAnalysis(referenceAnalysis ?? null);
      onCreated(profile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể lưu voice");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="reference-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-top">
          <div><span className="eyebrow-line" /><span className="tiny-label">REFERENCE ANALYZER</span><h2>Add a voice you have permission to use.</h2></div>
          <button className="icon-button" onClick={onClose} type="button">x</button>
        </div>
        <div className="voice-form">
          <label className="voice-field">Voice name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Narrator" /></label>
          <label className="voice-field">Language<input value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="e.g. vi or en" /></label>
        </div>
        <input ref={inputRef} className="hidden-file-input" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" onChange={(event) => selectFile(event.target.files?.[0])} />
        <div
          className={`drop-zone ${file ? "has-file" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files[0]); }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
        >
          <span className="drop-icon">+</span>
          <strong>{file ? file.name : "Drop a WAV or MP3 reference here"}</strong>
          <small>Recommended / 3 to 10 seconds / mono or stereo / max 50 MB</small>
          <button className="outline-button" onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }} type="button">Choose audio</button>
          {previewUrl && <audio className="reference-preview" controls src={previewUrl} />}
        </div>
        <label className="voice-field transcript-field">Reference transcript<textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="Optional, but improves voice matching" /></label>
        <label className="consent-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> I own this voice or have permission to use it.</label>
        {analysis && <div className="upload-analysis"><strong>Reference score: {analysis.score}/100</strong><span>{analysis.warnings.length ? analysis.warnings.join(" / ") : "Reference is ready to use"}</span></div>}
        {error && <div className="form-error">{error}</div>}
        <div className="analyzer-foot"><span>Voice references stay local by default.</span><div><button className="outline-button" onClick={onClose} type="button">Cancel</button><button className="primary-button" disabled={saving} onClick={saveVoice} type="button">{saving ? "Analyzing..." : "Save voice"}</button></div></div>
      </section>
    </div>
  );
}

function DiagnosticsMini({ onOpen }: { onOpen: () => void }) {
  return <div className="mini-diagnostics"><div className="mini-ring"><span>92</span><small>HEALTH</small></div><div className="diag-copy"><strong>Everything is quiet.</strong><p>GPU, local engine, and workspace are responding.</p><button type="button" onClick={onOpen}>Open diagnostics -&gt;</button></div></div>;
}

function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const checks = [
    ["Local engine", "Listening on loopback", "pass"],
    ["GPU / VRAM", "NVIDIA / 8.0 GB available", "pass"],
    ["FFmpeg", "Detected / 6.1.1", "pass"],
    ["Workspace", "12.4 GB free", "pass"],
  ];
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="diagnostic-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow-line" /><span className="tiny-label">SYSTEM DIAGNOSTICS</span><h2>Ready for a clean take.</h2></div><button className="icon-button" onClick={onClose} type="button">x</button></div><div className="diagnostic-list">{checks.map(([name, detail, state]) => <div className="diagnostic-row" key={name}><span className={`diagnostic-icon ${state}`}>OK</span><span><strong>{name}</strong><small>{detail}</small></span><b>PASS</b></div>)}</div><div className="modal-foot"><span>Last scan / just now</span><button className="primary-button" onClick={onClose} type="button">Close panel</button></div></section></div>;
}

export default App;
