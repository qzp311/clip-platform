import type {
  AsrRules,
  AsrSegment,
  ClipPlan,
  ClipPlanClip,
  RawAsrSegment,
  RenderConfig,
  RuleEngineStats,
} from "@clip/sdk";
import { parseSegmentOrdinal, MAX_PLAN_DURATION_SEC } from "./clip-plan-coherence.js";
import { isWorkstationClosingMarker } from "./workstation-marker-types.js";

/** 集尾无台词转场（片尾画面）相对 ASR 末句的最大可延伸时长 */
export const DEFAULT_EPISODE_VIDEO_TAIL_GAP_MS = 15_000;

/** @deprecated 片头不再插入无台词占位段；保留导出兼容旧调用 */
export const ASR_SILENT_PLACEHOLDER_TEXT = "（无台词）";

const DEFAULT_FILLERS = ["嗯", "啊", "呃"];
const DEFAULT_SENTENCE_PUNC = ["。", "？", "！", "…", "!", "?"];

function joinSegmentText(left: string, right: string, gapMs: number): string {
  return `${left}${gapMs > 120 ? " " : ""}${right}`.trim();
}

function endsWithSentencePunc(text: string, puncs: string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return puncs.some((p) => trimmed.endsWith(p));
}

function mergeRawPair(current: RawAsrSegment, next: RawAsrSegment, gapMs: number): RawAsrSegment {
  return {
    id: current.id,
    startMs: current.startMs,
    endMs: next.endMs,
    text: joinSegmentText(current.text, next.text, gapMs),
    confidence: Math.min(current.confidence ?? 1, next.confidence ?? 1),
    // 声学字段按能量加权合并：RMS 取 dBFS 均值（按段长加权），Peak 取最大
    rmsDb: mergeRmsDb(current, next),
    peakDb:
      current.peakDb != null && next.peakDb != null
        ? Math.max(current.peakDb, next.peakDb)
        : current.peakDb ?? next.peakDb,
    speechRate: mergeSpeechRate(current, next),
  };
}

/** 合并段 RMS：按段时长加权平均（dBFS 域先转功率再平均） */
function mergeRmsDb(current: RawAsrSegment, next: RawAsrSegment): number | undefined {
  if (current.rmsDb == null && next.rmsDb == null) return undefined;
  if (current.rmsDb == null) return next.rmsDb;
  if (next.rmsDb == null) return current.rmsDb;
  const wCur = Math.max(1, current.endMs - current.startMs);
  const wNext = Math.max(1, next.endMs - next.startMs);
  const pCur = Math.pow(10, current.rmsDb / 10);
  const pNext = Math.pow(10, next.rmsDb / 10);
  const avgPower = (pCur * wCur + pNext * wNext) / (wCur + wNext);
  return Math.round((10 * Math.log10(avgPower)) * 100) / 100;
}

/** 合并段语速：按总字数/总时长重算 */
function mergeSpeechRate(current: RawAsrSegment, next: RawAsrSegment): number | undefined {
  const durMs = next.endMs - current.startMs;
  if (durMs <= 0) return undefined;
  const totalChars =
    (current.text.trim().length || 0) + (next.text.trim().length || 0);
  if (totalChars <= 0) return undefined;
  return Math.round((totalChars / durMs) * 1000 * 10) / 10;
}

export interface RuleEngineApplyOptions {
  /** 源音视频时长（ms）；用于将末段延伸至无台词片尾转场 */
  sourceDurationMs?: number;
}

export interface RuleEngineResult {
  segments: AsrSegment[];
  stats: RuleEngineStats;
}

export class RuleEngine {
  apply(
    rawSegments: RawAsrSegment[],
    rules: AsrRules,
    options: RuleEngineApplyOptions = {},
  ): RuleEngineResult {
    const sorted = [...rawSegments].sort((a, b) => a.startMs - b.startMs);
    let working = this.foldTrailingSilentTail(sorted);

    working = this.applyVadRules(working, rules);
    working = this.applyMergeRules(working, rules);
    working = this.foldTrailingTailCluster(working, rules);
    working = this.applyFilterRules(working, rules);
    working = working.map((seg) => this.applyTextRules(seg, rules));

    const prefix = rules.output?.segmentIdPrefix ?? "s";
    const segments: AsrSegment[] = working.map((seg, index) => ({
      segmentId: `${prefix}${String(index + 1).padStart(3, "0")}`,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
      confidence: seg.confidence,
      // 规则合并后的段起点即真实开口；后续连续化可能把片头并到 0
      speechStartMs: seg.startMs,
      // 声学字段透传（合并段已在 mergeRawPair 中按能量加权）
      rmsDb: seg.rmsDb,
      peakDb: seg.peakDb,
      speechRate: seg.speechRate,
    }));

    return {
      segments,
      stats: {
        rawCount: rawSegments.length,
        finalCount: segments.length,
        filteredCount: rawSegments.length - working.length,
      },
    };
  }

  /**
   * ASR 末段常为无台词片尾区间；保留其时间轴并折入上一段，避免 dropEmptyText / maxSegmentMs 把集尾切掉。
   * 若 FunASR 未产出该区间，由 {@link extendEpisodeAsrTails} 在已知源视频时长后向后补至整集结尾。
   */
  private foldTrailingSilentTail(segments: RawAsrSegment[]): RawAsrSegment[] {
    if (segments.length < 2) return segments;
    const last = segments.at(-1)!;
    if (last.text.trim()) return segments;

    const prev = segments.at(-2)!;
    return [
      ...segments.slice(0, -2),
      {
        ...prev,
        endMs: Math.max(prev.endMs, last.endMs),
        confidence: Math.min(prev.confidence ?? 1, last.confidence ?? 1),
      },
    ];
  }

