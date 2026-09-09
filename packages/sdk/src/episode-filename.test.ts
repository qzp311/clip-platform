import { describe, expect, it } from "vitest";
import {
  compareEpisodeMediaPath,
  parseEpisodeNoFromMediaPath,
  parseEpisodeSortKey,
} from "./episode-filename.js";

describe("parseEpisodeNoFromMediaPath", () => {
  it("parses bare numeric and 第N集 / epN", () => {
    expect(parseEpisodeNoFromMediaPath("1.mp4")).toBe(1);
    expect(parseEpisodeNoFromMediaPath("10.mp4")).toBe(10);
    expect(parseEpisodeNoFromMediaPath("第3集.mp4")).toBe(3);
    expect(parseEpisodeNoFromMediaPath("ep12.mp4")).toBe(12);
    expect(parseEpisodeNoFromMediaPath("drama_08.mp4")).toBe(8);
  });

  it("parses glued and hyphen drama filenames", () => {
    expect(parseEpisodeNoFromMediaPath("裴先生的小晴天01.mp4")).toBe(1);
    expect(parseEpisodeNoFromMediaPath("裴先生的小晴天-02-1080P.mp4")).toBe(2);
    expect(parseEpisodeNoFromMediaPath("裴先生的小晴天-10-花絮.mp4")).toBe(10);
  });

  it("reads episode number from parent folder", () => {
    expect(parseEpisodeNoFromMediaPath("03/正片.mp4")).toBe(3);
    expect(parseEpisodeNoFromMediaPath("裴先生的小晴天/12/episode.mp4")).toBe(12);
  });

  it("sorts numeric filenames in numeric order via compareEpisodeMediaPath", () => {
    const names = ["10.mp4", "1.mp4", "2.mp4", "11.mp4", "9.mp4"];
    names.sort(compareEpisodeMediaPath);
    expect(names).toEqual(["1.mp4", "2.mp4", "9.mp4", "10.mp4", "11.mp4"]);
  });

  it("legacy parseEpisodeSortKey keeps numeric order", () => {
    const names = ["1.mp4", "10.mp4", "2.mp4", "11.mp4", "9.mp4"];
    const keys = names.map((n, i) => ({ n, k: parseEpisodeSortKey(n, i) }));
    keys.sort((a, b) => a.k - b.k);
    expect(keys.map((x) => x.n)).toEqual(["1.mp4", "2.mp4", "9.mp4", "10.mp4", "11.mp4"]);
  });
});
