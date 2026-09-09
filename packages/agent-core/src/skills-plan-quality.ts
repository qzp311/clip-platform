import type {
  AsrSegment,
  ClipPlan,
  ClipPlanBatch,
  ClipPlanClip,
  DurationStatus,
  MixRenderRecord,
  SkillsPlanQuality,
  SkillsPlanQualityReport,
  TargetDurationLabel,
} from "@clip/sdk";
import {
  isAtEpisodeEnd,
  isNearEpisodeStart,
  detectWholeEpisodeRuns,
} from "./episode-boundary-anchors.js";
import { parseSegmentOrdinal } from "./clip-plan-coherence.js";
import {
  isStrongBurstScore,
  isWeakClipReason,
  scoreBurstSegment,
} from "./burst-heuristic.js";
import {
  annotatePlanDurationMeta,
  computeClipsDurationSecWithThrough,
  hasRevealSpoilerEnding,
  inferDurationStatus,
  resolveTargetDurationSec,
  SMART_PLAN_HARD_MIN_DURATION_SEC,
  SMART_PLAN_MAX_DURATION_SEC,
  SMART_PLAN_MIN_DURATION_SEC,
} from "./smart-clip-plan.js";

export type { SkillsPlanQuality, SkillsPlanQualityReport };

const SKILLS_BLOCKING_ISSUE_MARKERS = [
  "同集拆成",
  "片尾未贴",
  "片尾块 through",
  "隔集跳戏",
  "集序倒跳",
  "方案过短",
  "方案过长",
  "块过少",
  "稀疏单段",
  "话未说完",
  "跳场碎切",
  "场面未收束",
  "缺少 setupClaim",
  "缺少 advanceClaim",
  "缺少 openLoopClaim",
  "片尾揭底",
] as const;

/** Skill：换集必须严格相邻 eN→eN+1（episodeNo 差 = 1）；禁止任何隔空 */
const MAX_EPISODE_SKIP = 0;

/** 成片 hook 段前导静音硬上限（ms）：超过即开头空镜/无声过长，浪费前 3 秒钩子 */
const MAX_HOOK_LEAD_SILENCE_MS = 1200;

/** 单段内允许的最大前导静音（ms）：超过说明该段开头有大段空镜 */
const MAX_ANY_LEAD_SILENCE_MS = 2500;

function isHookDrivenPlan(plan: ClipPlan): boolean {
  return (
    plan.editForm === "hook_first" ||
    plan.editForm === "skip_episode" ||
    Boolean(plan.hookSegmentId?.trim()) ||
    Boolean(plan.hookType?.trim())
  );
}

function isOpeningBoundaryWarning(msg: string): boolean {
  return msg.includes("片头未贴");
}

/** 扫描 through 块或展开 clips 的跨集跳跃 / 倒跳 */
function collectEpisodeJumpIssues(
  clips: ClipPlanClip[],
  segmentMap: Map<string, AsrSegment>,
): string[] {
  const issues: string[] = [];
  let prevEpNo: number | null = null;
  for (const clip of clips) {
    const seg = segmentMap.get(clip.segmentId);
    let epNo = seg?.episodeNo ?? 0;
    if (!epNo) {
      const ord = parseSegmentOrdinal(clip.segmentId, seg);
      const m = ord?.episodeKey.match(/^e(\d+)$/i);
      if (m) epNo = Number.parseInt(m[1]!, 10);
    }
    if (!epNo) continue;
    if (prevEpNo != null && epNo !== prevEpNo) {
      if (epNo < prevEpNo) {
        issues.push(`集序倒跳: ep${prevEpNo}→ep${epNo}（${clip.segmentId}）`);
      } else if (epNo - prevEpNo > MAX_EPISODE_SKIP + 1) {
        issues.push(
          `隔集跳戏: ep${prevEpNo}→ep${epNo}（隔 ${epNo - prevEpNo - 1} 集，必须相邻 eN→eN+1，禁止隔空；${clip.segmentId}）`,
        );
      }
    }
    prevEpNo = epNo;
  }
  return issues;
}