  /**
   * 合并集尾短句/语气词/空段进上一段，避免 minSegmentMs / dropFillersOnly 在 filter 阶段裁掉末段。
   * 典型场景：长静音后的「谢谢。」「是。」等短尾句，或 FunASR 末段过短。
   */
  private foldTrailingTailCluster(segments: RawAsrSegment[], rules: AsrRules): RawAsrSegment[] {
    if (segments.length < 2) return segments;

    const filter = rules.filter ?? {};
    const minSegmentMs = filter.minSegmentMs ?? 0;
    const dropFillersOnly = filter.dropFillersOnly ?? false;
    const fillers = new Set<string>(rules.text?.removeFillers ?? DEFAULT_FILLERS);

    const shouldFoldAsTail = (seg: RawAsrSegment): boolean => {
      const duration = seg.endMs - seg.startMs;
      const text = seg.text.trim();
      if (!text) return true;
      if (minSegmentMs > 0 && duration < minSegmentMs) return true;
      if (dropFillersOnly && isFillersOnly(text, fillers)) return true;
      return false;
    };

    let result = segments;

    let tailCount = 0;
    for (let i = result.length - 1; i >= 0; i--) {
      if (shouldFoldAsTail(result[i]!)) tailCount++;
      else break;
    }

    if (tailCount > 0) {
      const anchorIndex = result.length - tailCount - 1;
      const tailParts = result.slice(anchorIndex + 1);

      if (anchorIndex < 0) {
        let merged = { ...result[0]! };
        for (let i = 1; i < result.length; i++) {
          const part = result[i]!;
          merged = mergeRawPair(merged, part, part.startMs - merged.endMs);
        }
        result = [merged];
      } else {
        let merged = { ...result[anchorIndex]! };
        for (const part of tailParts) {
          merged = mergeRawPair(merged, part, part.startMs - merged.endMs);
        }
        result = [...result.slice(0, anchorIndex), merged];
      }
    }

    // 集尾长静音后的短末句并入上一段（仅当末段本身较短，避免误合并正常下一句）
    if (result.length >= 2) {
      const maxGapMs = Math.max(
        rules.merge?.minGapMs ?? 300,
        rules.vad?.mergeGapMs ?? rules.merge?.minGapMs ?? 300,
      );
      const last = result.at(-1)!;
      const prev = result.at(-2)!;
      const gap = last.startMs - prev.endMs;
      const lastDuration = last.endMs - last.startMs;
      const shortTailMs = Math.max((filter.minSegmentMs ?? 0) * 3, 2500);
      const foldShortGapTail =
        gap > maxGapMs && (shouldFoldAsTail(last) || lastDuration < shortTailMs);
      if (foldShortGapTail) {
        result = [...result.slice(0, -2), mergeRawPair(prev, last, gap)];
      }
    }

    return result;
  }

  private applyVadRules(segments: RawAsrSegment[], rules: AsrRules): RawAsrSegment[] {
    const minSpeechMs = rules.vad?.minSpeechMs ?? 0;
    if (minSpeechMs <= 0) return segments;

    return segments.filter((seg, index) => {
      const isLast = index === segments.length - 1;
      if (isLast && !seg.text.trim()) return true;
      return seg.endMs - seg.startMs >= minSpeechMs;
    });
  }

  private applyMergeRules(segments: RawAsrSegment[], rules: AsrRules): RawAsrSegment[] {
    if (segments.length === 0) return segments;

    const minGapMs = rules.merge?.minGapMs ?? 300;
    const maxSentenceMs = rules.merge?.maxSentenceMs ?? 15000;
    const sentenceLevel = rules.pipeline?.sentenceLevel !== false;
    const splitOnPunc = rules.merge?.splitOnPunc?.length
      ? rules.merge.splitOnPunc
      : DEFAULT_SENTENCE_PUNC;
    const maxGapMs = Math.max(minGapMs, rules.vad?.mergeGapMs ?? minGapMs);

    let merged = this.mergeByGap(segments, minGapMs, maxSentenceMs);

    if (sentenceLevel) {
      merged = this.mergeToSentenceBoundaries(merged, splitOnPunc, maxSentenceMs, maxGapMs);
      merged = this.absorbShortSegments(merged, maxGapMs, maxSentenceMs);
    }

    return merged;
  }

