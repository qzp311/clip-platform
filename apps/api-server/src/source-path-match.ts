import { CLIP_LOCAL_SOURCE_PREFIX, parseClipLocalSourceUrl } from "@clip/sdk";

/** 比对用：解码 clip-local、统一斜杠、小写 */
export function normalizeSourcePathForMatch(p: string): string {
  let s = String(p || "").trim();
  if (!s) return "";
  const local = parseClipLocalSourceUrl(s);
  if (local) s = local;
  else if (s.toLowerCase().startsWith(CLIP_LOCAL_SOURCE_PREFIX)) {
    try {
      s = decodeURIComponent(s.slice(CLIP_LOCAL_SOURCE_PREFIX.length));
    } catch {
      s = s.slice(CLIP_LOCAL_SOURCE_PREFIX.length);
    }
  }
  return s.replace(/\\/g, "/").toLowerCase();
}

/** 剧包缓存内相对路径，如 /extracted/1.mp4 */
export function extractedRelativeKey(p: string): string | null {
  const n = normalizeSourcePathForMatch(p);
  const idx = n.indexOf("/extracted/");
  if (idx >= 0) return n.slice(idx);
  const idx2 = n.indexOf("extracted/");
  if (idx2 >= 0) return `/${n.slice(idx2)}`;
  return null;
}

/** 剧包 cache 目录 hash（32 位） */
export function packageCacheKeyFromSourcePath(p: string): string | null {
  const n = normalizeSourcePathForMatch(p);
  const m = n.match(/packages[/]cache[/]([a-f0-9]+)/) ?? n.match(/cache[/]([a-f0-9]{16,32})/);
  return m?.[1] ?? null;
}

/** 人工标记本地路径 vs 分集 clip-local source_url */
export function sourcePathsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizeSourcePathForMatch(a);
  const nb = normalizeSourcePathForMatch(b);
  if (na === nb) return true;
  const ra = extractedRelativeKey(a);
  const rb = extractedRelativeKey(b);
  if (ra && rb && ra === rb) {
    const cacheA = packageCacheKeyFromSourcePath(a);
    const cacheB = packageCacheKeyFromSourcePath(b);
    if (cacheA && cacheB) return cacheA === cacheB;
    return false;
  }
  const ba = na.split("/").pop();
  const bb = nb.split("/").pop();
  if (ba && bb && ba === bb) {
    const cacheA = packageCacheKeyFromSourcePath(a);
    const cacheB = packageCacheKeyFromSourcePath(b);
    if (cacheA && cacheB && cacheA === cacheB) return true;
  }
  return false;
}