/** 叙事可验收字段：存在性硬拦；过短/敷衍扣分 */
function collectNarrativeClaimIssues(plan: ClipPlan): string[] {
  const issues: string[] = [];
  const setup = plan.setupClaim?.trim() ?? "";
  const advance = plan.advanceClaim?.trim() ?? "";
  const openLoop = plan.openLoopClaim?.trim() ?? "";
  if (!setup) issues.push("缺少 setupClaim（须一句话说清谁因何起冲突）");
  else if (setup.length < 8) issues.push("setupClaim 过短，路人听不懂建置");
  if (!advance) issues.push("缺少 advanceClaim（须说明中段相对开头推进了什么）");
  else if (advance.length < 8) issues.push("advanceClaim 过短，中段无实质推进表述");
  if (!openLoop) issues.push("缺少 openLoopClaim（须说明片尾欠什么、如何回扣前文）");
  else if (openLoop.length < 8) issues.push("openLoopClaim 过短，片尾未解说不清");

  const intro = plan.introReason?.trim() ?? "";
  if (intro && /^(好|行|可以|冲突|高能|爆点|钩子)$/.test(intro)) {
    issues.push("introReason 敷衍，须写清路人听懂了什么");
  }
  return issues;
}

function isWeakClaimIssue(msg: string): boolean {
  return (
    msg.includes("过短") ||
    msg.includes("敷衍") ||
    msg.includes("setupClaim 过短") ||
    msg.includes("advanceClaim 过短") ||
    msg.includes("openLoopClaim 过短")
  );
}

/** outroReason 提到的集号应与实际片尾集一致，避免文案假对齐 */
function collectOutroAlignmentIssues(plan: ClipPlan, closingEpisodeId?: string): string[] {
  const outro = plan.outroReason?.trim();
  if (!outro || !closingEpisodeId) return [];
  const mentioned = [...outro.matchAll(/e(\d{1,3})(?:_s\d+|\b)/gi)].map(
    (m) => `e${m[1]!.padStart(2, "0")}`,
  );
  if (!mentioned.length) return [];
  const closeKey = closingEpisodeId.toLowerCase();
  if (mentioned.some((id) => id.toLowerCase() === closeKey)) return [];
  return [
    `outroReason 提及 ${[...new Set(mentioned)].slice(0, 3).join("/")}，与实际片尾 ${closingEpisodeId} 不一致`,
  ];
}

