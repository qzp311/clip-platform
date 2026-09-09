import type { AsrSegment, ClipPlan } from "@clip/sdk";
import { expandClipBlockRanges } from "./clip-plan-coherence.js";
import {
  prepareRenderClips,
  type PrepareRenderClipsOptions,
  type ResolvedRenderClip,
} from "./rule-engine.js";

/** 映射到成片时间轴后的 ASR 句 */
export interface OutputTimelineAsrSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  episodeId?: string;
  episodeNo?: number;
  highlightType?: AsrSegment["highlightType"];
  highlightScore?: number;
  highlightTags?: string[];
  usableAsHook?: boolean;
  role?: string;
  /** 源时间轴起止（该刀内裁切后） */
  sourceStartMs: number;
  sourceEndMs: number;
}

export interface RemapPlanAsrToOutputTimelineResult {
  /** 与渲染一致的刀序列 */
  knives: ResolvedRenderClip[];
  /** 成片轴台词（从 0 连续） */
  segments: OutputTimelineAsrSegment[];
  /** 有高光标签或片头标记的子集 */
  highlights: OutputTimelineAsrSegment[];
  /** prepareRenderClips 的修复说明 */
  repairs: string[];
  durationSec: number;
}

function episodeKeyOf(seg: Pick<AsrSegment, "episodeId" | "segmentId">): string {
  if (seg.episodeId) return seg.episodeId;
  const m = /^([^_]+)_s\d+$/i.exec(seg.segmentId);
  if (m?.[1]) return m[1];
  if (/^s\d+$/i.test(seg.segmentId)) return "default";
  const stripped = seg.segmentId.replace(/_s\d+$/i, "").trim();
  return stripped || "default";
}

function knifeEpisodeKey(knife: ResolvedRenderClip): string {
  return knife.episodeId ?? episodeKeyOf({ segmentId: knife.segmentId, episodeId: knife.episodeId });
}

/**
 * 按混剪方案把分集 ASR 句映射到成片时间轴（与 prepareRenderClips 刀序一致）。
 */
export function remapPlanAsrToOutputTimeline(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: PrepareRenderClipsOptions = {},
): RemapPlanAsrToOutputTimelineResult {
  // 与渲染前一致：先展开 through 块，再 prepareRenderClips
  const { plan: expandedPlan, repairs: expandRepairs } = expandClipBlockRanges(plan, segments);
  const prepared = prepareRenderClips(expandedPlan, segments, options);
  const knives = prepared.clips;
  if (!knives.length) {
    return {
      knives,
      segments: [],
      highlights: [],
      repairs: [...expandRepairs, ...prepared.repairs],
      durationSec: 0,
    };
  }

  const byEpisode = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const key = episodeKeyOf(seg);
    const list = byEpisode.get(key) ?? [];
    list.push(seg);
    byEpisode.set(key, list);
  }

  const roleBySegmentId = new Map<string, string>();
  for (const clip of expandedPlan.clips) {
    if (clip.role) roleBySegmentId.set(clip.segmentId, clip.role);
  }

  const out: OutputTimelineAsrSegment[] = [];
  let cursorMs = 0;

  for (const knife of knives) {
    const knifeDur = Math.max(0, knife.endMs - knife.startMs);
    if (knifeDur <= 0) continue;

    const epKey = knifeEpisodeKey(knife);
    // 优先同集；无索引时回落全量再按 episodeKey 过滤
    const candidates = byEpisode.get(epKey) ?? segments.filter((s) => episodeKeyOf(s) === epKey);
    for (const seg of candidates) {
      const overlapStart = Math.max(seg.startMs, knife.startMs);
      const overlapEnd = Math.min(seg.endMs, knife.endMs);
      if (overlapEnd - overlapStart < 40) continue;

      const text = (seg.text || "").trim();
      if (!text) continue;

      const outStart = cursorMs + (overlapStart - knife.startMs);
      const outEnd = cursorMs + (overlapEnd - knife.startMs);
      if (outEnd <= outStart) continue;

      out.push({
        segmentId: seg.segmentId,
        startMs: Math.round(outStart),
        endMs: Math.round(outEnd),
        text,
        episodeId: seg.episodeId ?? knife.episodeId,
        episodeNo: seg.episodeNo,
        highlightType: seg.highlightType,
        highlightScore: seg.highlightScore,
        highlightTags: seg.highlightTags,
        usableAsHook: seg.usableAsHook,
        role: roleBySegmentId.get(seg.segmentId),
        sourceStartMs: overlapStart,
        sourceEndMs: overlapEnd,
      });
    }

    cursorMs += knifeDur;
  }

  // 同句可能被相邻刀边缘重复命中，按成片轴去重
  const deduped: OutputTimelineAsrSegment[] = [];
  for (const row of out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.segmentId === row.segmentId &&
      Math.abs(prev.startMs - row.startMs) < 80 &&
      Math.abs(prev.endMs - row.endMs) < 80
    ) {
      continue;
    }
    deduped.push(row);
  }

  const highlights = deduped.filter((s) => Boolean(s.highlightType) || Boolean(s.usableAsHook));
  return {
    knives,
    segments: deduped,
    highlights,
    repairs: [...expandRepairs, ...prepared.repairs],
    durationSec: prepared.durationSec,
  };
}