  /** 相邻间隔 ≤ maxGapMs 时合并 */
  private mergeByGap(
    segments: RawAsrSegment[],
    maxGapMs: number,
    maxSentenceMs: number,
  ): RawAsrSegment[] {
    const merged: RawAsrSegment[] = [];
    let current = { ...segments[0]! };

    for (let i = 1; i < segments.length; i++) {
      const next = segments[i]!;
      const gap = next.startMs - current.endMs;
      const mergedDuration = next.endMs - current.startMs;

      if (gap <= maxGapMs && mergedDuration <= maxSentenceMs) {
        current = mergeRawPair(current, next, gap);
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    return merged;
  }

  /** 未以句末标点结束时，继续合并后续片段（允许更大停顿） */
  private mergeToSentenceBoundaries(
    segments: RawAsrSegment[],
    splitOnPunc: string[],
    maxSentenceMs: number,
    maxGapMs: number,
  ): RawAsrSegment[] {
    if (segments.length <= 1) return segments;

    const merged: RawAsrSegment[] = [];
    let current = { ...segments[0]! };

    for (let i = 1; i < segments.length; i++) {
      const next = segments[i]!;
      const gap = next.startMs - current.endMs;
      const mergedDuration = next.endMs - current.startMs;
      const sentenceComplete = endsWithSentencePunc(current.text, splitOnPunc);
      const shouldMerge =
        !sentenceComplete && gap <= maxGapMs && mergedDuration <= maxSentenceMs;

      if (shouldMerge) {
        current = mergeRawPair(current, next, gap);
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    return merged;
  }

  /** 过短碎片并入相邻段，减少 LLM 看到的碎句 */
  private absorbShortSegments(
    segments: RawAsrSegment[],
    maxGapMs: number,
    maxSentenceMs: number,
    shortSegmentMs = 2500,
  ): RawAsrSegment[] {
    if (segments.length <= 1) return segments;

    const result: RawAsrSegment[] = [];
    let pending: RawAsrSegment | null = null;

    for (const seg of segments) {
      if (!pending) {
        pending = { ...seg };
        continue;
      }

      const gap = seg.startMs - pending.endMs;
      const pendingShort = pending.endMs - pending.startMs < shortSegmentMs;
      const segShort = seg.endMs - seg.startMs < shortSegmentMs;
      const mergedDuration = seg.endMs - pending.startMs;

      if (
        (pendingShort || segShort) &&
        gap <= maxGapMs &&
        mergedDuration <= maxSentenceMs
      ) {
        pending = mergeRawPair(pending, seg, gap);
      } else {
        result.push(pending);
        pending = { ...seg };
      }
    }

    if (pending) result.push(pending);
    return result;
  }

  private applyFilterRules(segments: RawAsrSegment[], rules: AsrRules): RawAsrSegment[] {
    const filter = rules.filter ?? {};
    const minSegmentMs = filter.minSegmentMs ?? 0;
    const maxSegmentMs = filter.maxSegmentMs ?? Number.MAX_SAFE_INTEGER;
    const minConfidence = filter.minConfidence ?? 0;
    const dropEmptyText = filter.dropEmptyText ?? true;
    const dropFillersOnly = filter.dropFillersOnly ?? false;
    const fillers = new Set<string>(rules.text?.removeFillers ?? DEFAULT_FILLERS);

    return segments.filter((seg, index) => {
      const duration = seg.endMs - seg.startMs;
      const isLast = index === segments.length - 1;
      if (!isLast && duration > maxSegmentMs) return false;
      if (!isLast && duration < minSegmentMs) return false;
      if ((seg.confidence ?? 1) < minConfidence) return false;

      const text = seg.text.trim();
      if (dropEmptyText && !text && !isLast) return false;

      if (!isLast && dropFillersOnly && isFillersOnly(text, fillers)) return false;
      return true;
    });
  }

  private applyTextRules(segment: RawAsrSegment, rules: AsrRules): RawAsrSegment {
    let text = segment.text;
    const textRules = rules.text ?? {};

    if (textRules.trimWhitespace !== false) {
      text = text.trim();
    }

    if (textRules.removeFillers?.length) {
      for (const filler of textRules.removeFillers) {
        text = text.replaceAll(filler, "");
      }
      text = text.trim();
    }

    return { ...segment, text };
  }
}

export interface FinalizeEpisodeAsrOptions {
  sourceDurationMs: number;
  episodeId?: string;
}

/** 规则引擎 + 时间轴连续补全（片头/中间空隙/片尾）+ 集尾延伸（ASR 入库前唯一入口） */
export function finalizeEpisodeAsrFromRaw(
  engine: RuleEngine,
  rawSegments: RawAsrSegment[],
  rules: AsrRules,
  options: FinalizeEpisodeAsrOptions,
): { segments: AsrSegment[]; stats: RuleEngineStats; tailRepairs: string[] } {
  const { segments: ruled, stats } = engine.apply(rawSegments, rules);
  const episodeKey = options.episodeId ?? "default";
  const withEpisode = options.episodeId
    ? ruled.map((seg) => ({ ...seg, episodeId: options.episodeId }))
    : ruled;
  const durationMap: Record<string, number> = {
    default: options.sourceDurationMs,
    [episodeKey]: options.sourceDurationMs,
  };

  // 先按旧逻辑尽量贴片尾，再强制全时间轴连续（片头/中间/片尾均不得留空洞）
  let { segments, repairs: tailRepairs } = extendEpisodeAsrTails(withEpisode, durationMap);
  const filled = ensureContinuousEpisodeAsrTimeline(segments, options.sourceDurationMs, {
    episodeId: options.episodeId,
    segmentIdPrefix: rules.output?.segmentIdPrefix ?? "s",
  });
  segments = filled.segments;
  tailRepairs = [...tailRepairs, ...filled.repairs];

  const maxSegments = rules.output?.maxSegments;
  if (maxSegments && segments.length > maxSegments) {
    segments = segments.slice(0, maxSegments);
  }

  return {
    segments,
    stats: { ...stats, finalCount: segments.length },
    tailRepairs,
  };
}

/**
 * 保证单集 ASR 时间轴连续无空洞：
 * - 片头：0 → 首句前的空隙并入第一段有语音段（不另插空白段）
 * - 中间：空隙并入前一段 endMs（保留台词归属，画面连续）
 * - 片尾：末段 endMs 拉到源视频时长
 * - 连续化前固化 speechStartMs（真实开口），供 hook 渲染切点使用
 */
export function ensureContinuousEpisodeAsrTimeline(
  segments: AsrSegment[],
  sourceDurationMs: number,
  options: {
    episodeId?: string;
    segmentIdPrefix?: string;
    /** @deprecated 片头不再插入占位段，保留参数仅兼容旧调用 */
    silentText?: string;
  } = {},
): { segments: AsrSegment[]; repairs: string[] } {
  const repairs: string[] = [];
  if (!segments.length || sourceDurationMs <= 0) {
    return { segments, repairs };
  }

  const prefix = options.segmentIdPrefix ?? "s";
  const episodeId = options.episodeId ?? segments[0]?.episodeId;

  let sorted = [...segments].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.segmentId.localeCompare(b.segmentId),
  );

  // 连续化前固化真实开口（缺省用当前 startMs；已有值不覆盖）
  sorted = sorted.map((seg) => ({
    ...seg,
    speechStartMs: seg.speechStartMs ?? seg.startMs,
  }));

  // 片头：空置并入首段有语音，不单独建空白段（避免进选段池/当 hook）
  const first = sorted[0]!;
  if (first.startMs > 0) {
    repairs.push(
      `${episodeId ?? "ep"} 片头并入首段 ${first.segmentId} start ${first.startMs}→0ms（开口=${first.speechStartMs ?? first.startMs}ms）`,
    );
    sorted[0] = { ...first, startMs: 0 };
  } else if (first.startMs < 0) {
    sorted[0] = { ...first, startMs: 0 };
    repairs.push(`${episodeId ?? "ep"} 片头校正 startMs ${first.startMs}→0`);
  }

  // 中间：空隙并入前一段，保证相邻段 end==next.start
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startMs < prev.endMs) {
      sorted[i] = { ...cur, startMs: prev.endMs };
      repairs.push(
        `${episodeId ?? "ep"} 去重叠 ${prev.segmentId}/${cur.segmentId} → 后段起点=${prev.endMs}ms`,
      );
      continue;
    }
    if (cur.startMs > prev.endMs) {
      const gap = cur.startMs - prev.endMs;
      sorted[i - 1] = { ...prev, endMs: cur.startMs };
      repairs.push(
        `${episodeId ?? "ep"} 中间补连续 ${prev.segmentId} end ${prev.endMs}→${cur.startMs}ms（+${gap}ms 无台词并入前段）`,
      );
    }
  }

  // 片尾：末段拉到源视频时长（不设 15s 上限，保证整集连续）
  const last = sorted.at(-1)!;
  if (last.endMs < sourceDurationMs) {
    const gap = sourceDurationMs - last.endMs;
    sorted[sorted.length - 1] = { ...last, endMs: sourceDurationMs };
    repairs.push(
      `${episodeId ?? "ep"} 片尾补连续 ${last.endMs}→${sourceDurationMs}ms（+${gap}ms）`,
    );
  } else if (last.endMs > sourceDurationMs) {
    sorted[sorted.length - 1] = { ...last, endMs: sourceDurationMs };
    repairs.push(
      `${episodeId ?? "ep"} 片尾裁切 ${last.endMs}→${sourceDurationMs}ms（不超过源时长）`,
    );
  }

  // 重编号，保证 s001… 连续且无重复
  const renumbered = sorted.map((seg, index) => ({
    ...seg,
    segmentId: `${prefix}${String(index + 1).padStart(3, "0")}`,
    ...(episodeId ? { episodeId } : {}),
  }));

  return { segments: renumbered, repairs };
}

function isFillersOnly(text: string, fillers: Set<string>): boolean {
  let remaining = text.trim();
  if (!remaining) return true;

  for (const filler of fillers) {
    remaining = remaining.replaceAll(filler, "").trim();
  }
  return remaining.length === 0;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalDurationMs: number;
}

const PLATFORM_CTA =
  /点击下方|观看全集|关注不迷路|下一集|点赞|订阅|下载|扫码|免费看|完整版/i;

export function validateClipPlan(
  plan: ClipPlan,
  segments: AsrSegment[],
  render: RenderConfig,
): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const seen = new Set<string>();
  let totalDurationMs = 0;
  let lastStartMs = -1;