export function isSkillsPlanAcceptable(
  quality: SkillsPlanQuality,
  options: { minScore?: number } = {},
): boolean {
  const minScore = options.minScore ?? 70;
  if (quality.score < minScore) return false;
  if (!quality.closingAtEpisodeEnd) return false;
  return !quality.issues.some((issue) =>
    SKILLS_BLOCKING_ISSUE_MARKERS.some((m) => issue.includes(m)),
  );
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

const TARGET_MIN_CLIPS: Record<TargetDurationLabel, number> = {
  "3min": 8,
  "10min": 20,
};

function scoreDuration(
  plan: ClipPlan,
  durationStatus?: DurationStatus,
): { points: number; issue?: string } {
  const label = plan.targetDurationLabel;
  const sec = plan.estimatedDurationSec ?? 0;
  if (!label) {
    if (sec >= 120) return { points: 8 };
    return { points: 4, issue: `时长偏短（${sec}s）` };
  }
  const minSec = SMART_PLAN_MIN_DURATION_SEC[label];
  const maxSec = SMART_PLAN_MAX_DURATION_SEC[label];
  const preferred = resolveTargetDurationSec(label);
  const minClips = TARGET_MIN_CLIPS[label];

  if (sec > maxSec) {
    return {
      points: 0,
      issue: `${label} 方案过长（${Math.round(sec)}s > ${maxSec}s；目标约 ${preferred}s，请先缩 through 再减整场）`,
    };
  }
  // 3min：硬下限=偏好；10min：硬下限 180s，480 为偏好（偏短可出片）
  const hardFloorSec = SMART_PLAN_HARD_MIN_DURATION_SEC[label];
  if (sec < hardFloorSec) {
    return {
      points: 0,
      issue: `${label} 方案过短（${Math.round(sec)}s < ${hardFloorSec}s${label === "10min" ? "，不成片" : ""}）`,
    };
  }
  if (label === "10min" && sec < minSec) {
    return {
      points: 5,
      issue: `${label} 时长偏短（${Math.round(sec)}s，目标约 ${preferred}s，偏短可出片）`,
    };
  }
  if (durationStatus === "under_preferred") {
    return { points: 5, issue: `${label} 时长未达偏好（${sec}s，目标约 ${preferred}s）` };
  }
  if (durationStatus === "over_preferred" || sec > preferred + Math.max(30, preferred * 0.15)) {
    return {
      points: 6,
      issue: `${label} 时长偏长（${Math.round(sec)}s，目标约 ${preferred}s）`,
    };
  }
  if (plan.clips.length < minClips) {
    return { points: 6, issue: `${label} 选段过少（${plan.clips.length} < ${minClips}）` };
  }
  return { points: 10 };
}

function episodeKeyForSegment(seg: AsrSegment | undefined, segmentId: string): string {
  return seg?.episodeId ?? parseSegmentOrdinal(segmentId, seg)?.episodeKey ?? "default";
}

/** through 块覆盖的同集连续段数；无 through 时按 1 计 */
function countBlockSegmentSpan(
  clip: ClipPlanClip,
  byEpisode: Map<string, AsrSegment[]>,
  segmentMap: Map<string, AsrSegment>,
): number {
  const startId = clip.segmentId;
  const endId = clip.throughSegmentId?.trim() || startId;
  const startSeg = segmentMap.get(startId);
  const epKey = episodeKeyForSegment(startSeg, startId);
  const list = byEpisode.get(epKey) ?? [];
  const si = list.findIndex((s) => s.segmentId === startId);
  const ei = list.findIndex((s) => s.segmentId === endId);
  if (si < 0 || ei < 0) return startId === endId ? 1 : 2;
  return Math.max(1, Math.abs(ei - si) + 1);
}

/** 10min：块太少或 escalate/hook 大量碎切 → 时长假长 / 故事空心 */
function collectLongPlanStructureIssues(
  plan: ClipPlan,
  scoringClips: ClipPlanClip[],
  byEpisode: Map<string, AsrSegment[]>,
  segmentMap: Map<string, AsrSegment>,
): string[] {
  if (plan.targetDurationLabel !== "10min") return [];
  const issues: string[] = [];
  const structureClips = coalesceExpandedRunsForSceneCheck(scoringClips);
  if (structureClips.length < 3) {
    issues.push(`10min 块过少（${structureClips.length} < 3，应用 3~5 个「说到收束」的 through 块，勿灌满 6 集）`);
  }
  if (structureClips.length > 5) {
    issues.push(
      `10min 块过多（${structureClips.length} > 5，勿为凑时长灌满多集整集；应 3~4 集精取冲突场）`,
    );
  }
  const bodyClips = structureClips.filter((c) => c.role !== "cliff" && c.role !== "cta");
  // 短剧单集常仅 8~12 句，3 段已可能是完整交锋；过严的 5 段阈值会逼模型加厚却爆时长
  const sparse = bodyClips.filter(
    (c) => countBlockSegmentSpan(c, byEpisode, segmentMap) < 3,
  );
  if (sparse.length >= 3) {
    issues.push(
      `10min 稀疏单段块过多（${sparse.length} 个 hook/escalate 不足 3 段：${sparse
        .slice(0, 3)
        .map((c) => c.segmentId)
        .join(",")}；须一场戏说到停顿再换集）`,
    );
  }
  return issues;
}

type SceneBlock = {
  segmentId: string;
  role: string;
  epKey: string;
  startIdx: number;
  endIdx: number;
  span: number;
  epLen: number;
};

function resolveSceneBlock(
  clip: ClipPlanClip,
  byEpisode: Map<string, AsrSegment[]>,
  segmentMap: Map<string, AsrSegment>,
): SceneBlock | null {
  const startId = clip.segmentId;
  const endId = clip.throughSegmentId?.trim() || startId;
  const startSeg = segmentMap.get(startId);
  const epKey = episodeKeyForSegment(startSeg, startId);
  const list = byEpisode.get(epKey) ?? [];
  if (!list.length) return null;
  const si = list.findIndex((s) => s.segmentId === startId);
  const ei = list.findIndex((s) => s.segmentId === endId);
  if (si < 0 || ei < 0) return null;
  const lo = Math.min(si, ei);
  const hi = Math.max(si, ei);
  return {
    segmentId: startId,
    role: clip.role ?? "escalate",
    epKey,
    startIdx: lo,
    endIdx: hi,
    span: hi - lo + 1,
    epLen: list.length,
  };
}

/** 展开后的逐段 clips 合并为「同集连续 run」，避免误判碎切 */
function coalesceExpandedRunsForSceneCheck(clips: ClipPlanClip[]): ClipPlanClip[] {
  if (!clips.length) return [];
  // 已是 LLM through 块：原样检测
  if (clips.some((c) => Boolean(c.throughSegmentId?.trim()))) return clips;

  const runs: ClipPlanClip[] = [];
  let i = 0;
  while (i < clips.length) {
    const head = clips[i]!;
    if (head.role === "cta") {
      i += 1;
      continue;
    }
    let j = i;
    const headOrd = parseSegmentOrdinal(head.segmentId, undefined);
    while (j + 1 < clips.length) {
      const next = clips[j + 1]!;
      if (next.role === "cta") break;
      const nextOrd = parseSegmentOrdinal(next.segmentId, undefined);
      if (!headOrd || !nextOrd || headOrd.episodeKey !== nextOrd.episodeKey) break;
      if (nextOrd.index !== headOrd.index + (j - i) + 1) break;
      j += 1;
    }
    const tail = clips[j]!;
    runs.push({
      segmentId: head.segmentId,
      throughSegmentId: tail.segmentId,
      role: tail.role === "cliff" || head.role === "cliff" ? "cliff" : head.role,
      reason: head.reason,
    });
    i = j + 1;
  }
  return runs;
}

/**
 * 检测「话未说完就切走」：块过短且身后还有戏，或多个碎切跳场。
 * 允许冲突中段起、可说到近集尾；禁止只掐 2~4 句就换集。
 */
function collectSceneCutIssues(
  scoringClips: ClipPlanClip[],
  byEpisode: Map<string, AsrSegment[]>,
  segmentMap: Map<string, AsrSegment>,
): string[] {
  const blocks = coalesceExpandedRunsForSceneCheck(scoringClips)
    .filter((c) => c.role !== "cta")
    .map((c) => resolveSceneBlock(c, byEpisode, segmentMap))
    .filter((b): b is SceneBlock => Boolean(b));
  if (blocks.length < 2) return [];

  const issues: string[] = [];
  const midBlocks = blocks.filter((b) => b.role !== "cliff");

  for (const b of midBlocks) {
    // 非 cliff：身后还有较多戏却块很短 → 话未说完
    // 已说到本集后半/近集尾（收束）则放行
    const remaining = b.epLen - 1 - b.endIdx;
    const closedEnough = remaining <= 2 || b.endIdx >= Math.floor(b.epLen * 0.55);
    if (b.epLen >= 8 && b.span < 6 && remaining >= 3 && !closedEnough) {
      issues.push(
        `话未说完就切走: ${b.epKey} 块仅 ${b.span} 段且身后还有 ${remaining} 段（${b.segmentId}；须通过到本场停顿/转折再换集）`,
      );
    }
  }

  const choppy = midBlocks.filter((b) => {
    const remaining = b.epLen - 1 - b.endIdx;
    const closedEnough = remaining <= 2 || b.endIdx >= Math.floor(b.epLen * 0.55);
    return b.epLen >= 7 && b.span < 5 && !closedEnough;
  });
  if (choppy.length >= 2) {
    issues.push(
      `跳场碎切: ${choppy.length} 个块不足 5 段（${choppy
        .slice(0, 4)
        .map((b) => b.segmentId)
        .join(",")}；禁止为凑邻集掐半句换集）`,
    );
  }

  for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    if (a.epKey === b.epKey) continue;
    if (a.role === "cliff") continue;
    const aRemaining = a.epLen - 1 - a.endIdx;
    // 上一场已近集尾收束则不算「掐断跳场」
    if (aRemaining <= 2) continue;
    if (a.span <= 5 && b.startIdx >= 4 && b.span <= 6 && a.epLen >= 7) {
      issues.push(
        `场面未收束跨集: ${a.epKey}（${a.span} 段）掐断后 ${b.epKey} 从中后段切入（${b.segmentId}）；请先收束上一场，下集从该场线头接`,
      );
    }
  }

  // 去重，最多 6 条，避免刷屏
  return [...new Set(issues)].slice(0, 6);
}

