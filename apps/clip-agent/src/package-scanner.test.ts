import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEpisodeSortKey, scanEpisodeVideos } from "./package-scanner.js";

describe("parseEpisodeSortKey", () => {
  it("parses bare numeric filenames in numeric order (not lexicographic)", () => {
    const names = ["1.mp4", "10.mp4", "2.mp4", "11.mp4", "9.mp4"];
    const keys = names.map((n, i) => ({ n, k: parseEpisodeSortKey(n, i) }));
    keys.sort((a, b) => a.k - b.k);
    expect(keys.map((x) => x.n)).toEqual(["1.mp4", "2.mp4", "9.mp4", "10.mp4", "11.mp4"]);
  });

  it("parses 第N集 / epN / drama hyphen patterns", () => {
    expect(parseEpisodeSortKey("第3集.mp4", 0)).toBe(3);
    expect(parseEpisodeSortKey("ep12.mp4", 0)).toBe(12);
    expect(parseEpisodeSortKey("drama_08.mp4", 0)).toBe(8);
    expect(parseEpisodeSortKey("裴先生的小晴天01.mp4", 0)).toBe(1);
    expect(parseEpisodeSortKey("裴先生的小晴天-02-1080P.mp4", 0)).toBe(2);
  });
});

describe("scanEpisodeVideos", () => {
  it("assigns episodeNo by numeric filename order for 1/10/2.mp4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clip-scan-"));
    for (const name of ["10.mp4", "1.mp4", "2.mp4"]) {
      await writeFile(join(dir, name), Buffer.alloc(0));
    }
    const videos = await scanEpisodeVideos(dir);
    expect(videos.map((v) => v.filename)).toEqual(["1.mp4", "2.mp4", "10.mp4"]);
    expect(videos.map((v) => v.episodeNo)).toEqual([1, 2, 10]);
    expect(videos.map((v) => v.sortKey)).toEqual([1, 2, 10]);
  });

  it("uses folder number when basename has no episode digit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clip-scan-"));
    await mkdir(join(dir, "03"));
    await mkdir(join(dir, "01"));
    await writeFile(join(dir, "03", "正片.mp4"), Buffer.alloc(0));
    await writeFile(join(dir, "01", "正片.mp4"), Buffer.alloc(0));
    const videos = await scanEpisodeVideos(dir);
    expect(videos.map((v) => v.episodeNo)).toEqual([1, 3]);
  });

  it("does not depend on readdir order for unparsed names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clip-scan-"));
    for (const name of ["c.mp4", "a.mp4", "b.mp4"]) {
      await writeFile(join(dir, name), Buffer.alloc(0));
    }
    const videos = await scanEpisodeVideos(dir);
    expect(videos.map((v) => v.filename)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(videos.map((v) => v.episodeNo)).toEqual([1, 2, 3]);
  });
});