  const episodeIds = new Set(
    plan.clips
      .map((c) => segmentMap.get(c.segmentId)?.episodeId)
      .filter((id): id is string => Boolean(id)),
  );
  const crossEpisodeMix = episodeIds.size > 1;

  for (const clip of plan.clips) {
    if (seen.has(clip.segmentId)) {
      errors.push(`duplicate segmentId: ${clip.segmentId}`);
    }
    seen.add(clip.segmentId);

    const seg = segmentMap.get(clip.segmentId);
    if (!seg) {
      errors.push(`unknown segmentId: ${clip.segmentId}`);
      continue;
    }

    if (PLATFORM_CTA.test(seg.text)) {
      warnings.push(`${clip.segmentId} 含平台口播，投放效果可能较差`);
    }

    const startMs = seg.startMs + (clip.trimStartMs ?? 0);
    const endMs = seg.endMs - (clip.trimEndMs ?? 0);
    if (endMs <= startMs) {
      errors.push(`invalid trim for ${clip.segmentId}`);
      continue;
    }
    totalDurationMs += endMs - startMs;

    if (!crossEpisodeMix && startMs < lastStartMs) {
      warnings.push(`clips 未按时间正序: ${clip.segmentId} 出现在更早片段之前（可能重复剧情）`);
    }
    lastStartMs = startMs;
  }

  if (plan.clips.length >= 2) {
    let prevOrd: { ep: string; idx: number; episodeNo: number } | null = null;
    const finishedEps = new Set<string>();
    let currentEp: string | null = null;

    for (const clip of plan.clips) {
      const seg = segmentMap.get(clip.segmentId);
      if (!seg) continue;
      const m = clip.segmentId.match(/^(.+)_s(\d+)$/i) ?? clip.segmentId.match(/_s(\d+)$/i);
      if (!m) continue;
      const ep = m.length === 3 ? m[1]! : (seg.episodeId ?? "default");
      const idx = Number.parseInt(m.length === 3 ? m[2]! : m[1]!, 10);
      const epKeyMatch = ep.match(/^e(\d+)$/i);
      // episodeNo=0 视为未设置，回退从 eXX 解析（否则隔集跳戏校验被整段跳过）
      const epNoFromSeg = seg.episodeNo != null && seg.episodeNo > 0 ? seg.episodeNo : 0;
      const epNo =
        epNoFromSeg || (epKeyMatch ? Number.parseInt(epKeyMatch[1]!, 10) : 0);

      if (currentEp !== null && ep !== currentEp) {
        finishedEps.add(currentEp);
      }
      currentEp = ep;

      if (finishedEps.has(ep)) {
        errors.push(`duplicate episode block: ${ep}（${clip.segmentId} 重复出现该集内容）`);
      }

      if (prevOrd) {
        if (prevOrd.ep === ep && idx - prevOrd.idx !== 1) {
          errors.push(
            `集内 seq 不连续: ${clip.segmentId} 与上一段差 ${idx - prevOrd.idx}（前言不搭后语风险）`,
          );
        } else if (prevOrd.ep !== ep && epNo > 0 && prevOrd.episodeNo > 0) {
          if (epNo < prevOrd.episodeNo) {
            errors.push(`集序倒跳: ep${prevOrd.episodeNo}→ep${epNo}（${clip.segmentId}）`);
          } else if (epNo - prevOrd.episodeNo > 1) {
            // Skill：换集必须 eN→eN+1；隔空一律跳戏拼盘
            errors.push(
              `隔集跳戏: ep${prevOrd.episodeNo}→ep${epNo}（隔 ${epNo - prevOrd.episodeNo - 1} 集，必须相邻 eN→eN+1，禁止隔空；${clip.segmentId}）`,
            );
          }
        }
      }
      prevOrd = { ep, idx, episodeNo: epNo };
    }
  }

