import type { AsrSegment, ClipPlan, ClipPlanClip } from "@clip/sdk";
import { enforceEpisodeBoundaryAnchors } from "./episode-boundary-anchors.js";
import { parseSegmentOrdinal } from "./clip-plan-coherence.js";
import {
  findBestBurstSegmentInEpisode,
  isStrongBurstScore,
  scoreBurstSegment,
} from "./burst-heuristic.js";

export type DurationPolicy = "soft" | "strict";
export type EditForm = "sequential" | "skip_episode" | "hook_first" | "commentary";
export type TargetDurationLabel = "3min" | "10min";
export type DurationStatus = "on_target" | "under_preferred" | "over_preferred";

export const TARGET_DURATION_PREFERRED_SEC: Record<TargetDurationLabel, number> = {
  "3min": 180,
  "10min": 600,
};

/** 偏好下限：未达仍可出片（偏短），与硬下限区分 */
export const SMART_PLAN_MIN_DURATION_SEC: Record<TargetDurationLabel, number> = {
  "3min": 150,
  "10min": 480,
};

/**
 * 硬下限：低于此不成片。
 * 3min 与偏好一致；10min 仅拒明显过短（<3min），480s 为偏好而非硬门。
 */
export const SMART_PLAN_HARD_MIN_DURATION_SEC: Record<TargetDurationLabel, number> = {
  "3min": 150,
  "10min": 180,
};

/** 成片硬上限：10min 控在约 10 分钟，禁止涨到 15~18 分钟 */
export const SMART_PLAN_MAX_DURATION_SEC: Record<TargetDurationLabel, number> = {
  "3min": 240,
  "10min": 720,
};

export const SMART_PLAN_MIN_CLIP_COUNT: Record<TargetDurationLabel, number> = {
  "3min": 8,
  "10min": 20,
};

/** 批内多数走 hook_first，少出「贴集首铺垫」开头 */
const EDIT_FORM_ROTATION: EditForm[] = ["hook_first", "hook_first", "skip_episode", "hook_first"];

export interface SmartPlanSlot {
  targetDurationLabel: TargetDurationLabel;
  editForm: EditForm;
  minClipCount: number;
  minDurationSec: number;
}

/** 按批次序号分配时长标签与剪辑形式，保证批内差异化 */
export function assignSmartPlanSlot(index: number, plansPerRound: number): SmartPlanSlot {
  const shortSlots = Math.max(1, Math.min(2, Math.floor(plansPerRound * 0.17)));
  const targetDurationLabel: TargetDurationLabel = index < shortSlots ? "3min" : "10min";
  const editForm = EDIT_FORM_ROTATION[index % EDIT_FORM_ROTATION.length] ?? "sequential";
  return {
    targetDurationLabel,
    editForm,
    minClipCount: SMART_PLAN_MIN_CLIP_COUNT[targetDurationLabel],
    minDurationSec: SMART_PLAN_MIN_DURATION_SEC[targetDurationLabel],
  };
}

/** 揭底关键词：片尾不应落在此类完整句上 */
const REVEAL_ENDING_PATTERN =
  /其实我是|真相就是|原来你是|身份就是|真正的.*是|已经全部|彻底失败|已经死了|已经死了/i;

export function resolveTargetDurationSec(label?: string, fallback?: number): number {
  if (label === "3min") return TARGET_DURATION_PREFERRED_SEC["3min"];
  if (label === "10min") return TARGET_DURATION_PREFERRED_SEC["10min"];
  return fallback ?? TARGET_DURATION_PREFERRED_SEC["3min"];
}

export function inferDurationStatus(
  actualSec: number,
  label?: TargetDurationLabel | string,
): DurationStatus {
  const preferred = resolveTargetDurationSec(label);
  const tolerance = Math.max(30, preferred * 0.15);
  if (Math.abs(actualSec - preferred) <= tolerance) return "on_target";
  if (actualSec < preferred - tolerance) return "under_preferred";
  return "over_preferred";
}

