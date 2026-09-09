import type { AsrSegment, ClipPlanClip, GenreProfile } from "@clip/sdk";
import {
  BLAND_KEYWORDS,
  COMMON_BURST_PATTERNS,
  GENRE_BURST_PATTERNS,
  type BurstLexiconPattern,
} from "./genre-burst-lexicon.js";

export interface BurstScore {
  score: number;
  tags: string[];
}

export interface BurstScoreOptions {
  /** 叙事画像：叠加对应加表；缺省仅通用底表 */
  genreProfile?: GenreProfile;
}

function textHasAny(text: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    if (kw && text.includes(kw)) return true;
  }
  return false;
}

function applyPatterns(
  text: string,
  patterns: readonly BurstLexiconPattern[],
  score: number,
  tags: Set<string>,
): number {
  let next = score;
  for (const { tag, weight, keywords } of patterns) {
    if (textHasAny(text, keywords)) {
      next += weight;
      tags.add(tag);
    }
  }
  return next;
}

/** 根据 ASR 文本估算爆点强度；可按题材叠加加表 */
export function scoreBurstText(text: string, options: BurstScoreOptions | GenreProfile = {}): BurstScore {
  const genreProfile = typeof options === "string" ? options : options.genreProfile;
  const trimmed = text.trim();
  if (!trimmed || textHasAny(trimmed, BLAND_KEYWORDS)) {
    return { score: 0, tags: [] };
  }

  const tags = new Set<string>();
  let score = applyPatterns(trimmed, COMMON_BURST_PATTERNS, 0, tags);
  if (genreProfile) {
    const genrePatterns = GENRE_BURST_PATTERNS[genreProfile];
    if (genrePatterns?.length) {
      score = applyPatterns(trimmed, genrePatterns, score, tags);
    }
  }

  if (/[!！？?]/.test(trimmed)) score += 1;
  if (trimmed.length <= 18 && score > 0) score += 1;
  return { score, tags: [...tags] };
}

export function scoreBurstSegment(
  seg: AsrSegment,
  options: BurstScoreOptions | GenreProfile = {},
): BurstScore {
  return scoreBurstText(seg.text, options);
}

export function isStrongBurstScore(score: number): boolean {
  return score >= 3;
}

export function isWeakClipReason(reason?: string): boolean {
  const text = reason?.trim();
  if (!text) return true;
  // 仅匹配机械/敷衍 reason；叙事句里含「铺垫」等词不算
  return (
    /^(块内连续承接?|块内承接|全集|建立情境|集首连续区间|集首承接|集首连续)$/.test(text) ||
    /^集首连续/.test(text)
  );
}

/** 在单集内找爆点最高的 segment（跳过极短/平台口播） */
export function findBestBurstSegmentInEpisode(
  episodeList: AsrSegment[],
  options: BurstScoreOptions = {},
): AsrSegment | null {
  let best: { seg: AsrSegment; score: number } | null = null;
  for (const seg of episodeList) {
    const text = seg.text.trim();
    if (!text || text.length < 4) continue;
    const { score } = scoreBurstSegment(seg, options);
    if (!best || score > best.score) {
      best = { seg, score };
    }
  }
  return best && best.score >= 2 ? best.seg : null;
}

/** 以 anchor 为中心取连续爆点窗口，用于 hook_first 片头 */
export function buildBurstWindowAroundSegment(
  episodeList: AsrSegment[],
  anchorSegmentId: string,
  options: {
    maxDurationSec?: number;
    maxClipCount?: number;
    minClips?: number;
    genreProfile?: GenreProfile;
  } = {},
): { clips: ClipPlanClip[]; totalMs: number } | null {
  const maxDurationSec = options.maxDurationSec ?? 45;
  const maxClipCount = options.maxClipCount ?? 6;
  const minClips = Math.max(1, options.minClips ?? 2);
  const maxMs = maxDurationSec * 1000;
  const burstOpts = { genreProfile: options.genreProfile };

  const anchorIdx = episodeList.findIndex((s) => s.segmentId === anchorSegmentId);
  if (anchorIdx < 0) return null;

  let startIdx = anchorIdx;
  let endIdx = anchorIdx;
  let totalMs = episodeList[anchorIdx]!.endMs - episodeList[anchorIdx]!.startMs;

  const segmentMs = (idx: number) => episodeList[idx]!.endMs - episodeList[idx]!.startMs;

  while (endIdx + 1 < episodeList.length && endIdx - startIdx + 1 < maxClipCount) {
    const nextIdx = endIdx + 1;
    const nextDur = segmentMs(nextIdx);
    if (totalMs + nextDur > maxMs && endIdx - startIdx + 1 >= minClips) break;
    endIdx = nextIdx;
    totalMs += nextDur;
  }

  if (endIdx - startIdx + 1 < minClips && startIdx > 0) {
    const prevIdx = startIdx - 1;
    const prevDur = segmentMs(prevIdx);
    if (totalMs + prevDur <= maxMs) {
      startIdx = prevIdx;
      totalMs += prevDur;
    }
  }

  if (endIdx - startIdx + 1 < minClips) return null;

  const clips: ClipPlanClip[] = [];
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const seg = episodeList[idx]!;
    const burst = scoreBurstSegment(seg, burstOpts);
    const isAnchor = idx === anchorIdx;
    clips.push({
      segmentId: seg.segmentId,
      role: idx === startIdx ? ("hook" as const) : undefined,
      reason: isAnchor
        ? `爆点片头：${burst.tags[0] ?? "冲突"}「${seg.text.trim().slice(0, 24)}」`
        : "钩子承接",
    });
  }

  return { clips, totalMs };
}

/** 生成注入 LLM 的爆点候选列表 */
export function formatBurstCandidatesForPrompt(
  segments: AsrSegment[],
  limit = 18,
  options: BurstScoreOptions = {},
): string {
  const ranked = segments
    .map((seg) => ({ seg, burst: scoreBurstSegment(seg, options) }))
    .filter(({ seg, burst }) => seg.text.trim().length >= 4 && burst.score >= 2)
    .sort((a, b) => b.burst.score - a.burst.score || a.seg.startMs - b.seg.startMs)
    .slice(0, limit);

  const genreHint = options.genreProfile ? ` · 题材 ${options.genreProfile}` : " · 仅通用底表";
  if (!ranked.length) {
    return `## 爆点候选（ASR 扫描${genreHint}）\n- 未命中明显冲突词，请从 ASR 找情绪最尖的连续段作 **hook**（中段仍须同线邻集推进）`;
  }

  const lines = ranked.map(({ seg, burst }, i) => {
    const tags = burst.tags.length ? burst.tags.join("/") : "高能";
    const preview = seg.text.trim().replace(/\s+/g, " ").slice(0, 36);
    return `${i + 1}. \`${seg.segmentId}\`（${tags}，强度 ${burst.score}）「${preview}」`;
  });

  return [
    `## 爆点候选（ASR 扫描${genreHint}，**仅用于选 hook**；escalate 禁止按强度跳集）`,
    ...lines,
  ].join("\n");
}
