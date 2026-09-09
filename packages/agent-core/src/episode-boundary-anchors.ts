import type { AsrSegment, ClipPlan, ClipPlanClip } from "@clip/sdk";
import {
  parseSegmentOrdinal,
  type ContiguousWindowOptions,
} from "./clip-plan-coherence.js";

/** 片头/片尾锚定：允许偏离集首/集尾的 segment 数（含该值） */
export const EPISODE_BOUNDARY_INDEX_TOLERANCE = 2;

/** 单集片头/片尾窗口默认最长秒数 */
export const DEFAULT_OPENING_WINDOW_SEC = 90;
export const DEFAULT_CLOSING_WINDOW_SEC = 90;

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

function segmentIndexInEpisode(segmentId: string, episodeList: AsrSegment[]): number {
  const idx = episodeList.findIndex((s) => s.segmentId === segmentId);
  return idx >= 0 ? idx : -1;
}

function episodeKeyForClip(clip: ClipPlanClip, segmentMap: Map<string, AsrSegment>): string {
  const seg = segmentMap.get(clip.segmentId);
  return seg?.episodeId ?? parseSegmentOrdinal(clip.segmentId, seg)?.episodeKey ?? "default";
}

function splitClipsIntoEpisodeBlocks(
  clips: ClipPlanClip[],
  segmentMap: Map<string, AsrSegment>,
): ClipPlanClip[][] {
  const blocks: ClipPlanClip[][] = [];
  let current: ClipPlanClip[] = [];
  let lastEp: string | null = null;

  for (const clip of clips) {
    const ep = episodeKeyForClip(clip, segmentMap);
    if (lastEp !== null && ep !== lastEp) {
      if (current.length) blocks.push(current);
      current = [];
    }
    current.push(clip);
    lastEp = ep;
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function assignBoundaryRoles(clips: ClipPlanClip[]): ClipPlanClip[] {
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

export function isNearEpisodeStart(
  block: ClipPlanClip[],
  episodeList: AsrSegment[],
  tolerance = EPISODE_BOUNDARY_INDEX_TOLERANCE,
): boolean {
  if (!block.length || !episodeList.length) return false;
  const firstIdx = segmentIndexInEpisode(block[0]!.segmentId, episodeList);
  if (firstIdx < 0) return false;
  const maxIdx = Math.max(tolerance, Math.floor(episodeList.length * 0.08));
  return firstIdx <= maxIdx;
}

export function isNearEpisodeEnd(
  block: ClipPlanClip[],
  episodeList: AsrSegment[],
  tolerance = EPISODE_BOUNDARY_INDEX_TOLERANCE,
): boolean {
  if (!block.length || !episodeList.length) return false;
  const lastIdx = segmentIndexInEpisode(block.at(-1)!.segmentId, episodeList);
  if (lastIdx < 0) return false;
  const minIdx = Math.max(0, episodeList.length - 1 - Math.max(tolerance, Math.floor(episodeList.length * 0.08)));
  return lastIdx >= minIdx;
}

/** 集首/集尾窗口内允许的最大 segment 间隔（超过视为已离开片头/片尾区） */
const EPISODE_BOUNDARY_MAX_GAP_MS = 15_000;

/** 从集首取连续窗口（跳过 used；遇大间隔停止，避免把中后段算进片头） */
export function buildEpisodeOpeningWindow(
  episodeList: AsrSegment[],
  options: ContiguousWindowOptions = {},
): { clips: ClipPlanClip[]; totalMs: number } | null {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_OPENING_WINDOW_SEC;
  const maxClipCount = options.maxClipCount ?? 40;
  const minClips = Math.max(1, options.minClips ?? 1);
  const used = options.usedSegmentIds ?? new Set<string>();
  const maxMs = maxDurationSec * 1000;

  let startIdx = 0;
  while (startIdx < episodeList.length && used.has(episodeList[startIdx]!.segmentId)) {
    startIdx += 1;
  }
  if (startIdx >= episodeList.length) return null;

  const clips: ClipPlanClip[] = [];
  let totalMs = 0;

  for (let i = startIdx; i < episodeList.length && clips.length < maxClipCount; i++) {
    const seg = episodeList[i]!;
    if (used.has(seg.segmentId)) break;
    if (i > startIdx) {
      const prev = episodeList[i - 1]!;
      if (seg.startMs - prev.endMs > EPISODE_BOUNDARY_MAX_GAP_MS) break;
    }
    const dur = seg.endMs - seg.startMs;
    if (totalMs + dur > maxMs && clips.length >= minClips) break;
    clips.push({
      segmentId: seg.segmentId,
      reason: clips.length === 0 ? "集首连续区间" : "集首承接",
      role: undefined,
    });
    totalMs += dur;
  }

  if (clips.length < minClips) return null;
  return { clips: assignBoundaryRoles(clips), totalMs };
}

/** 从集尾向前取连续窗口，保证最后一段贴近该集结尾 */
export function buildEpisodeClosingWindow(
  episodeList: AsrSegment[],
  options: ContiguousWindowOptions = {},
): { clips: ClipPlanClip[]; totalMs: number } | null {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_CLOSING_WINDOW_SEC;
  const maxClipCount = options.maxClipCount ?? 40;
  const minClips = Math.max(1, options.minClips ?? 1);
  const used = options.usedSegmentIds ?? new Set<string>();
  const maxMs = maxDurationSec * 1000;

  let endIdx = episodeList.length - 1;
  while (endIdx >= 0 && used.has(episodeList[endIdx]!.segmentId)) {
    endIdx -= 1;
  }
  if (endIdx < 0) return null;

  const clips: ClipPlanClip[] = [];
  let totalMs = 0;

  for (let i = endIdx; i >= 0 && clips.length < maxClipCount; i--) {
    const seg = episodeList[i]!;
    if (used.has(seg.segmentId)) break;
    if (i < endIdx) {
      const next = episodeList[i + 1]!;
      if (next.startMs - seg.endMs > EPISODE_BOUNDARY_MAX_GAP_MS) break;
    }
    const dur = seg.endMs - seg.startMs;
    if (totalMs + dur > maxMs && clips.length >= minClips) break;
    clips.unshift({
      segmentId: seg.segmentId,
      reason: clips.length === 0 ? "集尾连续区间" : "集尾承接",
      role: undefined,
    });
    totalMs += dur;
  }

  if (clips.length < minClips) return null;
  return { clips: assignBoundaryRoles(clips), totalMs };
}

/** 末块是否已落到该集 ASR 最后一段（看 through，无则看 segmentId） */
export function isAtEpisodeEnd(
  block: ClipPlanClip[],
  episodeList: AsrSegment[],
): boolean {
  if (!block.length || !episodeList.length) return false;
  const episodeLastId = episodeList.at(-1)!.segmentId;
  const last = block.at(-1)!;
  const endId = last.throughSegmentId?.trim() || last.segmentId;
  return endId === episodeLastId;
}

/**
 * skills 模式机械后处理：仅当末块已在「近集尾悬念区」时，才向前微延至集尾。
 * 远离集尾时不盲补（避免拖尾/揭底），交给重锚逻辑处理 cliff。
 */
export function extendClosingBlockToEpisodeEnd(
  plan: ClipPlan,
  segments: AsrSegment[],
): { plan: ClipPlan; repairs: string[] } {
  if (!plan.clips.length || !segments.length) {
    return { plan, repairs: [] };
  }

  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const lastClip = plan.clips.at(-1)!;
  const endId = lastClip.throughSegmentId?.trim() || lastClip.segmentId;
  const endSeg = segmentMap.get(endId) ?? segmentMap.get(lastClip.segmentId);
  if (!endSeg) return { plan, repairs: [] };

  const epKey =
    endSeg.episodeId ?? parseSegmentOrdinal(endId, endSeg)?.episodeKey ?? "default";
  const epList = byEpisode.get(epKey) ?? [];
  if (!epList.length) return { plan, repairs: [] };

  if (isAtEpisodeEnd(plan.clips, epList)) {
    return { plan, repairs: [] };
  }

  const endIdx = epList.findIndex((s) => s.segmentId === endId);
  if (endIdx < 0) return { plan, repairs: [] };

  const episodeLast = epList.at(-1)!;
  const epStart = epList[0]!.startMs;
  const epEnd = episodeLast.endMs;
  const span = Math.max(1, epEnd - epStart);
  const nearTailByTime = (endSeg.startMs - epStart) / span >= 0.78;
  const nearTailByIndex = endIdx >= Math.max(0, epList.length - 4);
  if (!nearTailByTime && !nearTailByIndex) {
    return {
      plan,
      repairs: [
        `片尾未近集尾，跳过盲补（末段 ${endId}，集尾 ${episodeLast.segmentId}；请 LLM 重锚 cliff）`,
      ],
    };
  }

  // 已有 through 块：把 through 延伸到集尾，不拆成逐段 clips
  const repairs: string[] = [
    `片尾微延 ${endId}→${episodeLast.segmentId}（已在近集尾悬念区）`,
  ];
  const newClips = [...plan.clips];
  const lastIdxInPlan = newClips.length - 1;
  newClips[lastIdxInPlan] = {
    ...lastClip,
    throughSegmentId: episodeLast.segmentId,
    role: "cliff",
    reason: lastClip.reason?.trim() || "片尾延伸至集尾",
  };

  return {
    plan: {
      ...plan,
      clips: assignBoundaryRoles(newClips),
    },
    repairs,
  };
}

function episodeCoverageWarnings(
  ep: string,
  segmentIds: Set<string>,
  blockCount: number,
  byEpisode: Map<string, AsrSegment[]>,
): string[] {
  const epList = byEpisode.get(ep) ?? [];
  if (epList.length < 4 || segmentIds.size === 0) return [];

  const warnings: string[] = [];
  // 仅保留：同集多 through 块。整集覆盖/从集首取整场由产品允许，不再拦「整集堆砌」
  if (blockCount >= 2) {
    warnings.push(
      `${ep} 同集拆成 ${blockCount} 个块（禁止；每集最多 1 个 through 块）`,
    );
  }
  return warnings;
}

/** 检测 LLM 原始 through 块：同集多块 / 单块过大 */
export function detectWholeEpisodeInLlmBlocks(plan: ClipPlan, segments: AsrSegment[]): string[] {
  if (!plan.clips.length) return [];
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const perEp = new Map<string, { blockCount: number; segmentIds: Set<string> }>();

  for (const clip of plan.clips) {
    if (!segmentMap.has(clip.segmentId)) continue;
    const ep = episodeKeyForClip(clip, segmentMap);
    const through = clip.throughSegmentId?.trim() || clip.segmentId;
    const epList = byEpisode.get(ep) ?? [];
    const startIdx = epList.findIndex((s) => s.segmentId === clip.segmentId);
    const endIdx = epList.findIndex((s) => s.segmentId === through);
    if (startIdx < 0 || endIdx < 0) continue;

    const acc = perEp.get(ep) ?? { blockCount: 0, segmentIds: new Set<string>() };
    acc.blockCount += 1;
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    for (let i = lo; i <= hi; i++) {
      acc.segmentIds.add(epList[i]!.segmentId);
    }
    perEp.set(ep, acc);
  }

  const warnings: string[] = [];
  for (const [ep, { blockCount, segmentIds }] of perEp) {
    warnings.push(...episodeCoverageWarnings(ep, segmentIds, blockCount, byEpisode));
  }
  return warnings;
}

/** 片尾 through 须等于该集最后一个 segment（展开前校验） */
export function validateLlmClosingThroughToEpisodeEnd(
  plan: ClipPlan,
  segments: AsrSegment[],
): string[] {
  if (!plan.clips.length) return ["方案无片段"];
  const lastClip = plan.clips.at(-1)!;
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const through = lastClip.throughSegmentId?.trim() || lastClip.segmentId;
  const ep = episodeKeyForClip(lastClip, segmentMap);
  const epList = segmentsByEpisode(segments).get(ep) ?? [];
  const episodeLast = epList.at(-1)?.segmentId;
  if (episodeLast && through !== episodeLast) {
    return [`片尾块 through 须为 ${ep} 集尾 ${episodeLast}（当前 ${through}）`];
  }
  return [];
}

/** 检测展开后 plan 中同集 segment 覆盖是否过大 */
export function detectWholeEpisodeRuns(plan: ClipPlan, segments: AsrSegment[]): string[] {
  if (!plan.clips.length) return [];
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const perEp = new Map<string, Set<string>>();

  for (const clip of plan.clips) {
    const ep = episodeKeyForClip(clip, segmentMap);
    const ids = perEp.get(ep) ?? new Set<string>();
    ids.add(clip.segmentId);
    perEp.set(ep, ids);
  }

  const warnings: string[] = [];
  for (const [ep, segmentIds] of perEp) {
    warnings.push(...episodeCoverageWarnings(ep, segmentIds, 1, byEpisode));
  }
  return warnings;
}

/** skills 机械后处理汇总：片尾延伸 + 片头/片尾合规日志 */
export function finalizeSkillsMechanicalBoundaries(
  plan: ClipPlan,
  segments: AsrSegment[],
): { plan: ClipPlan; repairs: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);

  if (plan.clips.length) {
    const firstClip = plan.clips[0]!;
    const firstSeg = segmentMap.get(firstClip.segmentId);
    const firstEp =
      firstSeg?.episodeId ??
      parseSegmentOrdinal(firstClip.segmentId, firstSeg)?.episodeKey ??
      "default";
    const firstList = byEpisode.get(firstEp) ?? [];
    // hook_first / skip_episode 允许从中后段爆点切入，不必贴集首
    const hookDrivenOpening =
      plan.editForm === "hook_first" ||
      plan.editForm === "skip_episode" ||
      Boolean(plan.hookSegmentId?.trim()) ||
      Boolean(plan.hookType?.trim());
    if (
      !hookDrivenOpening &&
      firstList.length &&
      !isNearEpisodeStart([firstClip], firstList)
    ) {
      warnings.push(
        `片头未贴 ${firstEp} 集首（首段 ${firstClip.segmentId}，集首 ${firstList[0]!.segmentId}）— 请 LLM 自行调整`,
      );
    }
    if (!plan.outroReason?.trim()) {
      warnings.push("缺少 outroReason，无法核对片尾叙事意图");
    }
  }

  const { plan: extended, repairs } = extendClosingBlockToEpisodeEnd(plan, segments);
  for (const w of detectWholeEpisodeRuns(extended, segments)) {
    if (!warnings.includes(w)) warnings.push(w);
  }
  return { plan: extended, repairs, warnings };
}

function dedupeClipIds(clips: ClipPlanClip[]): ClipPlanClip[] {
  const seen = new Set<string>();
  const out: ClipPlanClip[] = [];
  for (const clip of clips) {
    if (seen.has(clip.segmentId)) continue;
    seen.add(clip.segmentId);
    out.push(clip);
  }
  return out;
}

function mergeEpisodeBlocks(
  opening: ClipPlanClip[],
  middle: ClipPlanClip[],
  closing: ClipPlanClip[],
): ClipPlanClip[] {
  const used = new Set<string>();
  const merged: ClipPlanClip[] = [];

  for (const group of [opening, middle, closing]) {
    for (const clip of group) {
      if (used.has(clip.segmentId)) continue;
      used.add(clip.segmentId);
      merged.push(clip);
    }
  }
  return assignBoundaryRoles(merged);
}

export interface EpisodeBoundaryAnchorOptions {
  maxOpeningSec?: number;
  maxClosingSec?: number;
  /** 替换片头/片尾时排除的 segment（批内去重用） */
  reservedSegmentIds?: Set<string>;
}

/**
 * 将成片首块锚定到某一集开头、末块锚定到某一集结尾。
 * 中间跨集块保持不变；若仅单集单块则拆成「集首 + 主体 + 集尾」。
 */
export function enforceEpisodeBoundaryAnchors(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: EpisodeBoundaryAnchorOptions = {},
): { plan: ClipPlan; repairs: string[] } {
  if (!plan.clips.length || !segments.length) {
    return { plan, repairs: [] };
  }

  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const repairs: string[] = [];

  const targetSec = plan.targetDurationSec ?? plan.estimatedDurationSec ?? 600;
  const maxOpeningSec = options.maxOpeningSec ?? Math.min(DEFAULT_OPENING_WINDOW_SEC, Math.max(45, targetSec * 0.22));
  const maxClosingSec = options.maxClosingSec ?? Math.min(DEFAULT_CLOSING_WINDOW_SEC, Math.max(45, targetSec * 0.22));

  let blocks = splitClipsIntoEpisodeBlocks(plan.clips, segmentMap);
  if (!blocks.length) return { plan, repairs: [] };

  const reserved = options.reservedSegmentIds ?? new Set<string>();

  const idsExceptBlock = (skipBlockIdx: number) => {
    const ids = new Set(reserved);
    blocks.forEach((block, bi) => {
      if (bi === skipBlockIdx) return;
      for (const clip of block) ids.add(clip.segmentId);
    });
    return ids;
  };

  // --- 片头：首块锚定集首 ---
  const firstBlock = blocks[0]!;
  const firstEp = episodeKeyForClip(firstBlock[0]!, segmentMap);
  const firstList = byEpisode.get(firstEp) ?? [];
  if (firstList.length && !isNearEpisodeStart(firstBlock, firstList)) {
    const opening = buildEpisodeOpeningWindow(firstList, {
      maxDurationSec: maxOpeningSec,
      maxClipCount: Math.max(2, Math.min(20, Math.ceil(maxOpeningSec / 4))),
      minClips: 1,
      usedSegmentIds: idsExceptBlock(0),
    });
    if (opening?.clips.length) {
      blocks[0] = opening.clips.map((c) => ({
        ...c,
        role: "hook",
        reason: c.reason ?? `片头锚定 ${firstEp} 集开头`,
      }));
      repairs.push(`片头锚定 ${firstEp} 集开头 (${opening.clips[0]!.segmentId}~${opening.clips.at(-1)!.segmentId})`);
    }
  }

  // --- 片尾：末块锚定集尾 ---
  const lastBlockIdx = blocks.length - 1;
  const lastBlock = blocks[lastBlockIdx]!;
  const lastEp = episodeKeyForClip(lastBlock[0]!, segmentMap);
  const lastList = byEpisode.get(lastEp) ?? [];
  if (lastList.length && !isNearEpisodeEnd(lastBlock, lastList)) {
    const closing = buildEpisodeClosingWindow(lastList, {
      maxDurationSec: maxClosingSec,
      maxClipCount: Math.max(1, Math.min(20, Math.ceil(maxClosingSec / 4))),
      minClips: 1,
      usedSegmentIds: idsExceptBlock(lastBlockIdx),
    });
    if (closing?.clips.length) {
      blocks[lastBlockIdx] = closing.clips.map((c, idx) => ({
        ...c,
        role: idx === closing.clips.length - 1 ? "cliff" : c.role,
        reason: c.reason ?? `片尾锚定 ${lastEp} 集结尾`,
      }));
      repairs.push(`片尾锚定 ${lastEp} 集结尾 (${closing.clips[0]!.segmentId}~${closing.clips.at(-1)!.segmentId})`);
    }
  }

  // 单集单块：若片头片尾同集且中间被跳过，保留原块中不重叠的 segment 作主体
  if (blocks.length === 1 && firstEp === lastEp) {
    const epList = byEpisode.get(firstEp) ?? [];
    const opening = buildEpisodeOpeningWindow(epList, {
      maxDurationSec: maxOpeningSec,
      maxClipCount: Math.max(2, Math.min(15, Math.ceil(maxOpeningSec / 4))),
      minClips: 1,
      usedSegmentIds: reserved,
    });
    const openingIds = new Set(opening?.clips.map((c) => c.segmentId) ?? []);
    const closingUsed = new Set([...reserved, ...openingIds]);
    const closing = buildEpisodeClosingWindow(epList, {
      maxDurationSec: maxClosingSec,
      maxClipCount: Math.max(1, Math.min(15, Math.ceil(maxClosingSec / 4))),
      minClips: 1,
      usedSegmentIds: closingUsed,
    });
    const closingIds = new Set(closing?.clips.map((c) => c.segmentId) ?? []);
    const middle = plan.clips.filter(
      (c) => !openingIds.has(c.segmentId) && !closingIds.has(c.segmentId),
    );
    if (opening?.clips.length && closing?.clips.length) {
      const merged = mergeEpisodeBlocks(opening.clips, middle, closing.clips);
      if (merged.length >= 2) {
        blocks = [merged];
        if (!repairs.some((r) => r.includes("片头锚定"))) {
          repairs.push(`片头锚定 ${firstEp} 集开头`);
        }
        if (!repairs.some((r) => r.includes("片尾锚定"))) {
          repairs.push(`片尾锚定 ${lastEp} 集结尾`);
        }
      }
    }
  }

  const mergedClips = dedupeClipIds(blocks.flat());
  if (mergedClips.length < 1) return { plan, repairs: [] };

  return {
    plan: {
      ...plan,
      clips: assignBoundaryRoles(mergedClips),
    },
    repairs,
  };
}