export function mapTargetLabelToTier(label?: string): ClipPlan["durationTier"] {
  if (label === "10min") return "L";
  return "S";
}

function segmentsByEpisode(segments: AsrSegment[]): Map<string, AsrSegment[]> {
  const map = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const key = seg.episodeId ?? parseSegmentOrdinal(seg.segmentId, seg)?.episodeKey ?? "default";
    const list = map.get(key) ?? [];
    list.push(seg);
    map.set(key, list);
  }
  for (const [key, list] of map) {
    map.set(
      key,
      [...list].sort((a, b) => {
        const ai = parseSegmentOrdinal(a.segmentId, a)?.index ?? a.startMs;
        const bi = parseSegmentOrdinal(b.segmentId, b)?.index ?? b.startMs;
        return ai - bi || a.startMs - b.startMs;
      }),
    );
  }
  return map;
}

function resolveOpeningEpisodeId(plan: ClipPlan, segments: AsrSegment[]): string | null {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const hookId = plan.hookSegmentId?.trim();
  if (hookId) {
    const hookSeg = segmentMap.get(hookId);
    const fromHook =
      hookSeg?.episodeId ?? parseSegmentOrdinal(hookId, hookSeg)?.episodeKey ?? null;
    if (fromHook) return fromHook;
  }
  const firstClip = plan.clips[0];
  if (!firstClip) return null;
  const firstSeg = segmentMap.get(firstClip.segmentId);
  return firstSeg?.episodeId ?? parseSegmentOrdinal(firstClip.segmentId, firstSeg)?.episodeKey ?? null;
}

function findBestHookAnchor(episodeList: AsrSegment[]): AsrSegment | null {
  let bestHook: AsrSegment | null = null;
  let bestHookScore = -1;
  for (const seg of episodeList) {
    if (!seg.usableAsHook) continue;
    const score = seg.highlightScore ?? scoreBurstSegment(seg).score;
    if (score > bestHookScore) {
      bestHook = seg;
      bestHookScore = score;
    }
  }
  if (bestHook) return bestHook;
  return findBestBurstSegmentInEpisode(episodeList);
}

/**
 * hook_first：仅标注 hook 角色 / 补 hookSegmentId 建议，**不再机械重写 clips**。
 * 弱开篇交给质量闸拒案 + LLM retry；避免 burst 窗拆掉模型建置。
 */
export function applyEditFormToPlan(plan: ClipPlan, segments: AsrSegment[]): ClipPlan {
  if (plan.editForm !== "hook_first") {
    return plan;
  }

  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const firstClip = plan.clips[0];
  const withHookRole: ClipPlan = {
    ...plan,
    clips: plan.clips.map((c, i) => (i === 0 ? { ...c, role: "hook" as const } : c)),
  };

  if (firstClip) {
    const firstSeg = segmentMap.get(firstClip.segmentId);
    const burst = firstSeg
      ? (firstSeg.highlightScore ?? scoreBurstSegment(firstSeg).score)
      : 0;
    const hookId = plan.hookSegmentId?.trim();
    const matchesHook =
      Boolean(hookId) &&
      (firstClip.segmentId === hookId ||
        firstClip.throughSegmentId === hookId ||
        plan.clips.some((c) => c.segmentId === hookId || c.throughSegmentId === hookId));
    const openingOk =
      Boolean(firstSeg?.usableAsHook) ||
      isStrongBurstScore(burst) ||
      matchesHook ||
      Boolean(plan.hookType?.trim()) ||
      Boolean(plan.setupClaim?.trim());
    if (openingOk) {
      return {
        ...withHookRole,
        hookSegmentId: plan.hookSegmentId ?? firstClip.segmentId,
      };
    }
  }

  // 弱开篇：只建议 hookSegmentId，不改 clips（由闸门打回 LLM）
  const openingEp = resolveOpeningEpisodeId(plan, segments);
  if (!openingEp) return withHookRole;
  const byEpisode = segmentsByEpisode(segments);
  const epList = byEpisode.get(openingEp);
  if (!epList?.length) return withHookRole;
  const suggested =
    (plan.hookSegmentId?.trim()
      ? epList.find((s) => s.segmentId === plan.hookSegmentId!.trim())
      : undefined) || findBestHookAnchor(epList);

  return {
    ...withHookRole,
    hookSegmentId: plan.hookSegmentId ?? suggested?.segmentId ?? plan.clips[0]?.segmentId,
  };
}

