import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import {
  EngineHealth,
  ReferenceAnalysis,
  ScriptSegment,
  VoiceProfile,
  getLocalEngineClient,
} from "./lib/local-engine";
import type { AudioEditOptions } from "./lib/local-engine";
import { WaveformEditor } from "./components/WaveformEditor";

gsap.registerPlugin(useGSAP);

type ViewKey = "home" | "voices" | "studio" | "batch" | "history";
type RenderStatus = "ready" | "rendering" | "complete";

type ScriptLine = {
  id: string;
  tag: string;
  text: string;
  duration: string;
};

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

const scripts = [
  {
    id: "01",
    tag: "calm",
    text: "Tonight, the signal arrives from a place no map can name.",
    duration: "00:06.8",
  },
  {
    id: "02",
    tag: "curious",
    text: "At first, it sounds like static. Then it starts answering back.",
    duration: "00:07.4",
  },
  {
    id: "03",
    tag: "emphasis",
    text: "This is where the quiet side of the story changes everything.",
    duration: "00:06.1",
  },
];

const scriptSource = "[calm] Tonight, the signal arrives from a place no map can name.\n[pause=500]\n[curious] At first, it sounds like static. Then it starts answering back.\n[excited speed=1.08] This is where the quiet side of the story changes everything.";

const demoVoices: VoiceCard[] = [
  { id: "atlas", name: "Atlas", detail: "warm low / English", score: 92, tone: "orange", tag: "NATURAL" },
  { id: "mira", name: "Mira", detail: "clear bright / Vietnamese", score: 86, tone: "blue", tag: "LOCAL ONLY" },
  { id: "north", name: "North", detail: "measured / English", score: 78, tone: "green", tag: "REFERENCE" },
];

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