function countDistinctEpisodesInPlan(plan: ClipPlan, segmentMap: Map<string, AsrSegment>): number {
  const eps = new Set<string>();
  for (const clip of plan.clips) {
    eps.add(episodeKeyForSegment(segmentMap.get(clip.segmentId), clip.segmentId));
  }
  return eps.size;
}

function gradeFromScore(score: number): SkillsPlanQuality["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

export function evaluateSkillsPlanQuality(
  plan: ClipPlan,
  segments: AsrSegment[],
  options: {
    warnings?: string[];
    mechanicalRepairs?: string[];
    /** 块级 clips（LLM through 块）：reason/结构评分；时长取 max(块意图, 展开后) 防假短漏拦过长 */
    scoringClips?: ClipPlanClip[];
  } = {},
): SkillsPlanQuality {
  const segmentMap = new Map(segments.map((s) => [s.segmentId, s]));
  const byEpisode = segmentsByEpisode(segments);
  const issues: string[] = [];
  const warnings = [...(options.warnings ?? [])];
  const reasonClips = options.scoringClips?.length ? options.scoringClips : plan.clips;
  const structurePlan =
    options.scoringClips?.length ? { ...plan, clips: options.scoringClips } : plan;

  let score = 0;
  // 时长：块意图与展开后取更大，避免 through 未展开时漏判「方案过长」
  const blockIntentSec = computeClipsDurationSecWithThrough(reasonClips, segments);
  const expandedSec = computeClipsDurationSecWithThrough(plan.clips, segments);
  const durationSec = Math.max(blockIntentSec, expandedSec);
  const annotated = {
    ...annotatePlanDurationMeta(plan, segments),
    estimatedDurationSec: durationSec,
    durationStatus: inferDurationStatus(durationSec, plan.targetDurationLabel),
  };
  const durationStatus = annotated.durationStatus;

  const firstClip = plan.clips[0];
  const lastClip = plan.clips.at(-1);
  let openingNearEpisodeStart = false;
  let closingAtEpisodeEnd = false;
  let openingEpisodeId: string | undefined;
  let openingSegmentId: string | undefined;
  let closingEpisodeId: string | undefined;
  let closingSegmentId: string | undefined;
  let episodeLastSegmentId: string | undefined;

  if (firstClip) {
    openingSegmentId = firstClip.segmentId;
    const firstSeg = segmentMap.get(firstClip.segmentId);
    openingEpisodeId = episodeKeyForSegment(firstSeg, firstClip.segmentId);
    const firstList = byEpisode.get(openingEpisodeId) ?? [];
    openingNearEpisodeStart = firstList.length > 0 && isNearEpisodeStart([firstClip], firstList);

    const hookDriven = isHookDrivenPlan(plan);
    const openingBurst = firstSeg ? (firstSeg.highlightScore ?? scoreBurstSegment(firstSeg).score) : 0;

    if (hookDriven) {
      if (isStrongBurstScore(openingBurst) || Boolean(plan.hookType?.trim())) {
        score += 15;
      } else {
        issues.push(
          `片头缺爆点（${firstClip.segmentId}），请从爆点候选选羞辱/反转/身份差段作 hook`,
        );
        score += 5;
      }
      // 片头空镜/无声控制：投放 hook 前 3 秒不能有大段空白，否则钩子浪费
      if (firstSeg) {
        const onset = firstSeg.speechStartMs ?? firstSeg.startMs;
        const leadSilence = Math.max(0, onset - firstSeg.startMs);
        const isEpisodeHead =
          firstList[0]?.segmentId === firstSeg.segmentId || firstSeg.startMs <= 80;
        // 片头空镜/无声提示：前 3 秒空白会浪费钩子，soft 扣分不硬拦
        if (isEpisodeHead && leadSilence >= MAX_ANY_LEAD_SILENCE_MS && !isStrongBurstScore(openingBurst)) {
          issues.push(
            `片头空镜过长（开口约 ${Math.round(onset / 100) / 10}s），建议换冲突高光段作 hook，避免纯集首静音`,
          );
          score -= 6;
        }
        if (leadSilence > MAX_HOOK_LEAD_SILENCE_MS) {
          issues.push(
            `片头空镜过长（前导静音 ${Math.round(leadSilence)}ms > ${MAX_HOOK_LEAD_SILENCE_MS}ms），建议换冲突段作 hook；如非它不可请在 introReason 说明必要性`,
          );
          score -= 12;
        }
      }
    } else if (!openingNearEpisodeStart && firstList.length) {
      issues.push(`片头未贴 ${openingEpisodeId} 集首（${firstClip.segmentId}）`);
    } else {
      score += 15;
    }
  } else {
    issues.push("方案无片段");
  }

  if (lastClip) {
    closingSegmentId = lastClip.segmentId;
    const lastSeg = segmentMap.get(lastClip.segmentId);
    closingEpisodeId = episodeKeyForSegment(lastSeg, lastClip.segmentId);
    const lastList = byEpisode.get(closingEpisodeId) ?? [];
    episodeLastSegmentId = lastList.at(-1)?.segmentId;
    closingAtEpisodeEnd = lastList.length > 0 && isAtEpisodeEnd(plan.clips, lastList);
    if (!closingAtEpisodeEnd) {
      issues.push(
        `片尾未贴 ${closingEpisodeId} 集尾（末段 ${lastClip.segmentId}，集尾 ${episodeLastSegmentId ?? "?"}）`,
      );
    } else {
      score += 30;
    }
  }

  const hasOutroReason = Boolean(plan.outroReason?.trim());
  const hasIntroReason = Boolean(plan.introReason?.trim());
  const hasSynopsisAlignment = Boolean(plan.synopsisAlignment?.trim());
  const hasSetupClaim = Boolean(plan.setupClaim?.trim());
  const hasAdvanceClaim = Boolean(plan.advanceClaim?.trim());
  const hasOpenLoopClaim = Boolean(plan.openLoopClaim?.trim());

  if (hasOutroReason) score += 15;
  else issues.push("缺少 outroReason");

  if (hasIntroReason) score += 10;
  else issues.push("缺少 introReason");

  if (hasSynopsisAlignment) score += 10;
  else issues.push("缺少 synopsisAlignment");

  if (hasSetupClaim) score += 5;
  if (hasAdvanceClaim) score += 5;
  if (hasOpenLoopClaim) score += 5;

  const durationScore = scoreDuration(annotated, durationStatus);
  score += durationScore.points;
  if (durationScore.issue) issues.push(durationScore.issue);

  if (plan.clips.length < 2) issues.push("片段数不足 2");

  let weakReasonHits = 0;
  for (const clip of reasonClips) {
    if (isWeakClipReason(clip.reason)) weakReasonHits += 1;
  }
  if (weakReasonHits > 0) {
    issues.push(`部分块 reason 过于平淡（${weakReasonHits}/${reasonClips.length}）`);
    score -= Math.min(8, weakReasonHits * 3);
  }

  if (plan.editForm === "hook_first" && !plan.hookSegmentId?.trim()) {
    issues.push("hook_first 缺少 hookSegmentId");
    score -= 3;
  }

  const wholeEpisodeWarnings = detectWholeEpisodeRuns(structurePlan, segments);
  for (const w of wholeEpisodeWarnings) {
    if (!warnings.includes(w)) warnings.push(w);
    if (!issues.includes(w)) issues.push(w);
    score -= 15;
  }

  // 叙事通顺：跨集倒跳 / 隔空集 — 用块级 clips 优先（避免展开段重复计）
  const jumpClips = options.scoringClips?.length ? options.scoringClips : plan.clips;
  const jumpIssues = collectEpisodeJumpIssues(jumpClips, segmentMap);
  for (const ji of jumpIssues) {
    if (!issues.includes(ji)) issues.push(ji);
    if (!warnings.includes(ji)) warnings.push(ji);
    score -= ji.includes("倒跳") ? 25 : 20;
  }

  // 10min：禁止「5 个单句跳集」冒充长投
  for (const li of collectLongPlanStructureIssues(plan, reasonClips, byEpisode, segmentMap)) {
    if (!issues.includes(li)) issues.push(li);
    score -= 18;
  }

  // 场面收束：禁止话未说完就换集 / 跳场碎切
  for (const si of collectSceneCutIssues(reasonClips, byEpisode, segmentMap)) {
    if (!issues.includes(si)) issues.push(si);
    if (!warnings.includes(si)) warnings.push(si);
    score -= 20;
  }

  for (const oi of collectOutroAlignmentIssues(plan, closingEpisodeId)) {
    if (!issues.includes(oi)) issues.push(oi);
    score -= 8;
  }

  // 叙事可验收：缺字段硬拦；过短/敷衍扣分
  for (const ni of collectNarrativeClaimIssues(plan)) {
    if (!issues.includes(ni)) issues.push(ni);
    if (ni.startsWith("缺少 ")) score -= 12;
    else if (isWeakClaimIssue(ni)) score -= 6;
  }

  // 片尾已彻底揭底 → 投放完播差
  if (hasRevealSpoilerEnding(plan, segments)) {
    const msg = "片尾揭底（落在已说明真相的完整句，应改将揭未揭）";
    if (!issues.includes(msg)) issues.push(msg);
    score -= 18;
  }

  // filler/孤立回答语气词出现在关键位置：soft 提示，不硬拦；让 LLM 知道成片会突兀
  const scoringClipsForFiller = options.scoringClips?.length ? options.scoringClips : plan.clips;
  for (const fi of collectFillerClipIssues(scoringClipsForFiller, segmentMap)) {
    if (!warnings.includes(fi)) warnings.push(fi);
    score -= 5;
  }
  for (const bei of collectBlockEndpointIssues(scoringClipsForFiller, segmentMap)) {
    if (!warnings.includes(bei)) warnings.push(bei);
    score -= 5;
  }

  // 开篇可懂：introReason 须能回答「路人听懂了什么」
  const intro = plan.introReason?.trim() ?? "";
  if (intro && intro.length >= 12 && plan.setupClaim?.trim()) {
    score += 4;
  }

  // 预标只是候选：若开篇非 usableAsHook 但有 setupClaim，不额外惩罚（已在 hook 爆点项处理）
  // 若开篇是最高分钩子但缺 setupClaim，已在缺少 setupClaim 硬拦

  const hookDrivenFinal = isHookDrivenPlan(plan);
  for (const w of warnings) {
    if (hookDrivenFinal && isOpeningBoundaryWarning(w)) continue;
    if (!issues.includes(w)) issues.push(w);
  }

  if (options.mechanicalRepairs?.length) {
    for (const r of options.mechanicalRepairs) {
      const msg = `机械处理: ${r}`;
      if (!warnings.includes(msg)) warnings.push(msg);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    grade: gradeFromScore(score),
    closingAtEpisodeEnd,
    openingNearEpisodeStart,
    hasOutroReason,
    hasIntroReason,
    hasSynopsisAlignment,
    hasSetupClaim,
    hasAdvanceClaim,
    hasOpenLoopClaim,
    estimatedDurationSec: annotated.estimatedDurationSec ?? 0,
    targetDurationSec: resolveTargetDurationSec(plan.targetDurationLabel, plan.targetDurationSec),
    clipCount: plan.clips.length,
    episodeCount: countDistinctEpisodesInPlan(plan, segmentMap),
    durationStatus,
    targetDurationLabel: plan.targetDurationLabel,
    openingEpisodeId,
    openingSegmentId,
    closingEpisodeId,
    closingSegmentId,
    episodeLastSegmentId,
    issues,
    warnings,
    mechanicalRepairs: options.mechanicalRepairs,
  };
}

export function buildSkillsPlanQualityReport(input: {
  planBatches?: ClipPlanBatch[];
  segments: AsrSegment[];
  clipSelectionMode?: string;
  skillVersion?: string;
  requestedTaskId?: string;
  sourceTaskId?: string;
  sourceTaskKind?: string;
}): SkillsPlanQualityReport {
  const batches = input.planBatches ?? [];
  const rounds: SkillsPlanQualityReport["rounds"] = [];
  let totalPlans = 0;
  let passCount = 0;
  let scoreSum = 0;
  const issueCounts = new Map<string, number>();

  for (const batch of batches) {
    const plans = batch.plans.map((plan, planIndex) => {
      const quality = evaluateSkillsPlanQuality(plan, input.segments, {
        warnings: plan.skillsQuality?.warnings ?? [],
        mechanicalRepairs: plan.skillsQuality?.mechanicalRepairs,
        scoringClips: plan.llmSourceClips?.length ? plan.llmSourceClips : undefined,
      });
      totalPlans += 1;
      scoreSum += quality.score;
      if (quality.score >= 75 && quality.closingAtEpisodeEnd) passCount += 1;
      for (const issue of quality.issues) {
        issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
      }
      return {
        planIndex: planIndex + 1,
        strategy: plan.strategy,
        narrativeLine: plan.narrativeLine,
        editForm: plan.editForm,
        targetDurationLabel: plan.targetDurationLabel,
        quality,
      };
    });
    rounds.push({
      round: batch.round,
      totalRounds: batch.totalRounds,
      skillVersion: batch.skillVersion ?? input.skillVersion,
      plans,
    });
  }

  const commonIssues = [...issueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([issue, count]) => ({ issue, count }));

  return {
    clipSelectionMode: input.clipSelectionMode ?? "unknown",
    skillVersion: input.skillVersion,
    segmentCount: input.segments.length,
    totalPlans,
    passCount,
    avgScore: totalPlans ? Math.round(scoreSum / totalPlans) : 0,
    requestedTaskId: input.requestedTaskId,
    sourceTaskId: input.sourceTaskId,
    sourceTaskKind: input.sourceTaskKind as SkillsPlanQualityReport["sourceTaskKind"],
    rounds,
    commonIssues,
  };
}

/**
 * 检测 filler/孤立回答段被错误地当成 hook、through 块起止点或独立 clip。
 * 只针对 plan.clips 里的段（through 块展开后另行检查）。
 */
function collectFillerClipIssues(
  clips: ClipPlanClip[],
  segmentMap: Map<string, AsrSegment>,
): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const seg = segmentMap.get(clip.segmentId);
    if (!seg) continue;
    if (seg.isAnswerFiller) {
      const pos = i === 0 ? "片头" : i === clips.length - 1 ? "片尾" : "中段";
      warnings.push(
        `${pos}为孤立回答语气词（${clip.segmentId}「${seg.text.slice(0, 16)}」），会让成片突兀；建议换段，非它不可请在 reason 说明`, 
      );
      continue;
    }
    if (seg.isFillerOnly) {
      const pos = i === 0 ? "片头" : i === clips.length - 1 ? "片尾" : "中段";
      warnings.push(
        `${pos}为纯 filler 段（${clip.segmentId}「${seg.text.slice(0, 16)}」），无叙事价值；建议换段，非它不可请在 reason 说明`, 
      );
    }
  }
  return [...new Set(warnings)].slice(0, 4);
}