/** 片尾是否落在「已揭底」句上（轻量规则） */
export function hasRevealSpoilerEnding(plan: ClipPlan, segments: AsrSegment[]): boolean {
  if (!plan.clips.length) return false;
  const last = plan.clips.at(-1)!;
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const endSeg = segmentMap.get(last.throughSegmentId ?? last.segmentId);
  const text = endSeg?.text?.trim() ?? "";
  return REVEAL_ENDING_PATTERN.test(text);
}

function episodeKeyOf(seg: AsrSegment | undefined, segmentId: string): string {
  return seg?.episodeId ?? parseSegmentOrdinal(segmentId, seg)?.episodeKey ?? "default";
}

/**
 * 按时长累加 clips：若有 throughSegmentId，按同集连续段求真累加（LLM 块意图时长）。
 * 禁止只加头段导致 10min「假短」、过长闸门失效。
 */
export function computeClipsDurationSecWithThrough(
  clips: ClipPlanClip[],
  segments: AsrSegment[],
): number {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const key = episodeKeyOf(seg, seg.segmentId);
    const list = byEpisode.get(key);
    if (list) list.push(seg);
    else byEpisode.set(key, [seg]);
  }
  for (const list of byEpisode.values()) {
    list.sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId));
  }

  let ms = 0;
  for (const clip of clips) {
    const startSeg = segmentMap.get(clip.segmentId);
    if (!startSeg) continue;
    const endId = clip.throughSegmentId?.trim() || clip.segmentId;
    const epKey = episodeKeyOf(startSeg, clip.segmentId);
    const list = byEpisode.get(epKey) ?? [];
    const si = list.findIndex((s) => s.segmentId === clip.segmentId);
    const ei = list.findIndex((s) => s.segmentId === endId);
    if (si < 0) {
      const start = startSeg.startMs + (clip.trimStartMs ?? 0);
      const end = startSeg.endMs - (clip.trimEndMs ?? 0);
      ms += Math.max(0, end - start);
      continue;
    }
    const endIdx = ei >= si ? ei : si;
    for (let i = si; i <= endIdx; i++) {
      const seg = list[i]!;
      const start = seg.startMs + (i === si ? (clip.trimStartMs ?? 0) : 0);
      const end = seg.endMs - (i === endIdx ? (clip.trimEndMs ?? 0) : 0);
      ms += Math.max(0, end - start);
    }
  }
  return Math.max(1, Math.ceil(ms / 1000));
}

export function annotatePlanDurationMeta(plan: ClipPlan, segments: AsrSegment[]): ClipPlan {
  const estimatedDurationSec = computeClipsDurationSecWithThrough(plan.clips, segments);
  const label = plan.targetDurationLabel;
  return {
    ...plan,
    estimatedDurationSec,
    durationStatus: inferDurationStatus(estimatedDurationSec, label),
    targetDurationSec: resolveTargetDurationSec(label, plan.targetDurationSec),
    durationTier: plan.durationTier ?? mapTargetLabelToTier(label),
  };
}

/** @deprecated smart 模式已移除 */
export function finalizeSmartPlanBoundaries(plan: ClipPlan, segments: AsrSegment[]): ClipPlan {
  const withForm = applyEditFormToPlan(plan, segments);
  return enforceEpisodeBoundaryAnchors(withForm, segments).plan;
}
