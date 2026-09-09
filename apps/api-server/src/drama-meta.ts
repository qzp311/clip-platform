import type { DramaInfo, DramaMeta } from "@clip/sdk";
import { dramaInfoToTaskMeta, normalizeDramaMeta } from "@clip/sdk";

export function buildDramaSynopsisSection(dramaMeta: Record<string, unknown> | undefined): {
  section: string;
  hasSynopsis: boolean;
} {
  const meta = normalizeDramaMeta(dramaMeta);
  const lines: string[] = ["## 作品信息"];

  const title = meta.title ?? meta.dramaTitle;
  if (title) lines.push(`- 剧名：${title}`);

  if (meta.synopsis?.trim()) {
    lines.push(`- 作品简介：${meta.synopsis.trim()}`);
  } else {
    lines.push(
      "- 作品简介：（未提供）仅依据 ASR 台词选段；narrativeLine 须自洽，plotThread 从台词推断",
    );
  }

  if (meta.genreProfile) lines.push(`- 叙事画像：${meta.genreProfile}`);
  if (meta.genreTags?.length) lines.push(`- 题材标签：${meta.genreTags.join("、")}`);
  if (meta.plotThreads?.length) lines.push(`- 剧情线：${meta.plotThreads.join("、")}`);
  if (meta.mainCharacters?.length) {
    lines.push(
      `- 主要人物：${meta.mainCharacters.map((c) => (c.role ? `${c.name}（${c.role}）` : c.name)).join("、")}`,
    );
  }
  if (meta.hookSellingPoints?.length) lines.push(`- 投放卖点：${meta.hookSellingPoints.join("、")}`);
  if (meta.cliffTaboos?.length) lines.push(`- 剪辑禁忌：${meta.cliffTaboos.join("；")}`);

  lines.push("");
  lines.push("## 选段须结合简介");
  lines.push("- narrativeLine / plotThread 须与简介主线或卖点一致，勿选无关孤立高光");
  if (meta.plotThreads?.length) {
    lines.push(`- skip_episode 时 plotThread 优先从简介剧情线选择：${meta.plotThreads.join("、")}`);
  }

  return {
    section: lines.join("\n"),
    hasSynopsis: Boolean(meta.synopsis?.trim()),
  };
}

export function warnIfMissingSynopsis(
  context: string,
  dramaMeta: Record<string, unknown> | undefined,
  dramaId?: string,
): boolean {
  const { hasSynopsis } = buildDramaSynopsisSection(dramaMeta);
  if (!hasSynopsis) {
    console.warn(
      `[clip-api] ${context}: 剧目 ${dramaId ?? "?"} 缺少作品简介，将仅依赖 ASR 选段（警告并继续）`,
    );
  }
  return hasSynopsis;
}

export function snapshotDramaMetaForTask(
  drama: DramaInfo | undefined,
  extra: DramaMeta = {},
): DramaMeta {
  if (!drama) return normalizeDramaMeta(extra);
  return dramaInfoToTaskMeta(drama, extra);
}
