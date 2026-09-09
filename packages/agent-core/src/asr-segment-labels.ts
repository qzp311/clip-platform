import type {
  AsrEmotionLabel,
  AsrHighlightType,
  AsrSceneType,
  AsrSegment,
  GenreProfile,
  RawAsrSegment,
} from "@clip/sdk";
import { scoreBurstSegment } from "./burst-heuristic.js";
import { acousticScoreFromRms, classifySegmentSilenceAndFiller } from "./segment-loudness.js";
import { HOOK_BLOCK_KEYWORDS } from "./genre-burst-lexicon.js";
import { resolveGenreProfile, type GenreInferInput } from "./infer-genre-profile.js";

const TWIST_HINT =
  /居然|竟然|原来|真相|秘密|没想到|怎么会|其实|假|冒充|不是你的|验DNA|怀孕|继承人|系统|绑定|任务失败|歪打正着/i;
const CLIFF_HINT =
  /等等|先别|还没|未完|下集|明天|走着瞧|你给我等着|到底|究竟|真的假的|别说话|闭嘴|听我说完|倒计时|超时|警告/i;

const EMOTION_RULES: Array<{ re: RegExp; emotion: AsrEmotionLabel }> = [
  { re: /滚|打|扇|杀|废物|垃圾|该死|闭嘴|凭什么|给你脸|滚出去/i, emotion: "anger" },
  { re: /哭|泪|对不起|分手|离开我|不要走|心痛|难过/i, emotion: "sad" },
  { re: /怕|救命|危险|威胁|报警|绑架|出事/i, emotion: "fear" },
  { re: /喜欢|爱你|开心|幸福|太好了|谢谢/i, emotion: "joy" },
  { re: /抱抱|心疼|没事|我在|保护你/i, emotion: "tender" },
  { re: /等等|到底|究竟|真的假的|没说完|下集/i, emotion: "suspense" },
];

function textHasAny(text: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    if (kw && text.includes(kw)) return true;
  }
  return false;
}

function classifyHighlight(
  text: string,
  burstTags: string[],
  nearEpisodeEnd: boolean,
  score: number,
): AsrHighlightType | undefined {
  if (score < 2 && !textHasAny(text, HOOK_BLOCK_KEYWORDS)) return undefined;
  if (textHasAny(text, HOOK_BLOCK_KEYWORDS)) return undefined;
  if (CLIFF_HINT.test(text) || (nearEpisodeEnd && burstTags.length > 0)) return "cliff";
  if (
    TWIST_HINT.test(text) ||
    burstTags.some((t) =>
      /反转|身份|关系炸弹|情感背叛|系统|规则|歪打|重生|证据|回归/.test(t),
    )
  ) {
    return "twist";
  }
  if (burstTags.length > 0 || score >= 2) return "conflict";
  return undefined;
}

function classifyEmotion(text: string): AsrEmotionLabel {
  for (const rule of EMOTION_RULES) {
    if (rule.re.test(text)) return rule.emotion;
  }
  return "neutral";
}

function classifySceneType(
  text: string,
  highlightType: AsrHighlightType | undefined,
  emotion: AsrEmotionLabel,
): AsrSceneType {
  if (textHasAny(text, HOOK_BLOCK_KEYWORDS)) return "cta";
  if (highlightType === "twist") return "reveal";
  if (highlightType === "cliff") return "suspense";
  if (highlightType === "conflict" || highlightType === "hook" || emotion === "anger") {
    return "conflict_dialogue";
  }
  if (text.length >= 40 && !/[？?！!]/.test(text)) return "monologue";
  if (emotion === "neutral" && text.length < 24) return "setup";
  return "unknown";
}

function buildSpeakerIndex(rawSegments: RawAsrSegment[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!rawSegments?.length) return map;
  for (const raw of rawSegments) {
    const spk = raw.speakerId?.trim();
    if (!spk) continue;
    const key = `${raw.startMs}|${raw.text.trim().slice(0, 12)}`;
    map.set(key, spk);
  }
  return map;
}

function matchSpeaker(
  seg: AsrSegment,
  speakerByRaw: Map<string, string>,
  rawSegments: RawAsrSegment[] | undefined,
): string | undefined {
  if (seg.speakerId?.trim()) return seg.speakerId.trim();
  if (!rawSegments?.length) return undefined;
  const onset = seg.speechStartMs ?? seg.startMs;
  const text = seg.text.trim();
  let best: { spk: string; dist: number } | null = null;
  for (const raw of rawSegments) {
    const spk = raw.speakerId?.trim();
    if (!spk) continue;
    const dist = Math.abs(raw.startMs - onset);
    if (dist > 2500) continue;
    if (
      text &&
      raw.text.trim() &&
      !text.includes(raw.text.trim().slice(0, 6)) &&
      !raw.text.includes(text.slice(0, 6))
    ) {
      continue;
    }
    if (!best || dist < best.dist) best = { spk, dist };
  }
  if (best) return best.spk;
  const key = `${onset}|${text.slice(0, 12)}`;
  return speakerByRaw.get(key);
}

