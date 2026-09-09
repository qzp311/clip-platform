import { describe, expect, it } from "vitest";
import { toClipLocalSourceUrl } from "@clip/sdk";
import {
  extractedRelativeKey,
  normalizeSourcePathForMatch,
  packageCacheKeyFromSourcePath,
  sourcePathsMatch,
} from "./source-path-match.js";

const CACHE = "5c21533b5f023c247d4c5408";
const LOCAL = `C:\\Users\\qzp_3\\AppData\\Local\\ClipAgent\\workspace\\packages\\cache\\${CACHE}\\extracted\\1.mp4`;
const CLIP_LOCAL = toClipLocalSourceUrl(LOCAL);

describe("sourcePathsMatch", () => {
  it("本地路径与 clip-local URL 等价", () => {
    expect(sourcePathsMatch(LOCAL, CLIP_LOCAL)).toBe(true);
  });

  it("extracted 相对路径一致即匹配", () => {
    expect(extractedRelativeKey(LOCAL)).toBe(`/extracted/1.mp4`);
    expect(sourcePathsMatch(LOCAL, CLIP_LOCAL)).toBe(true);
    expect(
      sourcePathsMatch(
        `D:\\cache\\${CACHE}\\extracted\\2.mp4`,
        `clip-local:${encodeURIComponent(`C:/cache/${CACHE}/extracted/2.mp4`)}`,
      ),
    ).toBe(true);
  });

  it("不同 cache 目录同名文件不匹配", () => {
    expect(
      sourcePathsMatch(
        `C:\\cache\\aaaa\\extracted\\1.mp4`,
        `C:\\cache\\bbbb\\extracted\\1.mp4`,
      ),
    ).toBe(false);
  });

  it("packageCacheKeyFromSourcePath", () => {
    expect(packageCacheKeyFromSourcePath(CLIP_LOCAL)).toBe(CACHE);
    expect(normalizeSourcePathForMatch(CLIP_LOCAL)).toContain(CACHE);
  });
});
