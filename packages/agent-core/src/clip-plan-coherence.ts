import type { AsrSegment, ClipPlan, ClipPlanClip } from "@clip/sdk";
import { buildEpisodeClosingWindow, buildEpisodeOpeningWindow, enforceEpisodeBoundaryAnchors } from "./episode-boundary-anchors.js";

export interface SegmentOrdinal {
  episodeKey: string;
  index: number;
}

export function parseSegmentOrdinal(
  segmentId: string,
  seg?: AsrSegment,
): SegmentOrdinal | null {
  const m = segmentId.match(/^(.+)_s(\d+)$/i);
  if (m) {
    return { episodeKey: m[1]!, index: Number.parseInt(m[2]!, 10) };
  }
  if (seg?.episodeId) {
    const m2 = segmentId.match(/_s(\d+)$/i) ?? segmentId.match(/s(\d+)$/i);
    if (m2) {
      return { episodeKey: seg.episodeId, index: Number.parseInt(m2[1]!, 10) };
    }
  }
  return null;
}

interface ResolvedClip {
  clip: ClipPlanClip;
  seg: AsrSegment;
  ord: SegmentOrdinal | null;
}

function clipDurationMs(clip: ClipPlanClip, seg: AsrSegment): number {
  const startMs = seg.startMs + (clip.trimStartMs ?? 0);
  const endMs = seg.endMs - (clip.trimEndMs ?? 0);
  return Math.max(0, endMs - startMs);
}

function clipTimeRange(
  clip: ClipPlanClip,
  seg: AsrSegment,
): { startMs: number; endMs: number; episodeId: string } {
  return {
    startMs: seg.startMs + (clip.trimStartMs ?? 0),
    endMs: seg.endMs - (clip.trimEndMs ?? 0),
    episodeId: seg.episodeId ?? parseSegmentOrdinal(seg.segmentId, seg)?.episodeKey ?? "default",
  };
}

function episodeKey(item: ResolvedClip): string {
  return item.ord?.episodeKey ?? item.seg.episodeId ?? "default";
}