export interface AnnotateAsrLabelsOptions extends GenreInferInput {
  rawSegments?: RawAsrSegment[];
  /** 已解析好的画像，优先于推断字段 */
  genreProfile?: GenreProfile;
}

/**
 * 为全部 ASR 段写入可持久化标签：
 * - highlight*：台词冲突/反转/悬念启发式（按题材词表）
 * - emotion：文本情绪启发式（非音频情感模型）
 * - sceneType：场面倾向（文本推断，**非真实画面理解**）
 * - speakerId：仅当 raw/段上已有声纹结果时透传；当前 FunASR 默认无
 */
export function annotateAsrSegmentsWithLabels(
  segments: AsrSegment[],
  options: AnnotateAsrLabelsOptions = {},
): AsrSegment[] {
  if (!segments.length) return segments;

  const genreProfile = resolveGenreProfile(options);
  const burstOpts = { genreProfile };

  const byEp = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const ep = seg.episodeId ?? seg.segmentId.match(/^(e\d+)/i)?.[1]?.toLowerCase() ?? "default";
    const list = byEp.get(ep) ?? [];
    list.push(seg);
    byEp.set(ep, list);
  }

  const epMeta = new Map<string, { start: number; span: number }>();
  for (const [ep, list] of byEp) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    const start = sorted[0]!.startMs;
    const end = sorted.at(-1)!.endMs;
    epMeta.set(ep, { start, span: Math.max(1, end - start) });
  }

  const speakerByRaw = buildSpeakerIndex(options.rawSegments);

  return segments.map((seg) => {
    const ep = seg.episodeId ?? seg.segmentId.match(/^(e\d+)/i)?.[1]?.toLowerCase() ?? "default";
    const meta = epMeta.get(ep) ?? { start: seg.startMs, span: 1 };
    const nearEnd = (seg.startMs - meta.start) / meta.span >= 0.72;
    const text = seg.text.trim();
    const burst = scoreBurstSegment(seg, burstOpts);
    let score = burst.score;
    if (nearEnd && (CLIFF_HINT.test(text) || burst.score >= 2)) score += 1;
    if (TWIST_HINT.test(text) && burst.score >= 2) score += 1;
    // 声学响度加分：让"吼出来的冲突"即使台词无关键词也能上分
    const acoustic = acousticScoreFromRms(seg.rmsDb);
    if (acoustic > 0) score += acoustic;

    const highlightType = classifyHighlight(text, burst.tags, nearEnd, score);
    const highlightTags =
      burst.tags.length > 0
        ? burst.tags
        : highlightType
          ? [highlightType === "cliff" ? "悬念" : "高能"]
          : undefined;
    const usableAsHook = Boolean(
      highlightType &&
        score >= 3 &&
        highlightType !== "cliff" &&
        !nearEnd &&
        !textHasAny(text, HOOK_BLOCK_KEYWORDS),
    );
    let emotion = classifyEmotion(text);
    // 高响度但文本无情绪词：兜底为 anger（怒吼/对峙）
    if (emotion === "neutral" && seg.rmsDb != null && seg.rmsDb >= -16) {
      emotion = "anger";
    }
    const sceneType = classifySceneType(text, highlightType, emotion);
    const speakerId = matchSpeaker(seg, speakerByRaw, options.rawSegments);
    const silenceAndFiller = classifySegmentSilenceAndFiller(seg);

    // 有效段需携带语义：纯 filler 或孤立回答语气词不能当 hook/独立 clip
    const isFillerOnly = silenceAndFiller.isFillerOnly || silenceAndFiller.isAnswerFiller;
    const usableAsHookEffective =
      usableAsHook && !isFillerOnly && silenceAndFiller.leadingSilenceMs <= 1500;

    const labelSource = [
      "text_heuristic",
      acoustic > 0 ? "acoustic" : null,
      genreProfile ? `genre:${genreProfile}` : "genre:common",
      speakerId ? "speaker_passthrough" : null,
      silenceAndFiller.isAnswerFiller ? "answer_filler" : null,
      silenceAndFiller.isFillerOnly ? "filler_only" : null,
    ]
      .filter(Boolean)
      .join("+");

    return {
      ...seg,
      highlightType,
      highlightScore: highlightType ? score : score > 0 ? score : undefined,
      highlightTags,
      usableAsHook: usableAsHookEffective || undefined,
      emotion,
      sceneType,
      speakerId,
      labelSource,
      ...silenceAndFiller,
    };
  });
}
