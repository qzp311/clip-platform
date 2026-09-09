import type { AsrSegment, GenreProfile } from "@clip/sdk";
import { scoreBurstSegment } from "./burst-heuristic.js";
import { HOOK_BLOCK_KEYWORDS } from "./genre-burst-lexicon.js";
import { HUMAN_HIGHLIGHT_SCORE } from "./human-marker-merge.js";
import { isWorkstationClosingMarker } from "./workstation-marker-types.js";

/** 投放用台词/叙事高光类型（非画面） */
export type HighlightType = "hook" | "conflict" | "twist" | "cliff";

/** 剧情类型 → 混剪时优先匹配的经典必选剧情标签 */
export function resolvePreferredTagsByGenre(profile?: GenreProfile): readonly string[] {
  switch (profile) {
    case "urban_male":
      return ["都市_质疑嘲讽", "都市_侧面实力", "都市_任务出现", "都市_男主装逼", "都市_天降资源"];
    case "era_male":
      return ["年代_任务出现", "年代_侧面实力", "年代_嘲讽打脸", "重生觉醒", "家庭清算"];
    case "sweet_romance":
      return ["闪婚_初遇结婚", "闪婚_身份反差", "闪婚_一夜情怀孕", "闪婚_女主危机", "身份反差甜"];
    case "revenge_female":
      return ["复仇_女主被虐", "复仇_女主开撕", "复仇_寻亲桥段", "极致受辱", "回归打脸", "证据反杀"];
    case "palace_intrigue":
      return ["宫斗_重生穿越", "宫斗_任务出现", "宫斗_女主开撕", "位分博弈", "权力阴谋"];
    case "system_transmigration":
      return ["系统绑定", "规则目标", "任务冲突", "作死任务", "结算惩罚", "歪打正着"];
    default:
      return [];
  }
}

export interface HighlightCandidate {
  segmentId: string;
  episodeId: string;
  episodeNo: number;
  startMs: number;
  /** 真实开口（ms）；渲染建议起点 ≈ speechStartMs − 0.8s */
  speechStartMs: number;
  score: number;
  type: HighlightType;
  tags: string[];
  usableAsHook: boolean;
  preview: string;
}

export interface HighlightPrelabelOptions {
  minScore?: number;
  perEpisodeLimit?: number;
  hookLimit?: number;
  genreProfile?: GenreProfile;
  /** 剧情类型优先匹配的经典必选剧情标签；命中时优先选入高光 */
  preferredTags?: readonly string[];
  /** 优先标签命中加分，默认 1.5 */
  preferredTagBonus?: number;
  /** segmentId → 跨成片已占用次数；用于软降权（不删除候选） */
  segmentUseCounts?: ReadonlyMap<string, number> | Record<string, number>;
  /** 当前批序号（1-based），用于次优 hook 滑动切片 */
  round?: number;
  totalRounds?: number;
  /** 占用降权系数，默认 1.2 */
  useCountPenaltyAlpha?: number;
}

function useCountOf(
  segmentId: string,
  counts: HighlightPrelabelOptions["segmentUseCounts"],
): number {
  if (!counts) return 0;
  if (typeof (counts as Map<string, number>).get === "function") {
    return (counts as Map<string, number>).get(segmentId) ?? 0;
  }
  return (counts as Record<string, number>)[segmentId] ?? 0;
}

function effectiveHighlightScore(
  score: number,
  useCount: number,
  alpha: number,
): number {
  return score / (1 + Math.max(0, useCount) * alpha);
}

const TWIST_HINT =
  /居然|竟然|原来|真相|秘密|没想到|怎么会|其实|假|冒充|不是你的|验DNA|怀孕|继承人|系统|绑定|任务失败|歪打正着/i;
const CLIFF_HINT =
  /等等|先别|还没|未完|下集|明天|走着瞧|你给我等着|到底|究竟|真的假的|别说话|闭嘴|听我说完|倒计时|超时|警告/i;

function textHasAny(text: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    if (kw && text.includes(kw)) return true;
  }
  return false;
}

function episodeIdOf(seg: AsrSegment): string {
  return seg.episodeId ?? seg.segmentId.match(/^(e\d+)/i)?.[1]?.toLowerCase() ?? "unknown";
}