function episodeNo(item: ResolvedClip): number {
  return item.seg.episodeNo ?? 0;
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

function assignRoles(clips: ClipPlanClip[]): ClipPlanClip[] {
  if (clips.length === 0) return clips;
  if (clips.length === 1) {
    return [{ ...clips[0]!, role: clips[0]?.role ?? "hook" }];
  }
  return clips.map((clip, idx) => ({
    ...clip,
    role:
      idx === 0
        ? "hook"
        : idx === clips.length - 1
          ? "cliff"
          : clip.role === "context"
            ? "context"
            : "escalate",
  }));
}

function normalizeTextForDedup(text: string): string {
  return text.replace(/\s+/g, "").trim().toLowerCase();
}

function textsDuplicate(a: string, b: string): boolean {
  const na = normalizeTextForDedup(a);
  const nb = normalizeTextForDedup(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  return false;
}

function isStrictlyConsecutive(items: ResolvedClip[]): boolean {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!.ord;
    const cur = items[i]!.ord;
    if (!prev || !cur) return false;
    if (prev.episodeKey !== cur.episodeKey) return false;
    if (cur.index - prev.index !== 1) return false;
  }
  return items.length > 0;
}

function splitEpisodeBlocks(resolved: ResolvedClip[]): ResolvedClip[][] {
  const blocks: ResolvedClip[][] = [];
  let current: ResolvedClip[] = [];
  let lastEp: string | null = null;

  for (const item of resolved) {
    const ep = episodeKey(item);
    if (lastEp !== null && ep !== lastEp) {
      if (current.length) blocks.push(current);
      current = [];
    }
    current.push(item);
    lastEp = ep;
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/** Drop episode blocks that would reverse episode order (e.g. ep17 → ep8). */
function filterForwardEpisodeBlocks(
  resolved: ResolvedClip[],
): { kept: ResolvedClip[]; repairs: string[] } {
  const blocks = splitEpisodeBlocks(resolved);
  const kept: ResolvedClip[] = [];
  const repairs: string[] = [];
  let lastEpNo = 0;

  for (const block of blocks) {
    const epNo = block[0]?.seg.episodeNo ?? 0;
    if (lastEpNo > 0 && epNo > 0 && epNo < lastEpNo) {
      repairs.push(
        `移除倒序集块 ep${lastEpNo}→ep${epNo}（${block[0]?.seg.segmentId ?? "?"}）`,
      );
      continue;
    }
    kept.push(...block);
    if (epNo > lastEpNo) lastEpNo = epNo;
  }

  return { kept, repairs };
}

function clipEpisodeKey(clip: ClipPlanClip, segmentMap: Map<string, AsrSegment>): string {
  const seg = segmentMap.get(clip.segmentId);
  return seg?.episodeId ?? parseSegmentOrdinal(clip.segmentId, seg)?.episodeKey ?? "default";
}

function maxEpisodeNoInClipBlocks(
  blocks: ClipPlanClip[][],
  segmentMap: Map<string, AsrSegment>,
): number {
  let max = 0;
  for (const block of blocks) {
    const seg = segmentMap.get(block[0]?.segmentId ?? "");
    const no = seg?.episodeNo ?? 0;
    if (no > max) max = no;
  }
  return max;
}

function episodeKeysInClipBlocks(
  blocks: ClipPlanClip[][],
  segmentMap: Map<string, AsrSegment>,
): Set<string> {
  const keys = new Set<string>();
  for (const block of blocks) {
    const clip = block[0];
    if (clip) keys.add(clipEpisodeKey(clip, segmentMap));
  }
  return keys;
}

function filterForwardEpisodeClips(
  clips: ClipPlanClip[],
  segmentMap: Map<string, AsrSegment>,
): { clips: ClipPlanClip[]; repairs: string[] } {
  const resolved: ResolvedClip[] = [];
  for (const clip of clips) {
    const seg = segmentMap.get(clip.segmentId);
    if (!seg) continue;
    resolved.push({ clip, seg, ord: parseSegmentOrdinal(clip.segmentId, seg) });
  }
  const { kept, repairs } = filterForwardEpisodeBlocks(resolved);
  return { clips: kept.map((r) => ({ ...r.clip })), repairs };
}

function repairEpisodeBlock(
  block: ResolvedClip[],
  episodeList: AsrSegment[],
  used: Set<string>,
  options: { maxClipCount: number; maxDurationSec: number },
): { clips: ClipPlanClip[]; repairs: string[] } {
  const repairs: string[] = [];
  const sorted = [...block].sort(
    (a, b) => (a.ord?.index ?? a.seg.startMs) - (b.ord?.index ?? b.seg.startMs),
  );

  if (isStrictlyConsecutive(sorted)) {
    return { clips: sorted.map((r) => ({ ...r.clip })), repairs };
  }

  const anchor = sorted[0]!;
  let startIdx = episodeList.findIndex((s) => s.segmentId === anchor.seg.segmentId);
  if (startIdx < 0) startIdx = 0;
  while (startIdx < episodeList.length && used.has(episodeList[startIdx]!.segmentId)) {
    startIdx += 1;
  }

  const avgSegMs =
    episodeList.length > 0
      ? episodeList.reduce((sum, s) => sum + s.endMs - s.startMs, 0) / episodeList.length
      : 4000;
  const blockClipBudget = Math.min(
    options.maxClipCount,
    Math.max(
      sorted.length,
      Math.ceil((options.maxDurationSec * 1000) / Math.max(avgSegMs, 1500)),
    ),
  );

  const built = buildContiguousWindow(episodeList, startIdx, {
    maxDurationSec: options.maxDurationSec,
    maxClipCount: blockClipBudget,
    minClips: Math.min(2, sorted.length),
    usedSegmentIds: used,
  });

  if (built) {
    repairs.push(
      `集内 seq 跳选，${episodeKey(anchor)} 从 ${built.clips[0]!.segmentId} 起连续取 ${built.clips.length} 段`,
    );
    return { clips: built.clips, repairs };
  }

  repairs.push(`集内块 ${episodeKey(anchor)} 无法修复，保留首段`);
  return { clips: [{ ...anchor.clip }], repairs };
}

/**
 * 投放混剪连贯性修复：
 * - **允许跨集**（混剪核心能力）
 * - 每个「集内块」seq 必须严格 +1；块内跳选则从块起点重取连续窗口
 * - 集序只能向前（e01→e03），禁止倒序回跳
 */
export function repairClipPlanContiguity(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    maxDurationSec?: number;
    maxClipCount?: number;
    minClips?: number;
    usedSegmentIds?: Set<string>;
    targetDurationSec?: number;
  } = {},
): { plan: ClipPlan; repairs: string[] } {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const used = options.usedSegmentIds ?? new Set<string>();
  const maxDurationSec =
    options.maxDurationSec ?? plan.output.maxDurationSec ?? plan.targetDurationSec ?? MAX_PLAN_DURATION_SEC;
  const targetDurationSec = options.targetDurationSec ?? plan.targetDurationSec ?? 0;
  const durationBudgetSec = Math.max(maxDurationSec, targetDurationSec);
  const maxClipCount = options.maxClipCount ?? 120;
  const minClips = Math.max(2, options.minClips ?? 2);
  const maxMs = durationBudgetSec * 1000;
  const repairs: string[] = [];

  const resolved = plan.clips
    .map((clip) => {
      const seg = segmentMap.get(clip.segmentId);
      if (!seg) return null;
      const ord = parseSegmentOrdinal(clip.segmentId, seg);
      return { clip, seg, ord };
    })
    .filter((x): x is ResolvedClip => x !== null);

  if (resolved.length === 0) {
    return { plan, repairs };
  }

  let blocks = splitEpisodeBlocks(resolved);

  const { kept: forwardResolved, repairs: forwardRepairs } = filterForwardEpisodeBlocks(resolved);
  repairs.push(...forwardRepairs);
  blocks = splitEpisodeBlocks(forwardResolved);

  const perBlockDuration = durationBudgetSec / Math.max(blocks.length, 1);
  const repairedClips: ClipPlanClip[] = [];

  for (const block of blocks) {
    const ep = episodeKey(block[0]!);
    const episodeList = byEpisode.get(ep) ?? [];
    const { clips: blockClips, repairs: blockRepairs } = repairEpisodeBlock(block, episodeList, used, {
      maxClipCount: maxClipCount - repairedClips.length,
      maxDurationSec: perBlockDuration,
    });
    repairs.push(...blockRepairs);
    repairedClips.push(...blockClips);
    if (repairedClips.length >= maxClipCount) break;
  }

  let clips = assignRoles(repairedClips.slice(0, maxClipCount));
  let totalMs = clips.reduce((sum, c) => {
    const seg = segmentMap.get(c.segmentId);
    return seg ? sum + clipDurationMs(c, seg) : sum;
  }, 0);

  while (clips.length > minClips && totalMs > maxMs) {
    const removed = clips.pop();
    totalMs = clips.reduce((sum, c) => {
      const seg = segmentMap.get(c.segmentId);
      return seg ? sum + clipDurationMs(c, seg) : sum;
    }, 0);
    repairs.push(`时长超限，移除末尾 ${removed?.segmentId ?? "?"}`);
    clips = assignRoles(clips);
  }

  const sanitized = sanitizePlanClips(
    {
      ...plan,
      clips,
      estimatedDurationSec: Math.max(1, Math.ceil(totalMs / 1000)),
    },
    segments,
  );
  repairs.push(...sanitized.repairs);

  return {
    plan: sanitized.plan,
    repairs,
  };
}

/** 渲染前清理：id 去重 + 时间轴重叠 + 重复台词 */
export function sanitizePlanClips(
  plan: ClipPlan,
  segments: AsrSegment[],
): { plan: ClipPlan; repairs: string[] } {
  return finalizePlanClips(plan, segments);
}

function finalizePlanClips(plan: ClipPlan, segments: AsrSegment[]): { plan: ClipPlan; repairs: string[] } {
  let current = plan;
  const allRepairs: string[] = [];

  const deduped = dedupePlanClipIds(current);
  if (deduped.repairs.length) {
    allRepairs.push(...deduped.repairs);
    current = deduped.plan;
  }

  const epBlocks = removeDuplicateEpisodeBlocks(current, segments);
  if (epBlocks.repairs.length) {
    allRepairs.push(...epBlocks.repairs);
    current = epBlocks.plan;
  }

  const timeline = removePlanTimelineAndTextDuplicates(current, segments);
  if (timeline.repairs.length) {
    allRepairs.push(...timeline.repairs);
    current = timeline.plan;
  }

  return { plan: current, repairs: allRepairs };
}

export function contiguityWarnings(
  plan: ClipPlan,
  segments: AsrSegment[],
): string[] {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const warnings: string[] = [];
  let prev: { ord: SegmentOrdinal; seg: AsrSegment; episodeNo: number } | null = null;

  for (const clip of plan.clips) {
    const seg = segmentMap.get(clip.segmentId);
    if (!seg) continue;
    const ord = parseSegmentOrdinal(clip.segmentId, seg);
    if (!ord) continue;

    if (prev) {
      if (prev.ord.episodeKey !== ord.episodeKey) {
        const epNo = seg.episodeNo ?? 0;
        if (epNo > 0 && prev.episodeNo > 0) {
          if (epNo < prev.episodeNo) {
            warnings.push(`${prev.seg.segmentId}→${clip.segmentId} 集序倒跳（ep${prev.episodeNo}→ep${epNo}）`);
          } else if (epNo - prev.episodeNo > 1) {
            warnings.push(
              `${prev.seg.segmentId}→${clip.segmentId} 隔集跳戏（ep${prev.episodeNo}→ep${epNo}，隔 ${epNo - prev.episodeNo - 1} 集，必须相邻）`,
            );
          }
        }
      } else if (ord.index - prev.ord.index !== 1) {
        warnings.push(
          `${prev.seg.segmentId}→${clip.segmentId} 集内 seq 不连续（差 ${ord.index - prev.ord.index}）`,
        );
      }
    }
    prev = { ord, seg, episodeNo: seg.episodeNo ?? 0 };
  }
  return warnings;
}

export function collectSegmentIdsFromPlans(plans: ClipPlan[]): Set<string> {
  const used = new Set<string>();
  for (const plan of plans) {
    for (const clip of plan.clips) used.add(clip.segmentId);
  }
  return used;
}

export function planUsesAnySegment(plan: ClipPlan, used: Set<string>): boolean {
  return plan.clips.some((c) => used.has(c.segmentId));
}

/** 同一 plan 内同一集只能出现一次（一个连续块）；第二次出现的该集 clips 全部移除 */
export function removeDuplicateEpisodeBlocks(
  plan: ClipPlan,
  segments: AsrSegment[],
): { plan: ClipPlan; repairs: string[] } {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const repairs: string[] = [];
  const kept: ClipPlanClip[] = [];
  const finishedEps = new Set<string>();
  let currentEp: string | null = null;

  for (const clip of plan.clips) {
    const seg = segmentMap.get(clip.segmentId);
    const ep =
      seg?.episodeId ??
      parseSegmentOrdinal(clip.segmentId, seg)?.episodeKey ??
      "default";

    if (currentEp !== null && ep !== currentEp) {
      finishedEps.add(currentEp);
    }
    currentEp = ep;

    if (finishedEps.has(ep)) {
      repairs.push(`移除重复集 ${ep} 片段 ${clip.segmentId}（该集已在前面出现过）`);
      continue;
    }
    kept.push(clip);
  }

  if (repairs.length === 0) return { plan, repairs };

  return {
    plan: {
      ...plan,
      clips: assignRoles(kept),
    },
    repairs,
  };
}

/** 同一 plan 内 segmentId 不可出现两次（保留首次出现） */
export function dedupePlanClipIds(plan: ClipPlan): { plan: ClipPlan; repairs: string[] } {
  const repairs: string[] = [];
  const seen = new Set<string>();
  const clips: ClipPlanClip[] = [];

  for (const clip of plan.clips) {
    if (seen.has(clip.segmentId)) {
      repairs.push(`移除 plan 内重复 segmentId ${clip.segmentId}`);
      continue;
    }
    seen.add(clip.segmentId);
    clips.push(clip);
  }

  if (repairs.length === 0) return { plan, repairs };

  return {
    plan: {
      ...plan,
      clips: assignRoles(clips),
    },
    repairs,
  };
}

/**
 * 去除 plan 内重复内容：时间轴重叠（ASR 切分常见）或台词高度重复（同剧情播两遍）
 */
export function removePlanTimelineAndTextDuplicates(
  plan: ClipPlan,
  segments: AsrSegment[],
  overlapToleranceMs = 300,
): { plan: ClipPlan; repairs: string[] } {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const repairs: string[] = [];
  const kept: ClipPlanClip[] = [];
  const keptRanges: Array<{ startMs: number; endMs: number; episodeId: string }> = [];
  const keptTexts: string[] = [];

  for (const clip of plan.clips) {
    const seg = segmentMap.get(clip.segmentId);
    if (!seg) {
      kept.push(clip);
      continue;
    }

    const range = clipTimeRange(clip, seg);
    const overlapsTimeline = keptRanges.some(
      (prev) =>
        prev.episodeId === range.episodeId &&
        range.startMs < prev.endMs - overlapToleranceMs &&
        range.endMs > prev.startMs + overlapToleranceMs,
    );
    if (overlapsTimeline) {
      repairs.push(`移除时间重叠片段 ${clip.segmentId}（避免同一句话/同一场戏播两遍）`);
      continue;
    }

    const duplicateText = keptTexts.some((text) => textsDuplicate(text, seg.text));
    if (duplicateText) {
      repairs.push(`移除台词重复片段 ${clip.segmentId}`);
      continue;
    }

    kept.push(clip);
    keptRanges.push(range);
    keptTexts.push(seg.text);
  }

  if (repairs.length === 0) return { plan, repairs };

  return {
    plan: {
      ...plan,
      clips: assignRoles(kept),
    },
    repairs,
  };
}

/** @deprecated 使用 removePlanTimelineAndTextDuplicates */
export function removeAdjacentTimeOverlap(
  plan: ClipPlan,
  segments: AsrSegment[],
  overlapToleranceMs = 300,
): { plan: ClipPlan; repairs: string[] } {
  return removePlanTimelineAndTextDuplicates(plan, segments, overlapToleranceMs);
}

export interface ContiguousWindowOptions {
  maxDurationSec?: number;
  maxClipCount?: number;
  minClips?: number;
  usedSegmentIds?: Set<string>;
  /** 达到 maxDurationSec 的该比例后提前停止（仅短窗口场景）；长混剪不传 */
  earlyStopRatio?: number;
}

/** 从某集 timeline 的 startIdx 起取一段连续、且不与 used 重叠的窗口 */
export function buildContiguousWindow(
  episodeList: AsrSegment[],
  startIdx: number,
  options: ContiguousWindowOptions = {},
): { clips: ClipPlanClip[]; totalMs: number } | null {
  const maxDurationSec = options.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  const maxClipCount = options.maxClipCount ?? 120;
  const minClips = Math.max(1, options.minClips ?? 2);
  const used = options.usedSegmentIds ?? new Set<string>();
  const maxMs = maxDurationSec * 1000;
  const earlyStopMs =
    options.earlyStopRatio != null
      ? maxMs * options.earlyStopRatio
      : maxDurationSec <= 300
        ? maxMs * 0.55
        : undefined;

  if (used.has(episodeList[startIdx]?.segmentId ?? "")) return null;

  const clips: ClipPlanClip[] = [];
  let totalMs = 0;

  for (let i = startIdx; i < episodeList.length && clips.length < maxClipCount; i++) {
    const seg = episodeList[i]!;
    if (used.has(seg.segmentId)) break;
    const dur = seg.endMs - seg.startMs;
    if (totalMs + dur > maxMs && clips.length >= minClips) break;
    clips.push({
      segmentId: seg.segmentId,
      reason: clips.length === 0 ? "连续区间起点" : "连续台词",
      role: undefined,
    });
    totalMs += dur;
    if (earlyStopMs != null && totalMs >= earlyStopMs && clips.length >= minClips) break;
  }

  if (clips.length < minClips) return null;
  return { clips: assignRoles(clips), totalMs };
}

/** 为 plan 在同集找一段未使用的连续窗口 */
export function relocatePlanAvoidingUsed(
  plan: ClipPlan,
  segments: AsrSegment[],
  used: Set<string>,
  options: ContiguousWindowOptions = {},
): { plan: ClipPlan; repairs: string[] } | null {
  if (!planUsesAnySegment(plan, used)) return null;

  const byEpisode = segmentsByEpisode(segments);
  const preferredEp =
    plan.clips
      .map((c) => segments.find((s) => s.segmentId === c.segmentId)?.episodeId)
      .find(Boolean) ?? [...byEpisode.keys()][0];

  const episodeKeys = preferredEp
    ? [preferredEp, ...[...byEpisode.keys()].filter((k) => k !== preferredEp)]
    : [...byEpisode.keys()];

  for (const epKey of episodeKeys) {
    const list = byEpisode.get(epKey) ?? [];
    for (let start = 0; start < list.length; start++) {
      const built = buildContiguousWindow(list, start, { ...options, usedSegmentIds: used });
      if (!built) continue;
      return {
        plan: {
          ...plan,
          clips: built.clips,
          estimatedDurationSec: Math.max(1, Math.ceil(built.totalMs / 1000)),
        },
        repairs: [`片段已占用，改选 ${epKey} 连续窗口 ${built.clips[0]!.segmentId}~${built.clips.at(-1)!.segmentId}`],
      };
    }
  }
  return null;
}

/** 跨集混剪：从前集取 hook 连续块 + 后集取 cliff 连续块（hook/cliff 必须不同集） */
export function buildCrossEpisodeMixWindow(
  segments: AsrSegment[],
  options: {
    hookEpisodeStartIdx?: number;
    hookEpisodeId?: string;
    cliffEpisodeId?: string;
    excludeEpisodeIds?: string[];
    maxDurationSec?: number;
    maxClipCount?: number;
    usedSegmentIds?: Set<string>;
  } = {},
): { clips: ClipPlanClip[]; totalMs: number; narrativeHint: string } | null {
  const byEpisode = segmentsByEpisode(segments);
  const exclude = new Set(options.excludeEpisodeIds ?? []);
  const episodeEntries = [...byEpisode.entries()]
    .filter(([ep]) => !exclude.has(ep))
    .sort((a, b) => (a[1][0]?.episodeNo ?? 0) - (b[1][0]?.episodeNo ?? 0));
  if (episodeEntries.length < 2) return null;

  const maxDurationSec = options.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  const maxClipCount = options.maxClipCount ?? 120;
  const used = options.usedSegmentIds ?? new Set<string>();

  const hookEpId = options.hookEpisodeId ?? episodeEntries[0]![0];
  let cliffEpId = options.cliffEpisodeId;
  if (!cliffEpId || cliffEpId === hookEpId) {
    const hookNo = byEpisode.get(hookEpId)?.[0]?.episodeNo ?? 0;
    cliffEpId =
      episodeEntries.find(([ep, list]) => ep !== hookEpId && (list[0]?.episodeNo ?? 0) > hookNo)?.[0] ??
      episodeEntries.at(-1)![0];
  }
  if (cliffEpId === hookEpId) return null;

  const hookList = byEpisode.get(hookEpId) ?? [];
  const cliffList = byEpisode.get(cliffEpId) ?? [];
  if (!hookList.length || !cliffList.length) return null;

  const hookWindow = buildEpisodeOpeningWindow(hookList, {
    maxDurationSec: maxDurationSec * 0.65,
    maxClipCount: Math.max(2, Math.floor(maxClipCount * 0.6)),
    minClips: 2,
    usedSegmentIds: used,
  });
  if (!hookWindow) return null;

  const cliffWindow = buildEpisodeClosingWindow(cliffList, {
    maxDurationSec: maxDurationSec * 0.4,
    maxClipCount: Math.max(1, maxClipCount - hookWindow.clips.length),
    minClips: 1,
    usedSegmentIds: new Set([...used, ...hookWindow.clips.map((c) => c.segmentId)]),
  });
  if (!cliffWindow) {
    return {
      clips: assignRoles(hookWindow.clips),
      totalMs: hookWindow.totalMs,
      narrativeHint: `${hookEpId} 连续冲突`,
    };
  }

  const clips = assignRoles([...hookWindow.clips, ...cliffWindow.clips]);
  const totalMs = hookWindow.totalMs + cliffWindow.totalMs;
  return {
    clips,
    totalMs,
    narrativeHint: `${hookEpId} 起冲突 → ${cliffEpId} 悬念截断`,
  };
}

/** 轮换 hook/cliff 集数，挑选满足最短时长的跨集窗口（混剪兜底用） */
export function pickCrossEpisodeMixWindow(
  segments: AsrSegment[],
  options: {
    hookEpisodeStartIdx?: number;
    hookEpisodeId?: string;
    cliffEpisodeId?: string;
    excludeEpisodeIds?: string[];
    maxDurationSec?: number;
    maxClipCount?: number;
    usedSegmentIds?: Set<string>;
    minDurationSec?: number;
    variantIndex?: number;
    maxAttempts?: number;
  } = {},
): { clips: ClipPlanClip[]; totalMs: number; narrativeHint: string } | null {
  const minDurationSec = options.minDurationSec ?? MIN_PLAN_DURATION_SEC;
  const minMs = minDurationSec * 1000;
  const byEpisode = segmentsByEpisode(segments);
  const exclude = new Set(options.excludeEpisodeIds ?? []);
  const episodeEntries = [...byEpisode.entries()]
    .filter(([ep]) => !exclude.has(ep))
    .sort((a, b) => (a[1][0]?.episodeNo ?? 0) - (b[1][0]?.episodeNo ?? 0));
  if (episodeEntries.length < 2) return null;

  const maxAttempts = Math.min(
    options.maxAttempts ?? episodeEntries.length * (episodeEntries.length - 1),
    episodeEntries.length * Math.max(1, episodeEntries.length - 1),
  );
  const start = options.variantIndex ?? 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hookIdx = (start + attempt) % Math.max(1, episodeEntries.length - 1);
    for (let cliffIdx = hookIdx + 1; cliffIdx < episodeEntries.length; cliffIdx++) {
      const hookEpId = episodeEntries[hookIdx]![0];
      const cliffEpId = episodeEntries[cliffIdx]![0];
      const built = buildCrossEpisodeMixWindow(segments, {
        ...options,
        hookEpisodeId: hookEpId,
        cliffEpisodeId: cliffEpId,
      });
      if (built && built.totalMs >= minMs) return built;
    }
  }
  return null;
}

/** 混剪成片最短时长（秒）—— 不低于 2 分钟（底线，非首选） */
export const MIN_PLAN_DURATION_SEC = 120;

/** 混剪成片首选目标时长（秒）—— 约 10 分钟 */
export const PREFERRED_PLAN_DURATION_SEC = 600;

/** 混剪成片最长时长（秒）—— 不超过 20 分钟 */
export const MAX_PLAN_DURATION_SEC = 1200;

/** 混剪时长档：min=底线，target=扩展目标，maxPlanClips=补段上限 */
export const DURATION_TIER_SPEC: Record<
  "S" | "M" | "L" | "XL",
  { minSec: number; maxSec: number; targetSec: number; maxPlanClips: number }
> = {
  S: { minSec: 120, maxSec: 240, targetSec: 180, maxPlanClips: 60 },
  M: { minSec: 301, maxSec: 660, targetSec: 600, maxPlanClips: 90 },
  L: { minSec: 480, maxSec: 720, targetSec: 600, maxPlanClips: 80 },
  XL: { minSec: 721, maxSec: 900, targetSec: 780, maxPlanClips: 100 },
};

/** 批次档位轮转：优先 M/L（~10 分钟），S 仅末位作 occasional teaser */
export const BATCH_DURATION_TIERS: Array<"S" | "M" | "L" | "XL"> = [
  "M",
  "L",
  "M",
  "L",
  "S",
];

export function tierTargetDurationSec(tier: ClipPlan["durationTier"]): number {
  if (!tier) return DURATION_TIER_SPEC.M.targetSec;
  return DURATION_TIER_SPEC[tier].targetSec;
}

export function tierExpandClipLimit(tier: ClipPlan["durationTier"]): number {
  if (!tier) return DURATION_TIER_SPEC.M.maxPlanClips;
  return DURATION_TIER_SPEC[tier].maxPlanClips;
}

/**
 * 扩展 plan 至目标时长：先保证 ≥minDurationSec，再尽量接近 targetDurationSec
 */
export function expandPlanToDuration(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    minDurationSec?: number;
    targetDurationSec?: number;
    maxClipCount?: number;
    expandClipHardLimit?: number;
    maxDurationSec?: number;
  } = {},
): { plan: ClipPlan; repairs: string[] } {
  const minDurationSec = options.minDurationSec ?? MIN_PLAN_DURATION_SEC;
  const targetDurationSec = Math.max(
    minDurationSec,
    options.targetDurationSec ?? minDurationSec,
  );
  const maxClipCount = options.maxClipCount ?? 120;
  const expandClipHardLimit = Math.min(
    200,
    options.expandClipHardLimit ?? Math.max(maxClipCount, 60),
  );
  const maxDurationSec = options.maxDurationSec ?? plan.output.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  const goalMs = Math.min(targetDurationSec * 1000, maxDurationSec * 1000);
  const minMs = minDurationSec * 1000;
  const maxMs = maxDurationSec * 1000;

  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const repairs: string[] = [];

  const blocks: ClipPlanClip[][] = [];
  let current: ClipPlanClip[] = [];
  let lastEp: string | null = null;

  for (const clip of plan.clips) {
    const seg = segmentMap.get(clip.segmentId);
    const ep =
      seg?.episodeId ?? parseSegmentOrdinal(clip.segmentId, seg)?.episodeKey ?? "default";
    if (lastEp !== null && ep !== lastEp) {
      blocks.push(current);
      current = [];
    }
    current.push({ ...clip });
    lastEp = ep;
  }
  if (current.length) blocks.push(current);

  const allIds = () => new Set(blocks.flat().map((c) => c.segmentId));
  const totalMs = () =>
    blocks.flat().reduce((sum, c) => {
      const seg = segmentMap.get(c.segmentId);
      return seg ? sum + clipDurationMs(c, seg) : sum;
    }, 0);

  if (totalMs() >= goalMs) return { plan, repairs };

  let safety = expandClipHardLimit * 3;
  while (totalMs() < goalMs && blocks.flat().length < expandClipHardLimit && safety-- > 0) {
    let added = false;
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const block = blocks[bi]!;
      const epKey =
        segmentMap.get(block[0]!.segmentId)?.episodeId ??
        parseSegmentOrdinal(block[0]!.segmentId, segmentMap.get(block[0]!.segmentId))?.episodeKey ??
        "default";
      const epList = byEpisode.get(epKey) ?? [];

      const lastClip = block.at(-1)!;
      const lastSeg = segmentMap.get(lastClip.segmentId);
      if (lastSeg) {
        const lastIdx = epList.findIndex((s) => s.segmentId === lastClip.segmentId);
        if (lastIdx >= 0 && lastIdx < epList.length - 1) {
          const nextSeg = epList[lastIdx + 1]!;
          const nextDur = nextSeg.endMs - nextSeg.startMs;
          if (!allIds().has(nextSeg.segmentId) && totalMs() + nextDur <= maxMs) {
            block.push({
              segmentId: nextSeg.segmentId,
              role: "escalate",
              reason: "补时长：同集向后承接",
            });
            repairs.push(`补段 ${nextSeg.segmentId}（向后）`);
            added = true;
            break;
          }
        }
      }

      const firstClip = block[0]!;
      const firstSeg = segmentMap.get(firstClip.segmentId);
      if (firstSeg) {
        const firstIdx = epList.findIndex((s) => s.segmentId === firstClip.segmentId);
        if (firstIdx > 0) {
          const prevSeg = epList[firstIdx - 1]!;
          const prevDur = prevSeg.endMs - prevSeg.startMs;
          if (!allIds().has(prevSeg.segmentId) && totalMs() + prevDur <= maxMs) {
            block.unshift({
              segmentId: prevSeg.segmentId,
              role: "escalate",
              reason: "补时长：同集向前承接",
            });
            repairs.push(`补段 ${prevSeg.segmentId}（向前）`);
            added = true;
            break;
          }
        }
      }
    }
    if (!added) break;
  }

  while (totalMs() < goalMs && blocks.flat().length < expandClipHardLimit) {
    const remainingMs = Math.min(goalMs - totalMs(), maxMs - totalMs());
    if (remainingMs <= 0) break;
    const window = findBestUnusedEpisodeWindow(
      byEpisode,
      allIds(),
      remainingMs,
      expandClipHardLimit - blocks.flat().length,
      {
        minEpisodeNo: maxEpisodeNoInClipBlocks(blocks, segmentMap),
        excludeEpisodeKeys: episodeKeysInClipBlocks(blocks, segmentMap),
      },
    );
    if (!window) break;
    blocks.push(window.clips);
    repairs.push(
      `跨集补块 ${window.epKey} ${window.clips[0]!.segmentId}~${window.clips.at(-1)!.segmentId}（+${Math.round(window.totalMs / 1000)}s）`,
    );
  }

  if (repairs.length === 0) return { plan, repairs };

  const flat = assignRoles(blocks.flat().slice(0, expandClipHardLimit));
  const { clips: forwardClips, repairs: orderRepairs } = filterForwardEpisodeClips(flat, segmentMap);
  repairs.push(...orderRepairs);
  const durationSec = computePlanDurationSecFromClips(forwardClips, segments);
  return {
    plan: {
      ...plan,
      clips: forwardClips,
      estimatedDurationSec: durationSec,
      targetDurationSec: Math.max(durationSec, targetDurationSec),
    },
    repairs,
  };
}

