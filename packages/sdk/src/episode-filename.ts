import { basename } from "node:path";

/** 文件名/路径自然排序（1 < 2 < 10） */
export function compareEpisodeMediaPath(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}

/**
 * 从视频文件名或相对路径解析集序号。
 * 优先显式「第N集/epN」，再取路径各段与 basename 中的 1~999 候选，避开长 timestamp。
 */
export function parseEpisodeNoFromMediaPath(pathOrName: string): number | null {
  const normalized = pathOrName.replace(/\\/g, "/").trim();
  if (!normalized) return null;

  const segments = normalized.split("/").filter(Boolean);
  // 自底向上：先 basename，再父目录（如 01/正片.mp4）
  for (let i = segments.length - 1; i >= 0; i--) {
    const no = parseEpisodeNoFromBasename(segments[i]!);
    if (no != null) return no;
  }
  return null;
}

function parseEpisodeNoFromBasename(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, "").trim();
  if (!base) return null;

  const explicitPatterns = [
    /(?:第)?(\d{1,3})\s*集/i,
    /(?:^|[_\-\s])ep(?:isode)?[_\-\s]?(\d{1,3})(?:[_\-\s\.]|$)/i,
    /^(\d{1,3})$/,
    /^(\d{1,3})[_\-\s]/,
    /[_\-\s](\d{1,3})$/,
  ];
  for (const pattern of explicitPatterns) {
    const match = base.match(pattern);
    if (match?.[1]) {
      const n = Number(match[1]);
      if (isEpisodeLike(n)) return n;
    }
  }

  // 剧名-01-后缀 / 剧名01
  const hyphenSeg = base.match(/(?:^|[_\-\s])(\d{1,3})(?=[_\-\s]|$)/);
  if (hyphenSeg?.[1]) {
    const n = Number(hyphenSeg[1]);
    if (isEpisodeLike(n)) return n;
  }
  const gluedTail = base.match(/(\d{1,3})$/);
  if (gluedTail?.[1]) {
    const n = Number(gluedTail[1]);
    if (isEpisodeLike(n)) return n;
  }

  // 多数字时取「像集数」的最后一个（避免 timestamp 误当集号）
  const candidates = [...base.matchAll(/(?:^|[^\d])(\d{1,3})(?=[^\d]|$)/g)]
    .map((m) => Number(m[1]))
    .filter(isEpisodeLike);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return candidates[candidates.length - 1]!;

  return null;
}

function isEpisodeLike(n: number): boolean {
  return Number.isFinite(n) && n >= 1 && n <= 999;
}

/** @deprecated 使用 parseEpisodeNoFromMediaPath；保留兼容旧 scanner 测试 */
export function parseEpisodeSortKey(filename: string, fallbackIndex: number): number {
  return parseEpisodeNoFromMediaPath(filename) ?? 10_000 + fallbackIndex + 1;
}