/**
 * 检测 through 块起点或终点本身是 filler/孤立回答段，作为 soft 提示。
 */
function collectBlockEndpointIssues(
  clips: ClipPlanClip[],
  segmentMap: Map<string, AsrSegment>,
): string[] {
  const warnings: string[] = [];
  for (const clip of clips) {
    const startSeg = segmentMap.get(clip.segmentId);
    const endId = clip.throughSegmentId?.trim() || clip.segmentId;
    const endSeg = segmentMap.get(endId);
    if (startSeg?.isAnswerFiller || startSeg?.isFillerOnly) {
      warnings.push(
        `through 块起点为 filler/回答段：${clip.segmentId}「${startSeg.text.slice(0, 16)}」（${startSeg.isAnswerFiller ? "孤立回答" : "纯 filler"}）；建议从语义完整的冲突句起`, 
      );
    }
    if (endSeg?.isAnswerFiller || endSeg?.isFillerOnly) {
      warnings.push(
        `through 块终点为 filler/回答段：${endId}「${endSeg.text.slice(0, 16)}」（${endSeg.isAnswerFiller ? "孤立回答" : "纯 filler"}）；建议说到收束/悬念句止`, 
      );
    }
  }
  return [...new Set(warnings)].slice(0, 4);
}

/** 将 planBatches 中的 skillsQuality 按轮次顺序挂到混剪成片记录上 */
export function attachSkillsQualityToMixRenders(
  mixRenders: MixRenderRecord[],
  planBatches?: ClipPlanBatch[],
): MixRenderRecord[] {
  if (!planBatches?.length || !mixRenders.length) return mixRenders;

  const plansByRound = new Map(planBatches.map((batch) => [batch.round, batch.plans]));
  const byRound = new Map<number, MixRenderRecord[]>();
  for (const render of mixRenders) {
    const list = byRound.get(render.round) ?? [];
    list.push(render);
    byRound.set(render.round, list);
  }

  return mixRenders.map((render) => {
    if (render.skillsQuality) return render;
    const roundRenders = [...(byRound.get(render.round) ?? [])].sort(
      (a, b) => (a.planSeqInRound ?? a.planIndex) - (b.planSeqInRound ?? b.planIndex),
    );
    const seq =
      render.planSeqInRound ??
      roundRenders.findIndex((r) => r === render) + 1;
    const plan = plansByRound.get(render.round)?.[seq - 1];
    if (!plan?.skillsQuality) return render;
    return {
      ...render,
      planSeqInRound: seq,
      skillsQuality: plan.skillsQuality,
    };
  });
}