/** 当仅需补至最短时长时使用 */
export function expandPlanToMinDuration(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    minDurationSec?: number;
    maxClipCount?: number;
    expandClipHardLimit?: number;
    maxDurationSec?: number;
  } = {},
): { plan: ClipPlan; repairs: string[] } {
  const minDurationSec = options.minDurationSec ?? MIN_PLAN_DURATION_SEC;
  return expandPlanToDuration(plan, segments, {
    ...options,
    targetDurationSec: minDurationSec,
  });
}

/** 将 LLM 输出的块级合并（throughSegmentId / 首尾锚点）展开为完整连续 clips */
export function expandClipBlockRanges(
  plan: ClipPlan,
  segments: AsrSegment[],
): { plan: ClipPlan; repairs: string[] } {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const repairs: string[] = [];
  const expanded: ClipPlanClip[] = [];

  const sliceEpisodeBlock = (
    episodeKey: string,
    startId: string,
    endId: string,
  ): AsrSegment[] | null => {
    const list = byEpisode.get(episodeKey) ?? [];
    const startIdx = list.findIndex((s) => s.segmentId === startId);
    const endIdx = list.findIndex((s) => s.segmentId === endId);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return null;
    return list.slice(startIdx, endIdx + 1);
  };

  const roleForExpandedSegment = (
    index: number,
    blockLen: number,
    head: ClipPlanClip,
    tail?: ClipPlanClip,
  ): ClipPlanClip["role"] => {
    if (blockLen === 1) return tail?.role ?? head.role;
    if (index === 0) {
      return head.role === "cliff" ? "escalate" : (head.role ?? "hook");
    }
    if (index === blockLen - 1) {
      return tail?.role ?? (head.role === "cliff" ? "cliff" : "escalate");
    }
    return "escalate";
  };

  const pushBlock = (
    block: AsrSegment[],
    head: ClipPlanClip,
    tail?: ClipPlanClip,
  ) => {
    for (let i = 0; i < block.length; i++) {
      const isFirst = i === 0;
      const isLast = i === block.length - 1;
      expanded.push({
        segmentId: block[i]!.segmentId,
        role: roleForExpandedSegment(i, block.length, head, tail),
        reason: isFirst
          ? head.reason
          : isLast
            ? (tail?.reason ?? "块内连续承接")
            : "块内连续承接",
      });
    }
  };

  for (let i = 0; i < plan.clips.length; i++) {
    const clip = plan.clips[i]!;
    const through = clip.throughSegmentId?.trim();

    if (through && through !== clip.segmentId) {
      const startSeg = segmentMap.get(clip.segmentId);
      const endSeg = segmentMap.get(through);
      if (!startSeg || !endSeg) {
        expanded.push(clip);
        continue;
      }
      const ep =
        startSeg.episodeId ??
        parseSegmentOrdinal(clip.segmentId, startSeg)?.episodeKey ??
        "default";
      const epEnd =
        endSeg.episodeId ?? parseSegmentOrdinal(through, endSeg)?.episodeKey ?? "default";
      if (ep !== epEnd) {
        repairs.push(`${clip.segmentId}~${through} 跨集 throughSegmentId 无效，保留首段`);
        expanded.push(clip);
        continue;
      }
      const block = sliceEpisodeBlock(ep, clip.segmentId, through);
      if (!block?.length) {
        expanded.push(clip);
        continue;
      }
      repairs.push(`LLM 块合并 ${clip.segmentId}~${through} → ${block.length} 段`);
      pushBlock(block, clip);
      continue;
    }

    const next = plan.clips[i + 1];
    if (next && !next.throughSegmentId) {
      const curSeg = segmentMap.get(clip.segmentId);
      const nextSeg = segmentMap.get(next.segmentId);
      const curOrd = parseSegmentOrdinal(clip.segmentId, curSeg);
      const nextOrd = parseSegmentOrdinal(next.segmentId, nextSeg);
      if (
        curOrd &&
        nextOrd &&
        curOrd.episodeKey === nextOrd.episodeKey &&
        nextOrd.index - curOrd.index > 1
      ) {
        const block = sliceEpisodeBlock(curOrd.episodeKey, clip.segmentId, next.segmentId);
        if (block && block.length > 2) {
          repairs.push(
            `LLM 块锚点 ${clip.segmentId}~${next.segmentId} → ${block.length} 段`,
          );
          pushBlock(block, clip, next);
          i += 1;
          continue;
        }
      }
    }

    expanded.push(clip);
  }

  return {
    plan: {
      ...plan,
      clips: expanded,
      estimatedDurationSec: computePlanDurationSecFromClips(expanded, segments),
    },
    repairs,
  };
}

