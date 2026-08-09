import type { GenerationMode, ScriptSegment, StudioPreset, Take } from "./local-engine";

export type EditableSegmentPatch = Partial<Pick<ScriptSegment,
  "speed" | "duration" | "guidance" | "pause_before_ms" | "pause_after_ms" | "volume"
>>;

export function updateSegmentById(
  segments: ScriptSegment[],
  segmentId: string,
  patch: EditableSegmentPatch,
): ScriptSegment[] {
  return segments.map((segment) => (
    segment.id === segmentId ? { ...segment, ...patch } : segment
  ));
}

export function selectTakeForSegment(
  segments: ScriptSegment[],
  segmentId: string,
  takeId: string,
): ScriptSegment[] {
  return segments.map((segment) => (
    segment.id === segmentId ? { ...segment, selected_take: takeId } : segment
  ));
}

export function resolveSelectedTake(segment: ScriptSegment | null, takes: Take[]): Take | null {
  if (!segment?.selected_take) return null;
  return takes.find((take) => take.id === segment.selected_take && take.segment_id === segment.id) ?? null;
}

export function applyStudioPresetToSegment(
  segment: ScriptSegment,
  emotion: string,
  preset: StudioPreset,
): ScriptSegment {
  return {
    ...segment,
    emotion,
    instruct: preset.instruct ?? null,
    ...(preset.speed !== undefined ? { speed: preset.speed } : {}),
    ...(preset.volume !== undefined ? { volume: preset.volume } : {}),
    ...(preset.pause_after_ms !== undefined ? { pause_after_ms: preset.pause_after_ms } : {}),
    ...(preset.take_count !== undefined ? { take_count: preset.take_count } : {}),
  };
}

export function resolveSegmentVoiceId(
  segment: ScriptSegment,
  mode: GenerationMode,
  speakerVoiceMap: Record<string, string>,
  narratorVoiceId: string | null,
): string | null {
  return segment.voice_id
    ?? (mode === "dialogue" ? (segment.speaker ? speakerVoiceMap[segment.speaker] ?? null : null) : narratorVoiceId);
}