  if (plan.clips.length > 0 && plan.clips[0]?.role && plan.clips[0].role !== "hook") {
    warnings.push("首个 clip 建议 role=hook 以强化前 3 秒钩子");
  }
  const lastClip = plan.clips.at(-1);
  if (lastClip?.role && lastClip.role !== "cliff" && lastClip.role !== "cta") {
    warnings.push("最后一个 clip 建议 role=cliff 以留悬念");
  }

  const maxDurationSec =
    plan.output.maxDurationSec ?? render.limits?.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  if (totalDurationMs > maxDurationSec * 1000) {
    errors.push(
      `total duration ${totalDurationMs}ms exceeds max ${maxDurationSec}s`,
    );
  }

  if (plan.targetDurationSec && totalDurationMs > plan.targetDurationSec * 1000 + 8000) {
    warnings.push(
      `实际时长 ${Math.ceil(totalDurationMs / 1000)}s 明显超过 targetDurationSec ${plan.targetDurationSec}s`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalDurationMs,
  };
}

function clipDurationMs(clip: ClipPlanClip, seg: AsrSegment): number {
  const startMs = seg.startMs + (clip.trimStartMs ?? 0);
  const endMs = seg.endMs - (clip.trimEndMs ?? 0);
  return Math.max(0, endMs - startMs);
}

/** 按 ASR 时间轴求 plan 成片时长（秒，向上取整） */
export function computePlanDurationSec(
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

export function inferDurationTierFromSec(sec: number): ClipPlan["durationTier"] {
  if (sec <= 300) return "S";
  if (sec <= 600) return "M";
  if (sec <= 900) return "L";
  return "XL";
}

export {
  DURATION_TIER_SPEC,
  BATCH_DURATION_TIERS,
  tierTargetDurationSec,
  tierExpandClipLimit,
  MAX_PLAN_DURATION_SEC,
} from "./clip-plan-coherence.js";

export function computeRenderClipsDurationSec(
  clips: Array<{ startMs: number; endMs: number }>,
): number {
  const ms = clips.reduce((sum, c) => sum + Math.max(0, c.endMs - c.startMs), 0);
  return Math.max(0, Math.ceil(ms / 1000));
}

/** 自动裁剪超长方案：优先保留 hook，从末尾删段或 trim 最后一镜 */
export function repairClipPlan(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: { maxDurationSec?: number; minClips?: number } = {},
): { plan: ClipPlan; repairs: string[] } {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const minClips = Math.max(1, options.minClips ?? 2);
  const maxDurationSec =
    options.maxDurationSec ?? plan.output.maxDurationSec ?? MAX_PLAN_DURATION_SEC;
  const maxMs = maxDurationSec * 1000;
  const repairs: string[] = [];

  const clips = plan.clips.map((c) => ({ ...c }));

  const totalMs = () =>
    clips.reduce((sum, clip) => {
      const seg = segmentMap.get(clip.segmentId);
      return seg ? sum + clipDurationMs(clip, seg) : sum;
    }, 0);

  while (clips.length > minClips && totalMs() > maxMs) {
    const removed = clips.pop();
    repairs.push(`移除末尾片段 ${removed?.segmentId ?? "?"} 以控制时长`);
  }

  if (clips.length > 0 && totalMs() > maxMs) {
    const lastIdx = clips.length - 1;
    const last = clips[lastIdx]!;
    const seg = segmentMap.get(last.segmentId);
    if (seg) {
      const current = clipDurationMs(last, seg);
      const othersMs = totalMs() - current;
      const allowedForLast = Math.max(500, maxMs - othersMs);
      const overflow = current - allowedForLast;
      if (overflow > 0) {
        const trimEndMs = (last.trimEndMs ?? 0) + overflow;
        clips[lastIdx] = { ...last, trimEndMs };
        repairs.push(`trim ${last.segmentId} 尾部 ${Math.ceil(overflow / 1000)}s`);
      }
    }
  }

  if (clips.length >= 2) {
    clips[0] = { ...clips[0]!, role: clips[0]?.role ?? "hook" };
    clips[clips.length - 1] = {
      ...clips[clips.length - 1]!,
      role: clips.at(-1)?.role ?? "cliff",
    };
  }

  const estimatedSec = Math.max(1, Math.ceil(totalMs() / 1000));
  return {
    plan: {
      ...plan,
      clips,
      estimatedDurationSec: estimatedSec,
      targetDurationSec: Math.min(plan.targetDurationSec ?? estimatedSec, maxDurationSec),
      output: {
        ...plan.output,
        maxDurationSec: maxDurationSec,
      },
    },
    repairs,
  };
}

export function resolveClipTimestamps(
  plan: ClipPlan,
  segments: AsrSegment[],
): Array<{ segmentId: string; episodeId?: string; startMs: number; endMs: number; text: string }> {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));

  return plan.clips.map((clip: ClipPlanClip) => {
    const seg = segmentMap.get(clip.segmentId);
    if (!seg) {
      throw new Error(`missing segment: ${clip.segmentId}`);
    }
    const trimStart = clip.trimStartMs ?? 0;
    const trimEnd = clip.trimEndMs ?? 0;
    let startMs: number;
    if (seg.humanMarkerStartMs != null) {
      startMs = seg.humanMarkerStartMs + trimStart;
    } else {
      startMs = seg.startMs + trimStart;
    }
    let endMs: number;
    if (seg.humanMarkerEndMs != null) {
      endMs = seg.humanMarkerEndMs - trimEnd;
    } else {
      endMs = seg.endMs - trimEnd;
    }
    return {
      segmentId: clip.segmentId,
      episodeId: seg.episodeId ?? clip.episodeId,
      startMs,
      endMs,
      text: seg.text,
    };
  });
}

export interface ResolvedRenderClip {
  segmentId: string;
  episodeId?: string;
  startMs: number;
  endMs: number;
  text: string;
}