/** API / Agent 统一的混剪 plan 后处理：去重 → 集内 seq 修复 → 可选补至档位目标时长 */
export function finalizeMixPlanForRender(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    maxDurationSec?: number;
    maxClipCount?: number;
    minDurationSec?: number;
    minClips?: number;
    targetDurationSec?: number;
    durationTier?: ClipPlan["durationTier"];
    /** soft 模式下跳过为凑时长而扩段 */
    skipDurationExpand?: boolean;
  } = {},
): { plan: ClipPlan; repairs: string[] } {
  const maxDurationSec =
    options.maxDurationSec ?? plan.output.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  const maxClipCount = options.maxClipCount ?? 120;
  const minDurationSec = options.minDurationSec ?? MIN_PLAN_DURATION_SEC;
  const minClips = Math.max(2, options.minClips ?? 2);
  const tier = options.durationTier ?? plan.durationTier;
  const targetDurationSec =
    options.targetDurationSec ??
    plan.targetDurationSec ??
    (tier ? DURATION_TIER_SPEC[tier].targetSec : minDurationSec);
  const expandClipHardLimit = tier
    ? DURATION_TIER_SPEC[tier].maxPlanClips
    : Math.max(maxClipCount, 14);
  const allRepairs: string[] = [];

  const { plan: blockExpanded, repairs: blockRepairs } = expandClipBlockRanges(plan, segments);
  allRepairs.push(...blockRepairs);
  let current = blockExpanded;

  const { plan: contiguous, repairs: contiguityRepairs } = repairClipPlanContiguity(
    current,
    segments,
    {
      maxDurationSec,
      maxClipCount,
      minClips,
      targetDurationSec,
    },
  );
  allRepairs.push(...contiguityRepairs);
  current = contiguous;

  if (!options.skipDurationExpand) {
    const { plan: expanded, repairs: expandRepairs } = expandPlanToDuration(current, segments, {
      minDurationSec,
      targetDurationSec,
      maxClipCount,
      maxDurationSec,
      expandClipHardLimit,
    });
    allRepairs.push(...expandRepairs);
    current = expanded;
  }

  const { plan: anchored, repairs: anchorRepairs } = enforceEpisodeBoundaryAnchors(current, segments);
  allRepairs.push(...anchorRepairs);
  current = anchored;

  current.estimatedDurationSec = computePlanDurationSecFromClips(current.clips, segments);
  current.targetDurationSec = targetDurationSec;
  if (tier) current.durationTier = tier;

  return { plan: current, repairs: allRepairs };
}

