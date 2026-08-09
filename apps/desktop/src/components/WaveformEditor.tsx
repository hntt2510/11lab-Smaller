import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { AudioEditOptions } from "../lib/local-engine";

export type WaveformRegion = {
  start: number;
  end: number;
};

type WaveformEditorProps = {
  audioUrl: string | null;
  onPlayingChange?: (playing: boolean) => void;
  onRegionChange?: (region: WaveformRegion | null) => void;
  onProcess?: (options: Omit<AudioEditOptions, "source_path">) => void;
  onQualityCheck?: () => void;
  onExportWav?: () => void;
  onExportMp3?: () => void;
  onReplaceTake?: () => void;
};

const emptyRegion: WaveformRegion = { start: 0, end: 0 };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "00:00.0";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

export function WaveformEditor({
  audioUrl,
  onPlayingChange,
  onRegionChange,
  onProcess,
  onQualityCheck,
  onExportWav,
  onExportMp3,
  onReplaceTake,
}: WaveformEditorProps) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const loopRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [region, setRegion] = useState<WaveformRegion | null>(null);
  const [zoom, setZoom] = useState(40);
  const [loop, setLoop] = useState(false);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [silenceBefore, setSilenceBefore] = useState(0);
  const [silenceAfter, setSilenceAfter] = useState(0);
  const [volume, setVolume] = useState(1);
  const [preset, setPreset] = useState("Raw");
  const [message, setMessage] = useState("Drag the region handles to select a sentence");

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  useEffect(() => {
    if (!waveformRef.current) return;

    const regions = RegionsPlugin.create();
    const waveSurfer = WaveSurfer.create({
      container: waveformRef.current,
      height: 78,
      normalize: true,
      waveColor: "#8b9a94",
      progressColor: "#ec684b",
      cursorColor: "#172633",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      dragToSeek: true,
      hideScrollbar: true,
      url: audioUrl ?? undefined,
      plugins: [regions],
    });

    waveSurferRef.current = waveSurfer;
    regionsRef.current = regions;
    setDuration(0);
    setCurrentTime(0);
    setRegion(null);
    onRegionChange?.(null);

    const syncPlaying = (playing: boolean) => {
      setIsPlaying(playing);
      onPlayingChange?.(playing);
    };
    const syncRegion = (nextRegion: { start: number; end: number }) => {
      const next = { start: nextRegion.start, end: nextRegion.end };
      setRegion(next);
      onRegionChange?.(next);
    };

    const subscriptions = [
      waveSurfer.on("ready", (nextDuration) => {
        setDuration(nextDuration);
        if (nextDuration <= 0) return;
        const initial = regions.addRegion({
          id: "selected-sentence",
          start: 0,
          end: nextDuration,
          color: "rgba(236, 104, 75, 0.18)",
          drag: true,
          resize: true,
        });
        syncRegion(initial);
      }),
      waveSurfer.on("play", () => syncPlaying(true)),
      waveSurfer.on("pause", () => syncPlaying(false)),
      waveSurfer.on("finish", () => syncPlaying(false)),
      waveSurfer.on("timeupdate", setCurrentTime),
      waveSurfer.on("error", () => setMessage("This take could not be decoded")),
      regions.on("region-updated", syncRegion),
      regions.on("region-out", (outRegion) => {
        if (loopRef.current) void outRegion.play();
      }),
    ];

    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      waveSurfer.destroy();
      waveSurferRef.current = null;
      regionsRef.current = null;
      setIsPlaying(false);
      onPlayingChange?.(false);
    };
  }, [audioUrl, onPlayingChange, onRegionChange]);

  const togglePlay = () => {
    if (!waveSurferRef.current || !audioUrl) {
      setMessage("Generate a take to activate the waveform");
      return;
    }
    void waveSurferRef.current.playPause();
  };

  const playSelection = () => {
    if (!waveSurferRef.current || !region) return;
    void waveSurferRef.current.play(region.start, region.end);
  };

  const applyEdit = () => {
    if (!onProcess || !region) return;
    onProcess({
      output_format: "wav",
      trim_start: region.start,
      trim_end: region.end,
      fade_in: fadeIn,
      fade_out: fadeOut,
      volume,
      silence_before: silenceBefore,
      silence_after: silenceAfter,
      preset,
    });
  };

  const selectedDuration = region ? region.end - region.start : emptyRegion.end;

  return (
    <div className="wave-editor">
      <div className="wave-editor-head">
        <div>
          <span className="tiny-label">WAVESURFER / REGION EDITOR</span>
          <strong>{region ? `${formatTime(region.start)} - ${formatTime(region.end)}` : "No take loaded"}</strong>
        </div>
        <span className="wave-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
      </div>
      <div className="wave-editor-canvas">
        <div ref={waveformRef} className="waveform-canvas" aria-label="Editable audio waveform" />
        {!audioUrl && <div className="wave-editor-empty">Generate a take to inspect its waveform</div>}
      </div>
      <div className="wave-editor-actions">
        <button className="play-button" onClick={togglePlay} type="button" aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? "||" : ">"}
        </button>
        <button type="button" onClick={() => waveSurferRef.current?.skip(-10)}>-10</button>
        <button type="button" onClick={() => waveSurferRef.current?.skip(10)}>+10</button>
        <button type="button" onClick={playSelection} disabled={!region}>Play region</button>
        <button className={loop ? "active-tool" : ""} onClick={() => setLoop((value) => !value)} type="button" disabled={!region}>
          Loop
        </button>
        <label className="zoom-control">Zoom
          <input
            type="range"
            min="20"
            max="180"
            step="5"
            value={zoom}
            onChange={(event) => {
              const nextZoom = Number(event.target.value);
              setZoom(nextZoom);
              waveSurferRef.current?.zoom(nextZoom);
            }}
          />
        </label>
        <button className="replace-take" onClick={onReplaceTake} type="button">Replace take</button>
      </div>
      <div className="wave-editor-editing">
        <label>Fade in <input type="number" min="0" max="5" step="0.05" value={fadeIn} onChange={(event) => setFadeIn(Number(event.target.value))} />s</label>
        <label>Fade out <input type="number" min="0" max="5" step="0.05" value={fadeOut} onChange={(event) => setFadeOut(Number(event.target.value))} />s</label>
        <label>Pause before <input type="number" min="0" max="10" step="0.05" value={silenceBefore} onChange={(event) => setSilenceBefore(Number(event.target.value))} />s</label>
        <label>Pause after <input type="number" min="0" max="10" step="0.05" value={silenceAfter} onChange={(event) => setSilenceAfter(Number(event.target.value))} />s</label>
        <label>Volume <input type="number" min="0.01" max="4" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
        <label>Master <select value={preset} onChange={(event) => setPreset(event.target.value)}>
          <option>Raw</option>
          <option>YouTube Narration</option>
          <option>Documentary</option>
          <option>Podcast</option>
          <option>Product Review</option>
          <option>Short-form / TikTok</option>
        </select></label>
        <button className="apply-edit" onClick={applyEdit} type="button" disabled={!region}>Apply edit</button>
        <span className="edit-duration">{formatTime(selectedDuration)} selected</span>
      </div>
      <div className="wave-editor-footer">
        <span>{message}</span>
        <div>
          <button type="button" onClick={onQualityCheck} disabled={!audioUrl}>Quality check</button>
          <button type="button" onClick={onExportWav} disabled={!audioUrl}>Export WAV</button>
          <button type="button" onClick={onExportMp3} disabled={!audioUrl}>Export MP3</button>
        </div>
      </div>
    </div>
  );
}