function episodeKeyFromSegment(seg: AsrSegment): string {
  if (seg.episodeId) return seg.episodeId;
  const ord = parseSegmentOrdinal(seg.segmentId, seg);
  if (ord) return ord.episodeKey;
  // 单集任务常见 s001/s011，无 e01_ 前缀时归入 default
  if (/^s\d+$/i.test(seg.segmentId)) return "default";
  const stripped = seg.segmentId.replace(/_s\d+$/i, "").trim();
  return stripped || "default";
}

function renderEpisodeKey(clip: ResolvedRenderClip): string {
  return (
    clip.episodeId ??
    parseSegmentOrdinal(clip.segmentId)?.episodeKey ??
    clip.segmentId.replace(/_s\d+$/i, "") ??
    "default"
  );
}

function episodeLastAsrBounds(
  segments: AsrSegment[],
): Map<string, { lastSegmentId: string; lastEndMs: number }> {
  const byEpisode = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const ep = episodeKeyFromSegment(seg);
    const list = byEpisode.get(ep) ?? [];
    list.push(seg);
    byEpisode.set(ep, list);
  }

  const bounds = new Map<string, { lastSegmentId: string; lastEndMs: number }>();
  for (const [ep, list] of byEpisode) {
    const sorted = [...list].sort((a, b) => {
      const ao = parseSegmentOrdinal(a.segmentId);
      const bo = parseSegmentOrdinal(b.segmentId);
      if (ao && bo && ao.episodeKey === bo.episodeKey) return ao.index - bo.index;
      return a.startMs - b.startMs;
    });
    const last = sorted.at(-1);
    if (!last) continue;
    bounds.set(ep, { lastSegmentId: last.segmentId, lastEndMs: last.endMs });
  }
  return bounds;
}

/**
 * ASR 规则后：将每集末段 endMs 延伸至源视频时长（仅补 ASR 未覆盖的无台词片尾转场）。
 */
export function extendEpisodeAsrTails(
  segments: AsrSegment[],
  episodeSourceDurationMs: Record<string, number>,
  maxTailGapMs = DEFAULT_EPISODE_VIDEO_TAIL_GAP_MS,
): { segments: AsrSegment[]; repairs: string[] } {
  if (!segments.length) return { segments, repairs: [] };

  const bounds = episodeLastAsrBounds(segments);
  const repairs: string[] = [];
  const extendedEndBySegmentId = new Map<string, number>();

  for (const [ep, { lastSegmentId, lastEndMs }] of bounds) {
    const sourceDurationMs = episodeSourceDurationMs[ep] ?? episodeSourceDurationMs.default;
    if (!sourceDurationMs || sourceDurationMs <= lastEndMs) continue;
    const gap = sourceDurationMs - lastEndMs;
    if (gap <= 0 || gap > maxTailGapMs) continue;
    extendedEndBySegmentId.set(lastSegmentId, sourceDurationMs);
    repairs.push(`${ep} ASR 集尾延伸 ${lastEndMs}→${sourceDurationMs}ms（+${gap}ms 无台词转场）`);
  }

  if (!extendedEndBySegmentId.size) return { segments, repairs };

  return {
    segments: segments.map((seg) => {
      const endMs = extendedEndBySegmentId.get(seg.segmentId);
      return endMs != null ? { ...seg, endMs } : seg;
    }),
    repairs,
  };
}

/**
 * 渲染切条：块末对齐某集 ASR 集尾时，将 endMs 延伸至源视频真实结尾（含无台词转场画面）。
 */
export function extendRenderClipsToEpisodeVideoTail(
  clips: ResolvedRenderClip[],
  segments: AsrSegment[],
  episodeSourceDurationMs: Record<string, number>,
  maxTailGapMs = DEFAULT_EPISODE_VIDEO_TAIL_GAP_MS,
  endToleranceMs = 80,
): { clips: ResolvedRenderClip[]; repairs: string[] } {
  if (!clips.length) return { clips, repairs: [] };

  const bounds = episodeLastAsrBounds(segments);
  const repairs: string[] = [];
  const extended = clips.map((clip) => {
    const ep = renderEpisodeKey(clip);
    const tail = bounds.get(ep);
    const sourceDurationMs = episodeSourceDurationMs[ep] ?? episodeSourceDurationMs.default;
    if (!tail || !sourceDurationMs || sourceDurationMs <= tail.lastEndMs) return clip;
    if (Math.abs(clip.endMs - tail.lastEndMs) > endToleranceMs) return clip;
    const gap = sourceDurationMs - tail.lastEndMs;
    if (gap <= 0 || gap > maxTailGapMs) return clip;
    repairs.push(
      `${clip.segmentId} 集尾切条延伸 ${clip.endMs}→${sourceDurationMs}ms（+${gap}ms 无台词转场）`,
    );
    return { ...clip, endMs: sourceDurationMs };
  });

  return { clips: extended, repairs };
}

/**
 * 混剪渲染核心：plan 中同一「集内连续块」合并为**一刀**（从块首 start 到块末 end）。
 * 避免 10+ 个 ASR 短句各自 ffmpeg 切条再 concat 导致成片极碎。
 */
export function collapseToEpisodeBlocksForRender(
  clips: ResolvedRenderClip[],
): { clips: ResolvedRenderClip[]; repairs: string[] } {
  if (clips.length === 0) return { clips, repairs: [] };

  const repairs: string[] = [];
  const result: ResolvedRenderClip[] = [{ ...clips[0]! }];

  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i]!;
    const last = result.at(-1)!;
    if (renderEpisodeKey(last) === renderEpisodeKey(clip)) {
      last.endMs = Math.max(last.endMs, clip.endMs);
      last.text = `${last.text} ${clip.text}`.trim();
      repairs.push(`${clip.segmentId} 并入同集块（${last.segmentId}~${clip.segmentId}）`);
    } else {
      result.push({ ...clip });
    }
  }

  return { clips: result, repairs };
}

/**
 * @deprecated 合并后 segmentId 不更新会导致后续 seq 无法续合并；请用 collapseToEpisodeBlocksForRender
 */