function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [activeView, setActiveView] = useState<ViewKey>("studio");
  const [selectedScript, setSelectedScript] = useState("02");
  const [scriptLines, setScriptLines] = useState<ScriptLine[]>(scripts);
  const [sourceDraft, setSourceDraft] = useState(scriptSource);
  const [renderStatus, setRenderStatus] = useState<RenderStatus>("ready");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
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
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

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
      const parsed = await client.parseScript(sourceDraft, "atlas");
      setScriptLines(
        parsed.segments.map((segment, index) => ({
          id: String(index + 1).padStart(2, "0"),
          tag: segment.emotion ?? "line",
          text: segment.text,
          duration: segment.duration ? `${segment.duration.toFixed(1)}s` : "--",
        })),
      );
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
        segments: scriptLines.map(lineToSegment),
      });
      setToast("Project autosaved to the local workspace");
    } catch {
      setToast("Autosave is unavailable; keeping the local draft");
    }
  });

  const generateTake = contextSafe(async () => {
    setRenderStatus("rendering");
    setToast("Take queued in the local render lane");
    gsap.fromTo(
      ".render-meter",
      { scaleX: 0, transformOrigin: "left center" },
      { scaleX: 1, duration: 1.5, ease: "power2.inOut", overwrite: true },
    );

    const client = getLocalEngineClient();
    if (client) {
      try {
        const generated = await client.generate({
          text: scriptLines.find((script) => script.id === selectedScript)?.text ?? scriptLines[0].text,
          options: { num_step: 32, postprocess_output: true },
        });
        setAudioPath(generated.outputPath);
        setAudioUrl(URL.createObjectURL(generated.blob));
        setRenderStatus("complete");
        setToast("WAV returned by the local engine");
      } catch {
        setRenderStatus("ready");
        setToast("Local engine is unavailable; showing preview state");
      }
    }
  });

  const processAudioEdit = contextSafe(async (options: Omit<AudioEditOptions, "source_path">) => {
    const client = getLocalEngineClient();
    if (!client || !audioPath) {
      setToast("Generate a local take before applying waveform edits");
      return;
    }
    try {
      const result = await client.processAudio({ ...options, source_path: audioPath, output_format: "wav" });
      const blob = await client.fetchAudio(result.output_path);
      setAudioPath(result.output_path);
      setAudioUrl(URL.createObjectURL(blob));
      setToast(result.warnings.length ? result.warnings[0] : "Waveform edit applied");
    } catch {
      setToast("Audio edit failed; keeping the current take");
    }
  });

  const runQualityCheck = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !audioPath) {
      setToast("Generate a local take before running quality check");
      return;
    }
    try {
      const result = await client.qualityCheck(audioPath);
      setToast(result.passed ? "Quality check passed" : result.warnings.join(" / "));
    } catch {
      setToast("Quality checker is unavailable");
    }
  });

  const exportMp3 = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !audioPath) {
      setToast("Generate a local take before exporting MP3");
      return;
    }
    try {
      const result = await client.processAudio({ source_path: audioPath, output_format: "mp3", preset: "Raw" });
      downloadBlob(await client.fetchAudio(result.output_path), "episode-01.mp3");
      setToast("MP3 export downloaded");
    } catch {
      setToast("MP3 export failed; check that FFmpeg is installed");
    }
  });

  const exportWav = contextSafe(async () => {
    const client = getLocalEngineClient();
    if (!client || !audioPath) {
      setToast("Generate a local take before exporting WAV");
      return;
    }
    try {
      downloadBlob(await client.fetchAudio(audioPath), "episode-01.wav");
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
      const result = await client.exportSrt(scriptLines.map(lineToSegment), "episode-01.srt");
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
              <button className="primary-button" type="button" onClick={generateTake}>
                <span className="button-spark">+</span>
                Generate take
              </button>
            </div>
          </section>

          {activeView === "studio" ? (
            <StudioView
              onSelect={setSelectedScript}
              selectedScript={selectedScript}
              renderStatus={renderStatus}
              onGenerate={generateTake}
              audioUrl={audioUrl}
              onProcessEdit={processAudioEdit}
              onQualityCheck={runQualityCheck}
              onExportWav={exportWav}
              onExportMp3={exportMp3}
              onExportSrt={exportSrt}
              onReplaceTake={generateTake}
              scripts={scriptLines}
              sourceDraft={sourceDraft}
              onSourceChange={setSourceDraft}
              onParse={parseDraft}
            />
          ) : (
            <OverviewView view={activeView} onOpenStudio={() => chooseView("studio")} />
          )}
        </div>
      </main>

      <aside className="inspector-column">
        <div className="inspector-head">
          <div>
            <span className="tiny-label">INSPECTOR</span>
            <h2>{activeView === "studio" ? "Line direction" : "Workspace pulse"}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close inspector">x</button>
        </div>
        {activeView === "studio" ? (
          <StudioInspector renderStatus={renderStatus} onGenerate={generateTake} />
        ) : (
          <DiagnosticsMini onOpen={() => setShowDiagnostics(true)} />
        )}
      </aside>

      {showDiagnostics && <DiagnosticsModal onClose={() => setShowDiagnostics(false)} />}
      {toast && <div className="toast"><span className="toast-mark">OK</span>{toast}</div>}
    </div>
  );
}

function lineToSegment(line: ScriptLine): ScriptSegment {
  return {
    id: `segment-${line.id}`,
    text: line.text,
    voice_id: "atlas",
    emotion: line.tag === "line" ? null : line.tag,
    instruct: line.tag === "line" ? null : line.tag,
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

function StudioView({
  onSelect,
  selectedScript,
  renderStatus,
  onGenerate,
  audioUrl,
  onProcessEdit,
  onQualityCheck,
  onExportWav,
  onExportMp3,
  onExportSrt,
  onReplaceTake,
  scripts,
  sourceDraft,
  onSourceChange,
  onParse,
}: {
  onSelect: (id: string) => void;
  selectedScript: string;
  renderStatus: RenderStatus;
  onGenerate: () => void;
  audioUrl: string | null;
  onProcessEdit: (options: Omit<AudioEditOptions, "source_path">) => void;
  onQualityCheck: () => void;
  onExportWav: () => void;
  onExportMp3: () => void;
  onExportSrt: () => void;
  onReplaceTake: () => void;
  scripts: ScriptLine[];
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
        <div className="script-list">
          {scripts.map((script) => (
            <button
              className={`script-line ${selectedScript === script.id ? "selected" : ""}`}
              key={script.id}
              onClick={() => onSelect(script.id)}
              type="button"
            >
              <span className="line-number">{script.id}</span>
              <span className="line-copy">
                <span className={`tag-pill tag-${script.tag}`}>[{script.tag}]</span>
                <span className="line-text">{script.text}</span>
              </span>
              <span className="line-duration">{script.duration}</span>
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

function StudioInspector({ renderStatus, onGenerate }: { renderStatus: RenderStatus; onGenerate: () => void }) {
  return (
    <div className="inspector-scroll">
      <div className="selection-label"><span className="selection-number">02</span><div><span className="tiny-label">SELECTED LINE</span><strong>Curious / 00:07.4</strong></div></div>
      <div className="voice-select"><div className="voice-avatar">AR</div><div><span className="tiny-label">VOICE PROFILE</span><strong>Atlas / warm low</strong></div><span className="select-chevron">v</span></div>
      <div className="inspector-section"><div className="section-heading"><span>Direction</span><button type="button">Reset</button></div><div className="emotion-grid"><button className="emotion active" type="button"><span>01</span>Curious</button><button className="emotion" type="button"><span>02</span>Bright</button><button className="emotion" type="button"><span>03</span>Measured</button></div></div>
      <div className="inspector-section sliders"><div className="section-heading"><span>Performance</span><span className="unit-label">PRESET / NATURAL</span></div><RangeRow label="Speed" value="0.98" percent={46} /><RangeRow label="Guidance" value="2.0" percent={58} /><RangeRow label="Pause after" value="420 ms" percent={35} /></div>
      <div className="instruct-note"><span className="note-symbol">i</span><p>Studio tags are best-effort direction. The reference voice still leads the performance.</p></div>
      <button className={`inspector-generate ${renderStatus === "rendering" ? "busy" : ""}`} onClick={onGenerate} type="button"><span>{renderStatus === "rendering" ? "Rendering take..." : "Generate new take"}</span><span>-&gt;</span></button>
      <div className="take-list"><div className="section-heading"><span>Recent takes</span><span className="unit-label">TODAY</span></div><div className="take-row"><span className="take-badge selected">B</span><span><strong>Natural</strong><small>00:07.4 / 2.8 MB</small></span><span className="take-check">OK</span></div><div className="take-row"><span className="take-badge">A</span><span><strong>Stable</strong><small>00:07.1 / 2.7 MB</small></span><button type="button">...</button></div></div>
    </div>
  );
}

function RangeRow({ label, value, percent }: { label: string; value: string; percent: number }) {
  return <div className="range-row"><div><span>{label}</span><strong>{value}</strong></div><div className="range-track"><span style={{ width: `${percent}%` }} /><i style={{ left: `${percent}%` }} /></div></div>;
}

function OverviewView({ view, onOpenStudio }: { view: ViewKey; onOpenStudio: () => void }) {
  if (view === "voices") {
    return <VoiceLibraryView onOpenStudio={onOpenStudio} />;
  }

  if (view === "home") {
    return <div className="overview-grid"><div className="metric-card accent-card reveal-card"><span className="tiny-label">THIS WEEK / RENDERED</span><strong>08<span>h</span>42</strong><p>across 31 approved takes</p><div className="mini-spark"><i /><i /><i /><i /><i /><i /><i /></div></div><div className="metric-card reveal-card"><span className="tiny-label">ACTIVE VOICES</span><strong>04</strong><p>2 local-only / 2 synced</p><div className="voice-dots"><i /><i /><i /><i /></div></div><div className="quick-card reveal-card"><span className="tiny-label">QUICK START</span><h3>Continue the night signal.</h3><button className="primary-button" onClick={onOpenStudio} type="button">Open script studio -&gt;</button></div><div className="recent-card reveal-card"><div className="section-heading"><span>Recent projects</span><button type="button">View all</button></div><div className="recent-row"><span className="project-color orange" /><span><strong>Night signal</strong><small>Edited 4 min ago / 3 scenes</small></span><b>82%</b></div><div className="recent-row"><span className="project-color blue" /><span><strong>Field notes / 04</strong><small>Edited yesterday / 8 scenes</small></span><b>Ready</b></div></div></div>;
  }

  const label = view === "batch" ? "queued scenes" : "rendered outputs";
  return <div className="empty-view reveal-card"><div className="empty-stamp">{view === "batch" ? "B" : "H"}</div><span className="tiny-label">{view.toUpperCase()} / FOUNDATION</span><h3>The {label} are ready for the next pass.</h3><p>This foundation view is wired to the same local-first workspace. The next feature slice will connect it to persistent project data.</p><button className="outline-button" onClick={onOpenStudio} type="button">Back to studio -&gt;</button></div>;
}

function VoiceLibraryView({ onOpenStudio }: { onOpenStudio: () => void }) {
  const [voices, setVoices] = useState(demoVoices);
  const [selectedVoice, setSelectedVoice] = useState("atlas");
  const [showAnalyzer, setShowAnalyzer] = useState(false);

  useEffect(() => {
    const client = getLocalEngineClient();
    if (!client) return;
    client.listVoices().then((profiles: VoiceProfile[]) => {
      if (profiles.length === 0) return;
      setVoices(profiles.map(voiceToCard));
    }).catch(() => undefined);
  }, []);

  const selected = voices.find((voice) => voice.id === selectedVoice) ?? voices[0];
  return (
    <div className="voice-library-grid">
      <section className="voice-library-panel reveal-card">
        <div className="library-head"><div><span className="tiny-label">VOICE LIBRARY / {voices.length.toString().padStart(2, "0")} PROFILES</span><h2>Find the voice before the line.</h2></div><button className="primary-button" type="button" onClick={() => setShowAnalyzer(true)}><span className="button-spark">+</span> Add reference</button></div>
        <div className="voice-card-list">
          {voices.map((voice) => <button className={`voice-card voice-${voice.tone} ${selected?.id === voice.id ? "selected" : ""}`} key={voice.id} type="button" onClick={() => setSelectedVoice(voice.id)}><span className="voice-card-orb">{voice.name.slice(0, 2).toUpperCase()}</span><span className="voice-card-copy"><strong>{voice.name}</strong><small>{voice.detail}</small><em>{voice.tag}</em></span><span className="voice-score"><b>{voice.score || "--"}</b><small>SCORE</small></span></button>)}
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
            setVoices((current) => [voiceToCard(profile), ...current.filter((voice) => voice.id !== profile.id)]);
            setSelectedVoice(profile.id);
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
