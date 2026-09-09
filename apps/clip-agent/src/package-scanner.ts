import { readdir } from "node:fs/promises";
import { join, extname, relative, basename } from "node:path";
import {
  compareEpisodeMediaPath,
  parseEpisodeNoFromMediaPath,
} from "@clip/sdk";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm"]);

export interface ScannedEpisodeVideo {
  path: string;
  filename: string;
  sortKey: number;
  episodeNo: number;
}

/**
 * 扫描压缩包内视频：集序严格按文件名/路径解析，不用 readdir 顺序。
 * 全部能解析且互不重复 → episodeNo = 文件名集号；否则按文件名自然序 1..N。
 */
export async function scanEpisodeVideos(rootDir: string): Promise<ScannedEpisodeVideo[]> {
  const files = await collectVideoFiles(rootDir);
  const items = files.map((path) => {
    const rel = relative(rootDir, path).replace(/\\/g, "/");
    const filename = basename(path);
    const parsedNo = parseEpisodeNoFromMediaPath(rel);
    return { path, filename, rel, parsedNo };
  });

  items.sort((a, b) => {
    if (a.parsedNo != null && b.parsedNo != null) {
      const diff = a.parsedNo - b.parsedNo;
      if (diff !== 0) return diff;
    } else if (a.parsedNo != null) {
      return -1;
    } else if (b.parsedNo != null) {
      return 1;
    }
    return compareEpisodeMediaPath(a.rel, b.rel);
  });

  const parsedNos = items.map((x) => x.parsedNo).filter((n): n is number => n != null);
  const allParsed = parsedNos.length === items.length;
  const uniqueParsed = new Set(parsedNos).size === parsedNos.length;

  return items.map((item, index) => {
    const episodeNo =
      allParsed && uniqueParsed && item.parsedNo != null ? item.parsedNo : index + 1;
    return {
      path: item.path,
      filename: item.filename,
      sortKey: item.parsedNo ?? 10_000 + index + 1,
      episodeNo,
    };
  });
}

/** @deprecated 使用 @clip/sdk parseEpisodeNoFromMediaPath */
export { parseEpisodeSortKey } from "@clip/sdk";

async function collectVideoFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  // 目录项按文件名排序，保证递归收集顺序稳定
  entries.sort((a, b) => compareEpisodeMediaPath(a.name, b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectVideoFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (VIDEO_EXT.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

export async function assertScanMatchesExpected(
  videos: ScannedEpisodeVideo[],
  expected?: number,
): Promise<void> {
  if (!videos.length) {
    throw new Error("压缩包内未找到可处理的视频文件（支持 mp4/mov/mkv 等）");
  }
  if (expected != null && expected > 0 && videos.length !== expected) {
    throw new Error(`压缩包内视频数量 ${videos.length} 与预期 ${expected} 不一致`);
  }
}