export function mergeSameEpisodeContiguousSeqClips(
  clips: ResolvedRenderClip[],
): ResolvedRenderClip[] {
  if (clips.length <= 1) return clips;

  const merged: ResolvedRenderClip[] = [{ ...clips[0]! }];
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i]!;
    const last = merged.at(-1)!;
    const sameSource =
      last.episodeId != null &&
      clip.episodeId != null &&
      last.episodeId === clip.episodeId;
    const lastOrd = parseSegmentOrdinal(last.segmentId);
    const curOrd = parseSegmentOrdinal(clip.segmentId);
    const seqConsecutive =
      sameSource &&
      lastOrd != null &&
      curOrd != null &&
      lastOrd.episodeKey === curOrd.episodeKey &&
      curOrd.index - lastOrd.index === 1;

    if (seqConsecutive) {
      last.endMs = Math.max(last.endMs, clip.endMs);
      last.text = `${last.text} ${clip.text}`.trim();
      continue;
    }
    merged.push({ ...clip });
  }
  return merged;
}

/**
 * 同集相邻 clips 仅在时间轴相接/重叠时合并为一刀（不跨空白合并，避免塞进无关画面）
 */
export function mergeAdjacentClipsForRender(
  clips: ResolvedRenderClip[],
  touchToleranceMs = 300,
): ResolvedRenderClip[] {
  if (clips.length <= 1) return clips;

  const merged: ResolvedRenderClip[] = [{ ...clips[0]! }];
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i]!;
    const last = merged.at(-1)!;
    const sameSource =
      last.episodeId != null &&
      clip.episodeId != null &&
      last.episodeId === clip.episodeId;
    const touching = clip.startMs <= last.endMs + touchToleranceMs;

    if (sameSource && touching) {
      last.endMs = Math.max(last.endMs, clip.endMs);
      last.text = `${last.text} ${clip.text}`.trim();
      continue;
    }
    merged.push({ ...clip });
  }
  return merged;
}

/**
 * 同一源视频（同集）已播放过的时间轴不再重复切：trim 重叠起点或丢弃
 */
export function dedupeOverlappingRenderClips(
  clips: ResolvedRenderClip[],
  overlapToleranceMs = 200,
  minDurationMs = 80,
): { clips: ResolvedRenderClip[]; repairs: string[] } {
  const repairs: string[] = [];
  const result: ResolvedRenderClip[] = [];
  const lastEndByEpisode = new Map<string, number>();

  for (const clip of clips) {
    const ep = clip.episodeId ?? clip.segmentId.replace(/_s\d+$/i, "") ?? "default";
    const lastEnd = lastEndByEpisode.get(ep);
    let startMs = clip.startMs;
    const endMs = clip.endMs;

    if (lastEnd != null && startMs < lastEnd - overlapToleranceMs) {
      repairs.push(
        `${clip.segmentId}: 源视频 ${startMs}~${endMs}ms 与已切 ${lastEnd}ms 重叠，从 ${lastEnd}ms 起`,
      );
      startMs = lastEnd;
    }

    if (endMs - startMs < minDurationMs) {
      repairs.push(`${clip.segmentId}: 去重后时长过短，跳过`);
      continue;
    }

    result.push({ ...clip, startMs, endMs });
    lastEndByEpisode.set(ep, Math.max(lastEnd ?? 0, endMs));
  }

  return { clips: result, repairs };
}

export interface PrepareRenderClipsOptions {
  /** episodeId -> 源视频时长（ms）；单集任务可用 `{ default: durationMs }` */
  episodeSourceDurationMs?: Record<string, number>;
  maxTailGapMs?: number;
  /** hook 开口前视觉前垫（ms），默认 800 */
  hookOpeningPadMs?: number;
  /** 片头允许的最大无声前导（ms），默认 1500 */
  hookMaxLeadSilenceMs?: number;
  /** 关闭 hook 开口校正（默认开启） */
  disableHookOpeningTrim?: boolean;
}

/** 投放片头：开口前垫默认 0.8s */
export const DEFAULT_HOOK_OPENING_PAD_MS = 800;
/** 投放片头：开口前无声硬顶默认 1.5s */
export const DEFAULT_HOOK_MAX_LEAD_SILENCE_MS = 1500;

/**
 * 用原始 ASR 回填首段真实开口（兼容旧库：片头已并到 0 且无 speechStartMs）。
 */
export function backfillSpeechStartFromRaw(
  segments: AsrSegment[],
  rawSegments: RawAsrSegment[] | undefined,
): AsrSegment[] {
  if (!segments.length) return segments;
  const withDefaults = segments.map((seg) => ({
    ...seg,
    speechStartMs: seg.speechStartMs ?? seg.startMs,
  }));
  if (!rawSegments?.length) return withDefaults;

  const firstRawSpeech = [...rawSegments]
    .sort((a, b) => a.startMs - b.startMs)
    .find((r) => r.text.trim().length > 0);
  if (!firstRawSpeech || firstRawSpeech.startMs <= 0) return withDefaults;

  const first = withDefaults[0]!;
  // 仅当首段开口像被片头吞掉（0 或缺失）时回填
  if ((first.speechStartMs ?? 0) > 0) return withDefaults;
  return [{ ...first, speechStartMs: firstRawSpeech.startMs }, ...withDefaults.slice(1)];
}

/**
 * 成片第一刀：按真实开口 − 前垫切，并封顶片头静音。
 * 解决「从文件 0 干等」与「贴词切掉话前画面」两端问题。
 */
