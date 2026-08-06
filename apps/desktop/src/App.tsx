import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import {
  EngineHealth,
  ScriptSegment,
  VoiceProfile,
  getLocalEngineClient,
} from "./lib/local-engine";

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

const demoVoices = [
  { id: "atlas", name: "Atlas", detail: "warm low / English", score: 92, tone: "orange", tag: "NATURAL" },
  { id: "mira", name: "Mira", detail: "clear bright / Vietnamese", score: 86, tone: "blue", tag: "LOCAL ONLY" },
  { id: "north", name: "North", detail: "measured / English", score: 78, tone: "green", tag: "REFERENCE" },
];

const waveform = [
  18, 29, 14, 44, 26, 52, 39, 20, 66, 34, 23, 58, 73, 45, 31, 62, 24, 51,
  36, 70, 42, 27, 57, 31, 76, 49, 34, 61, 25, 45, 67, 33, 22, 58, 39, 72,
  44, 25, 62, 35, 55, 28, 70, 42, 31, 63, 22, 48, 35, 59, 26, 71, 38, 23,
  54, 32, 67, 43, 27, 58, 36, 74, 45, 29, 61, 33, 52, 24, 68, 40, 30, 56,
  21, 49, 35, 65, 42, 27, 57, 32, 70, 44, 26, 53, 38, 62, 24, 47,
];

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

function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [activeView, setActiveView] = useState<ViewKey>("studio");
  const [selectedScript, setSelectedScript] = useState("02");
  const [scriptLines, setScriptLines] = useState<ScriptLine[]>(scripts);
  const [sourceDraft, setSourceDraft] = useState(scriptSource);
  const [renderStatus, setRenderStatus] = useState<RenderStatus>("ready");
  const [isPlaying, setIsPlaying] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
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
        const audio = await client.generate({
          text: scriptLines.find((script) => script.id === selectedScript)?.text ?? scriptLines[0].text,
          options: { num_step: 32, postprocess_output: true },
        });
        setAudioUrl(URL.createObjectURL(audio));
        setRenderStatus("complete");
        setToast("WAV returned by the local engine");
      } catch {
        setRenderStatus("ready");
        setToast("Local engine is unavailable; showing preview state");
      }
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
              isPlaying={isPlaying}
              onPlay={() => setIsPlaying((playing) => !playing)}
              onSelect={setSelectedScript}
              selectedScript={selectedScript}
              renderStatus={renderStatus}
              onGenerate={generateTake}
              audioUrl={audioUrl}
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
  isPlaying,
  onPlay,
  onSelect,
  selectedScript,
  renderStatus,
  onGenerate,
  audioUrl,
  scripts,
  sourceDraft,
  onSourceChange,
  onParse,
}: {
  isPlaying: boolean;
  onPlay: () => void;
  onSelect: (id: string) => void;
  selectedScript: string;
  renderStatus: RenderStatus;
  onGenerate: () => void;
  audioUrl: string | null;
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
          <div className="waveform-wrap">
          <button className="play-button" onClick={onPlay} type="button" aria-label={isPlaying ? "Pause" : "Play"}>{isPlaying ? "||" : ">"}</button>
          <div className={`waveform ${isPlaying ? "playing" : ""}`} aria-label="Audio waveform">
            {waveform.map((height, index) => <span key={`${height}-${index}`} style={{ height: `${height}%` }} />)}
          </div>
          {audioUrl && <audio className="native-audio" controls src={audioUrl} />}
          <span className="wave-time">00:06.4 / 00:07.4</span>
        </div>
        <div className="transport-bottom">
          <div className="transport-controls"><button type="button">|&lt;</button><button type="button">-10</button><button type="button">+10</button><button type="button">&gt;|</button></div>
          <div className="take-strip"><span className="active-take">A</span><span>B</span><span>C</span><span className="take-label">3 takes</span></div>
          <button className="export-button" type="button" onClick={onGenerate}>Render WAV <span>-&gt;</span></button>
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
      setVoices(
        profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          detail: `${profile.default_preset} / ${profile.reference_language ?? "language agnostic"}`,
          score: Number((profile.metadata.reference_analysis as { score?: number } | undefined)?.score ?? 0),
          tone: profile.favorite ? "orange" : "blue",
          tag: profile.cloud_sync_status === "local" ? "LOCAL ONLY" : "SYNCED",
        })),
      );
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
      {showAnalyzer && <ReferenceAnalyzerPanel onClose={() => setShowAnalyzer(false)} />}
    </div>
  );
}

function QualityCheck({ label, value, state }: { label: string; value: string; state: "good" | "warn" | "muted" }) {
  return <div className="quality-check"><span className={`quality-mark ${state}`}>{state === "good" ? "OK" : state === "warn" ? "!" : "--"}</span><span>{label}</span><b>{value}</b></div>;
}

function ReferenceAnalyzerPanel({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="reference-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow-line" /><span className="tiny-label">REFERENCE ANALYZER</span><h2>Make the source voice easier to trust.</h2></div><button className="icon-button" onClick={onClose} type="button">x</button></div><div className="drop-zone"><span className="drop-icon">+</span><strong>Drop a WAV reference here</strong><small>Recommended / 3 to 10 seconds / mono or stereo</small><button className="outline-button" type="button">Choose audio</button></div><div className="analyzer-foot"><span>Consent is required before saving a cloned voice.</span><button className="primary-button" onClick={onClose} type="button">Done</button></div></section></div>;
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