function findBestUnusedEpisodeWindow(
  byEpisode: Map<string, AsrSegment[]>,
  used: Set<string>,
  maxAddMs: number,
  maxClips: number,
  options: {
    /** Only consider episodes with episodeNo >= this value (forward-only padding). */
    minEpisodeNo?: number;
    /** Skip episodes already present in the plan (avoid duplicate episode blocks). */
    excludeEpisodeKeys?: Set<string>;
  } = {},
): { clips: ClipPlanClip[]; totalMs: number; epKey: string } | null {
  if (maxAddMs <= 0 || maxClips <= 0) return null;

  let best: { clips: ClipPlanClip[]; totalMs: number; epKey: string } | null = null;

  for (const [epKey, epList] of byEpisode) {
    if (options.excludeEpisodeKeys?.has(epKey)) continue;
    const epNo = epList[0]?.episodeNo ?? 0;
    if (
      options.minEpisodeNo != null &&
      options.minEpisodeNo > 0 &&
      epNo > 0 &&
      epNo < options.minEpisodeNo
    ) {
      continue;
    }

    let runStart = -1;
    for (let i = 0; i <= epList.length; i++) {
      const seg = epList[i];
      const usable = seg && !used.has(seg.segmentId);
      if (usable && runStart < 0) runStart = i;
      if ((!usable || i === epList.length) && runStart >= 0) {
        const run = epList.slice(runStart, i);
        let totalMs = 0;
        const clips: ClipPlanClip[] = [];
        for (const s of run) {
          const dur = s.endMs - s.startMs;
          if (totalMs + dur > maxAddMs && clips.length > 0) break;
          if (clips.length >= maxClips) break;
          clips.push({
            segmentId: s.segmentId,
            role: "escalate",
            reason: "补时长：跨集填充",
          });
          totalMs += dur;
        }
        if (clips.length >= 2 && totalMs > (best?.totalMs ?? 0)) {
          best = { clips: assignRoles(clips), totalMs, epKey };
        }
        runStart = -1;
      }
    }
  }

  return best;
}

function computePlanDurationSecFromClips(
  clips: ClipPlanClip[],
  segments: AsrSegment[],
): number {
  const map = new Map(segments.map((s) => [s.segmentId, s]));
  let ms = 0;
  for (const clip of clips) {
    const seg = map.get(clip.segmentId);
    if (!seg) continue;
    ms += clipDurationMs(clip, seg);
  }
  return Math.max(1, Math.ceil(ms / 1000));
}