export function applyHookOpeningTrim(
  clips: ResolvedRenderClip[],
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    padMs?: number;
    maxLeadSilenceMs?: number;
  } = {},
): { clips: ResolvedRenderClip[]; repairs: string[] } {
  const repairs: string[] = [];
  if (clips.length < 1) return { clips, repairs };

  const padMs = options.padMs ?? DEFAULT_HOOK_OPENING_PAD_MS;
  const maxLeadSilenceMs = options.maxLeadSilenceMs ?? DEFAULT_HOOK_MAX_LEAD_SILENCE_MS;
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));

  // 优先用 plan 首块 / hookSegmentId 对应段的开口；否则用第一刀的 segmentId
  const hookId =
    plan.hookSegmentId?.trim() ||
    plan.clips.find((c) => c.role === "hook")?.segmentId ||
    plan.clips[0]?.segmentId ||
    clips[0]!.segmentId;
  const hookSeg = segmentMap.get(hookId) ?? segmentMap.get(clips[0]!.segmentId);
  const first = clips[0]!;

  // 人工片头：严格使用标记起点，不再做开口前垫偏移
  if (hookSeg?.humanMarkerStartMs != null && hookSeg.highlightType === "hook") {
    const desired = hookSeg.humanMarkerStartMs;
    if (Math.abs(desired - first.startMs) < 40) {
      return { clips, repairs };
    }
    if (desired >= first.endMs - 80) {
      return { clips, repairs };
    }
    repairs.push(
      `hook 人工起点校正 ${first.segmentId}: ${first.startMs}→${desired}ms（人工标记严格起点）`,
    );
    return {
      clips: [{ ...first, startMs: desired }, ...clips.slice(1)],
      repairs,
    };
  }

  const onset =
    hookSeg?.speechStartMs ??
    segmentMap.get(first.segmentId)?.speechStartMs ??
    first.startMs;

  // 仅校正「第一刀覆盖了开口」的情况（同集且时间轴盖住 onset）
  const coversOnset =
    first.startMs <= onset + 50 && first.endMs > onset + 200;
  if (!coversOnset) {
    return { clips, repairs };
  }

  let desired = Math.max(0, onset - padMs);
  // 前垫过大时抬起点，保证开口前无声不超过静音顶
  const minStartForMaxLead = Math.max(0, onset - maxLeadSilenceMs);
  if (desired < minStartForMaxLead) {
    desired = minStartForMaxLead;
  }
  // 显式 trim 更狠时保留（LLM/人工已多切片头）
  const headClip = plan.clips[0];
  if (headClip?.trimStartMs != null && headClip.trimStartMs > 0) {
    const headSeg = segmentMap.get(headClip.segmentId);
    if (headSeg) {
      desired = Math.max(desired, headSeg.startMs + headClip.trimStartMs);
    }
  }

  if (Math.abs(desired - first.startMs) < 40) {
    return { clips, repairs };
  }
  if (desired >= first.endMs - 80) {
    return { clips, repairs };
  }

  repairs.push(
    `hook 开口校正 ${first.segmentId}: ${first.startMs}→${desired}ms（开口=${onset}ms，前垫=${padMs}ms，静音顶=${maxLeadSilenceMs}ms）`,
  );
  return {
    clips: [{ ...first, startMs: desired }, ...clips.slice(1)],
    repairs,
  };
}

/** 成片最后一刀：人工片尾标记严格使用 humanMarkerEndMs */
export function applyCliffClosingTrim(
  clips: ResolvedRenderClip[],
  plan: ClipPlan,
  segments: AsrSegment[],
): { clips: ResolvedRenderClip[]; repairs: string[] } {
  const repairs: string[] = [];
  if (clips.length < 1) return { clips, repairs };

  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const cliffClip =
    plan.clips.find((c) => c.role === "cliff") ?? plan.clips.at(-1);
  const last = clips.at(-1)!;
  const cliffId = cliffClip?.throughSegmentId ?? cliffClip?.segmentId ?? last.segmentId;
  const cliffSeg = segmentMap.get(cliffId) ?? segmentMap.get(last.segmentId);

  if (
    !cliffSeg?.humanMarkerEndMs ||
    !isWorkstationClosingMarker(cliffSeg.highlightType, cliffSeg.highlightTags?.[0])
  ) {
    return { clips, repairs };
  }

  const desired = cliffSeg.humanMarkerEndMs;
  if (desired <= last.startMs + 80) return { clips, repairs };
  if (Math.abs(desired - last.endMs) < 40) return { clips, repairs };

  repairs.push(
    `cliff 人工终点校正 ${last.segmentId}: ${last.endMs}→${desired}ms（人工片尾严格终点）`,
  );
  return {
    clips: [...clips.slice(0, -1), { ...last, endMs: desired }],
    repairs,
  };
}

/** 渲染前：解析时间轴 → 同集块合并为一刀 → hook 开口校正 → cliff 片尾校正 → 集尾延伸至视频结尾 → 去重叠 */
export function prepareRenderClips(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: PrepareRenderClipsOptions = {},
): { clips: ResolvedRenderClip[]; repairs: string[]; durationSec: number } {
  const resolved = resolveClipTimestamps(plan, segments);
  const { clips: collapsed, repairs: collapseRepairs } = collapseToEpisodeBlocksForRender(resolved);
  const { clips: hookTrimmed, repairs: hookRepairs } = options.disableHookOpeningTrim
    ? { clips: collapsed, repairs: [] as string[] }
    : applyHookOpeningTrim(collapsed, plan, segments, {
        padMs: options.hookOpeningPadMs,
        maxLeadSilenceMs: options.hookMaxLeadSilenceMs,
      });
  const { clips: cliffTrimmed, repairs: cliffRepairs } = applyCliffClosingTrim(
    hookTrimmed,
    plan,
    segments,
  );
  const tailGapMs = options.maxTailGapMs ?? DEFAULT_EPISODE_VIDEO_TAIL_GAP_MS;
  const { clips: tailExtended, repairs: tailRepairs } = options.episodeSourceDurationMs
    ? extendRenderClipsToEpisodeVideoTail(
        cliffTrimmed,
        segments,
        options.episodeSourceDurationMs,
        tailGapMs,
      )
    : { clips: cliffTrimmed, repairs: [] as string[] };
  const { clips, repairs: dedupeRepairs } = dedupeOverlappingRenderClips(tailExtended);
  const repairs = [...collapseRepairs, ...hookRepairs, ...cliffRepairs, ...tailRepairs, ...dedupeRepairs];
  return { clips, repairs, durationSec: computeRenderClipsDurationSec(clips) };
}