function episodeNoOf(seg: AsrSegment, epId: string): number {
  if (seg.episodeNo && seg.episodeNo > 0) return seg.episodeNo;
  const m = epId.match(/e(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function previewOf(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 36);
}

/** 已合并的人工高光段：预标列表最高优先级，起点用 humanMarkerStartMs */
function humanHighlightCandidatesFromSegments(segments: AsrSegment[]): HighlightCandidate[] {
  const out: HighlightCandidate[] = [];
  for (const seg of segments) {
    if (!(seg.labelSource ?? "").includes("human_marker") || !seg.highlightType) continue;
    const epId = episodeIdOf(seg);
    const onset = seg.humanMarkerStartMs ?? seg.speechStartMs ?? seg.startMs;
    out.push({
      segmentId: seg.segmentId,
      episodeId: epId,
      episodeNo: episodeNoOf(seg, epId),
      startMs: onset,
      speechStartMs: onset,
      score: seg.highlightScore ?? HUMAN_HIGHLIGHT_SCORE,
      type: seg.highlightType as HighlightType,
      tags: seg.highlightTags?.length ? seg.highlightTags : ["人工高光"],
      usableAsHook: Boolean(seg.usableAsHook),
      preview: previewOf(seg.text),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

function classifyType(text: string, burstTags: string[], nearEpisodeEnd: boolean): HighlightType {
  if (CLIFF_HINT.test(text) || (nearEpisodeEnd && burstTags.length > 0)) return "cliff";
  if (
    TWIST_HINT.test(text) ||
    burstTags.some((t) => /反转|身份|关系炸弹|情感背叛|系统|规则|歪打|重生|证据|回归/.test(t))
  ) {
    return "twist";
  }
  if (burstTags.some((t) => /羞辱|决裂|对峙|利益|生死|护短|受辱|位分|作死/.test(t))) {
    return "conflict";
  }
  return "conflict";
}

/**
 * 全自动 ASR 高光预标：台词冲突/反转/悬念强度 + 集内相对峰值 + 近集尾悬念偏置。
 * 不做画面理解；供 Prompt 注入与后续人审对齐。
 */
export function buildHighlightPrelabel(
  segments: AsrSegment[],
  options: HighlightPrelabelOptions = {},
): HighlightCandidate[] {
  const minScore = options.minScore ?? 2;
  const perEpisodeLimit = options.perEpisodeLimit ?? 4;
  const burstOpts = { genreProfile: options.genreProfile };
  const byEp = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const ep = episodeIdOf(seg);
    const list = byEp.get(ep) ?? [];
    list.push(seg);
    byEp.set(ep, list);
  }

  const out: HighlightCandidate[] = [];
  const preferredTags = new Set((options.preferredTags ?? []).filter(Boolean));
  const preferredBonus = options.preferredTagBonus ?? 1.5;
  for (const [epId, list] of [...byEp.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    if (!sorted.length) continue;
    const epEnd = sorted.at(-1)!.endMs;
    const epStart = sorted[0]!.startMs;
    const span = Math.max(1, epEnd - epStart);
    const scored = sorted
      .map((seg) => {
        const text = seg.text.trim();
        // 人工否决（suppress）的段不再进入任何 ASR 候选，防止重算分数"复活"
        if ((seg.labelSource ?? "").includes("suppressed")) return null;
        if (text.length < 4 || textHasAny(text, HOOK_BLOCK_KEYWORDS)) {
          return null;
        }
        const burst = scoreBurstSegment(seg, burstOpts);
        const nearEnd = (seg.startMs - epStart) / span >= 0.72;
        let score = burst.score;
        if (nearEnd && (CLIFF_HINT.test(text) || burst.score >= 2)) score += 1;
        if (TWIST_HINT.test(text) && burst.score >= 2) score += 1;
        // 命中剧情类型优先标签则加分，让经典必选剧情更容易被选中
        if (preferredTags.size && burst.tags.some((t) => preferredTags.has(t))) {
          score += preferredBonus;
        }
        if (score < minScore) return null;
        const type = classifyType(text, burst.tags, nearEnd);
        const usableAsHook = score >= 3 && type !== "cliff" && !nearEnd;
        return {
          segmentId: seg.segmentId,
          episodeId: epId,
          episodeNo: episodeNoOf(seg, epId),
          startMs: seg.startMs,
          speechStartMs: seg.speechStartMs ?? seg.startMs,
          score,
          type,
          tags: burst.tags.length ? burst.tags : [type === "cliff" ? "悬念" : "高能"],
          usableAsHook,
          preview: previewOf(text),
        } satisfies HighlightCandidate;
      })
      .filter((x): x is HighlightCandidate => x != null)
      .sort((a, b) => b.score - a.score || a.startMs - b.startMs);

    const picked: HighlightCandidate[] = [];
    const takeOne = (pred: (c: HighlightCandidate) => boolean) => {
      const hit = scored.find((c) => pred(c) && !picked.some((p) => p.segmentId === c.segmentId));
      if (hit) picked.push(hit);
    };
    takeOne((c) => c.usableAsHook);
    takeOne((c) => preferredTags.size > 0 && c.tags.some((t) => preferredTags.has(t)) && c.type !== "cliff");
    takeOne((c) => c.type === "twist" || c.type === "conflict");
    takeOne((c) => c.type === "cliff" || c.startMs >= epStart + span * 0.65);
    for (const c of scored) {
      if (picked.length >= perEpisodeLimit) break;
      if (!picked.some((p) => p.segmentId === c.segmentId)) picked.push(c);
    }
    out.push(...picked);
  }

  return out;
}

/** 注入 LLM：ASR 高光预标（替代纯关键词爆点列表的主展示） */
export function formatHighlightPrelabelForPrompt(
  segments: AsrSegment[],
  limit = 24,
  options: HighlightPrelabelOptions = {},
): string {
  const humanFirst = humanHighlightCandidatesFromSegments(segments);
  const humanOpening = humanFirst.filter((c) => c.type === "hook");
  const humanClosing = humanFirst.filter((c) => c.type === "cliff");
  const humanOther = humanFirst.filter((c) => c.type !== "hook" && c.type !== "cliff");
  const humanIds = new Set(humanFirst.map((c) => c.segmentId));
  const all = buildHighlightPrelabel(segments, options).filter((c) => !humanIds.has(c.segmentId));
  const genreHint = options.genreProfile
    ? ` · 题材词表 ${options.genreProfile}`
    : " · 仅通用底表";
  if (!all.length && !humanFirst.length) {
    return [
      `## ASR 高光预标（全自动 · 台词/叙事${genreHint}）`,
      "- 未扫到明显冲突/反转/悬念词：请从 ASR 找情绪最尖的连续场作 **hook**，中段仍须邻集推进。",
      "- escalate **禁止**只按高光分跳集。",
    ].join("\n");
  }

  const alpha = options.useCountPenaltyAlpha ?? 1.2;
  const round = Math.max(1, options.round ?? 1);
  const totalRounds = Math.max(1, options.totalRounds ?? 1);
  const byEffective = (a: HighlightCandidate, b: HighlightCandidate) => {
    const ea = effectiveHighlightScore(a.score, useCountOf(a.segmentId, options.segmentUseCounts), alpha);
    const eb = effectiveHighlightScore(b.score, useCountOf(b.segmentId, options.segmentUseCounts), alpha);
    return eb - ea || b.score - a.score || a.startMs - b.startMs;
  };

  const allHooks = all.filter((c) => c.usableAsHook).sort(byEffective);
  const hookTake = Math.min(10, limit);
  // 按轮滑动：优先少占用尖点；同时从次优池切 4~6 条本轮优先尝试
  const rotateStart =
    allHooks.length > hookTake
      ? Math.floor(((round - 1) * Math.max(0, allHooks.length - hookTake)) / totalRounds) %
        Math.max(1, allHooks.length - hookTake + 1)
      : 0;
  const rotatedHooks =
    allHooks.length > hookTake
      ? [
          ...allHooks.slice(rotateStart, rotateStart + hookTake),
          ...allHooks.slice(0, Math.max(0, hookTake - (allHooks.length - rotateStart))),
        ].slice(0, hookTake)
      : allHooks.slice(0, hookTake);

  const rotatedIds = new Set(rotatedHooks.map((h) => h.segmentId));
  const secondaryStart = Math.min(allHooks.length, rotateStart + hookTake);
  let secondaryHooks = allHooks
    .slice(secondaryStart, secondaryStart + 6)
    .filter((c) => !rotatedIds.has(c.segmentId));
  // 若切片为空，从剩余候选补 4~6 条次优
  if (!secondaryHooks.length && allHooks.length > rotatedHooks.length) {
    secondaryHooks = allHooks.filter((c) => !rotatedIds.has(c.segmentId)).slice(0, 6);
  }

  const mid = all
    .filter((c) => c.type === "conflict" || c.type === "twist")
    .sort(byEffective)
    .slice(0, 10);
  const cliffs = all
    .filter((c) => c.type === "cliff")
    .sort(byEffective)
    .slice(0, 8);

  const lineOf = (c: HighlightCandidate, i: number) => {
    const used = useCountOf(c.segmentId, options.segmentUseCounts);
    const isHuman = humanIds.has(c.segmentId);
    const isHumanClosing = humanClosing.some((h) => h.segmentId === c.segmentId);
    const renderHint = isHumanClosing
      ? `，**人工片尾严格终点=${Math.round((segments.find((s) => s.segmentId === c.segmentId)?.humanMarkerEndMs ?? c.speechStartMs) / 100) / 10}s**`
      : isHuman
        ? `，**人工片头严格起点=${Math.round(c.speechStartMs / 100) / 10}s**`
        : c.speechStartMs > c.startMs + 400
          ? `，建议口≈${Math.round(c.speechStartMs / 100) / 10}s起`
          : "";
    const usedHint =
      used > 0 ? `，已占用${used}次·优先换同主题其他尖点` : "";
    return `${i + 1}. \`${c.segmentId}\`（${c.type}/${c.tags.slice(0, 2).join("+")}，分 ${c.score}${usedHint}${renderHint}）「${c.preview}」`;
  };

  const byEp = new Map<string, HighlightCandidate[]>();
  for (const c of all) {
    const list = byEp.get(c.episodeId) ?? [];
    list.push(c);
    byEp.set(c.episodeId, list);
  }
  const epLines = [...byEp.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([ep, list]) => {
      const sorted = [...list].sort(byEffective);
      const parts = sorted.slice(0, 3).map((c) => {
        const used = useCountOf(c.segmentId, options.segmentUseCounts);
        return used > 0
          ? `${c.type}=\`${c.segmentId}\`(×${used})`
          : `${c.type}=\`${c.segmentId}\``;
      });
      return `- ${ep}: ${parts.join(" · ")}`;
    });

  const heavyUsed = all
    .map((c) => ({ c, n: useCountOf(c.segmentId, options.segmentUseCounts) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.c.score - a.c.score)
    .slice(0, 8);

  return [
    `## ASR 高光预标（全自动 · 台词/叙事高光 · **仅候选**${genreHint} · 第${round}/${totalRounds}批已按占用软轮换）`,
    "用法（须遵守）：",
    "0. **人工标记最高优先（软约束）**：工位 **高光=片头**、**钩子=片尾**；片头严格起点、片尾严格终点；叙事不合格可换备选，勿硬套。",
    "1. 下方 ASR 候选是**入口提示**，不是必须照抄；**禁止「最高分=clips[0]」**，须服从可懂建置与邻集小弧。",
    "2. **hook 可优先参考**「可作片头」与「本轮优先尝试」；已占用多次的勿再当主钩，可换同主题其他尖点。",
    "3. hook 段选对即可：成片起点由系统按「真实开口−短前垫」校正，**勿假设从文件 0 起播**。",
    "4. **10min 中段**至少覆盖一处「冲突/反转」高光说到收束。",
    "5. **cliff 可优先参考**「悬念」候选或近集尾强悬念段（禁止揭底完整句）。",
    "6. 换集仍只能 `eN→eN+1`；禁止按高光分隔空跳集。",
    "7. **跨成片软避让**：少用已占用尖点作 hook/收束；叙事合格优先于完全避开。",
    "",
    "### 人工片头（高光 · 尽量作 hook）",
    ...(humanOpening.length
      ? humanOpening.map(lineOf)
      : ["- （无人工片头；参考下方 ASR 片头候选）"]),
    "",
    "### 人工片尾（钩子 · 尽量作 cliff 收束）",
    ...(humanClosing.length
      ? humanClosing.map(lineOf)
      : ["- （无人工片尾；参考下方悬念候选）"]),
    ...(humanOther.length
      ? [
          "",
          "### 其他人工标记",
          ...humanOther.map(lineOf),
        ]
      : []),
    "",
    "### 可作片头（hook 候选 · 少占用优先）",
    ...(rotatedHooks.length ? rotatedHooks.map(lineOf) : ["- （无强片头候选，请从 ASR 自选冲突建置场）"]),
    "",
    "### 本轮优先尝试（次优 hook · 轮换切片）",
    ...(secondaryHooks.length
      ? secondaryHooks.map(lineOf)
      : ["- （本轮无额外次优；从上表或 ASR 自选）"]),
    "",
    "### 冲突 / 反转（中段兑现候选）",
    ...(mid.length ? mid.map(lineOf) : ["- （弱）请从邻集冲突区自选"]),
    "",
    "### 悬念（cliff 候选）",
    ...(cliffs.length ? cliffs.map(lineOf) : ["- （弱）请贴末集近集尾悬念"]),
    "",
    ...(heavyUsed.length
      ? [
          "### 已多用尖点（勿再作主 hook/主 cliff）",
          ...heavyUsed.map(
            ({ c, n }, i) =>
              `${i + 1}. \`${c.segmentId}\` ×${n}（${c.type}，分 ${c.score}）「${c.preview}」`,
          ),
          "",
        ]
      : []),
    "### 分集高光摘要",
    ...epLines,
  ].join("\n");
}
