import type { AsrSegment, GenreProfile } from "@clip/sdk";
import { isGenreProfile } from "@clip/sdk";

export interface GenreInferInput {
  /** 已手填/上游指定则优先 */
  genreProfile?: GenreProfile | string | null;
  title?: string | null;
  synopsis?: string | null;
  genreTags?: string[] | null;
  /** 开场 ASR 抽样（前几集台词），补简介漏标 */
  asrSampleTexts?: string[] | null;
}

/** 简介/标题/开场 ASR 信号 → 叙事画像（越具体越靠前） */
const INFER_RULES: Array<{ profile: GenreProfile; re: RegExp }> = [
  {
    profile: "system_transmigration",
    re: /系统|绑定|任务|积分|金手指|外挂|回现代|穿越福利|宿主|待满|攻略度|好感度/,
  },
  {
    profile: "era_male",
    re: /重生|前世|这一世|九十年代|八零|七零|年代|知青|粮票|户口|彩礼|偏心|孝女|万元户/,
  },
  {
    profile: "sweet_romance",
    re: /闪婚|甜宠|契约婚姻|假戏真做|护短|先婚后爱|军婚|指挥官|退役|双向奔赴|宠妻/,
  },
  {
    profile: "revenge_female",
    re: /复仇|虐渣|小三|白月光|地牢|净身|携子|回归|DNA|手撕|弃妇|打脸虐/,
  },
  {
    profile: "palace_intrigue",
    re: /宫斗|冷宫|太后|皇后|皇帝|嫔妃|位分|争宠|朝堂|夺嫡|赐死|穿越.*宫|入宫/,
  },
  {
    profile: "urban_male",
    re: /战神|神医|双身份|身份|总裁|少爷|继承人|退婚|打脸|特种兵|龙王|豪门/,
  },
];

/** 从跨集 ASR 抽前几集台词样本，供题材推断 */
export function sampleAsrTextsForGenreInfer(
  segments: AsrSegment[],
  options: { maxEpisodes?: number; maxSegmentsPerEpisode?: number; maxChars?: number } = {},
): string[] {
  const maxEpisodes = options.maxEpisodes ?? 2;
  const maxSegs = options.maxSegmentsPerEpisode ?? 12;
  const maxChars = options.maxChars ?? 800;
  if (!segments.length) return [];

  const byEp = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const ep = seg.episodeId ?? "default";
    const list = byEp.get(ep) ?? [];
    list.push(seg);
    byEp.set(ep, list);
  }
  const epKeys = [...byEp.keys()].sort((a, b) => a.localeCompare(b)).slice(0, maxEpisodes);
  const out: string[] = [];
  let chars = 0;
  for (const ep of epKeys) {
    const list = [...(byEp.get(ep) ?? [])].sort((a, b) => a.startMs - b.startMs).slice(0, maxSegs);
    for (const seg of list) {
      const t = seg.text.trim();
      if (!t) continue;
      if (chars + t.length > maxChars) return out;
      out.push(t);
      chars += t.length;
    }
  }
  return out;
}

/** 可朗读的时代/题材标签（古装、现代、民国、年代、玄幻、漫剧等） */
export function resolveEraStyle(input: GenreInferInput & { dramaType?: string | null }): string {
  const blob = [
    input.title?.trim() ?? "",
    input.synopsis?.trim() ?? "",
    input.dramaType?.trim() ?? "",
    ...(input.genreTags ?? []).map((t) => t.trim()),
    ...(input.asrSampleTexts ?? []).map((t) => t.trim()),
  ]
    .filter(Boolean)
    .join("\n");

  if (!blob) return "";
  // 越具体的越靠前匹配
  if (/穿越.*古代|宫斗|宫廷|后宫|冷宫|太后|皇上|皇帝|皇后|嫔妃|宫女|太监|王爷|王妃|嫡女|庶女|侯府|将军府|皇/.test(blob)) return "古装";
  if (/民国|少帅|军阀|姨太太|租界|特务|帮派|码头|舞厅|电报|黄埔|北伐|抗日|抗战/.test(blob)) return "民国";
  if (/九零|八零|七零|六零|年代|知青|粮票|户口|公社|生产队|万元户|改革开放/.test(blob)) return "年代";
  if (/玄幻|修仙|宗门|灵根|渡劫|仙尊|魔尊|妖兽|法术|飞升|秘境|天界/.test(blob)) return "玄幻";
  if (/系统|绑定|任务|积分|金手指|外挂|宿主|攻略度|好感度|回现代/.test(blob)) return "现代穿越/系统";
  if (/总裁|豪门|都市|战神|神医|龙王|特种兵|闪婚|甜宠|契约婚姻|先婚后爱|离婚|出轨|小三/.test(blob)) return "现代都市";
  if (/漫剧|动漫|二次元|Q版/.test(blob) || input.dramaType?.includes("comic")) return "漫剧";
  return "";
}

/**
 * 解析叙事画像：手填优先，否则标题+简介+标签+开场 ASR 粗分。
 * 无法判断时返回 undefined（打分仅用通用底表）。
 */
export function resolveGenreProfile(input: GenreInferInput): GenreProfile | undefined {
  if (isGenreProfile(input.genreProfile)) return input.genreProfile;

  const blob = [
    input.title?.trim() ?? "",
    input.synopsis?.trim() ?? "",
    ...(input.genreTags ?? []).map((t) => t.trim()),
    ...(input.asrSampleTexts ?? []).map((t) => t.trim()),
  ]
    .filter(Boolean)
    .join("\n");

  if (!blob) return undefined;

  for (const rule of INFER_RULES) {
    if (rule.re.test(blob)) return rule.profile;
  }
  return undefined;
}

/** @deprecated 兼容旧名，等同 resolveGenreProfile */
export function inferGenreProfile(input: GenreInferInput): GenreProfile | undefined {
  return resolveGenreProfile(input);
}
