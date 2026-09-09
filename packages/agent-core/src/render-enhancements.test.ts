import { describe, expect, it } from "vitest";
import {
  listBgmTrackUrls,
  normalizeDrawtextColor,
  pickRandomBgmTrack,
} from "./render-enhancements.js";

describe("pickRandomBgmTrack", () => {
  it("returns undefined when disabled or empty", () => {
    expect(pickRandomBgmTrack({ enabled: false, url: "https://a.mp3" })).toBeUndefined();
    expect(pickRandomBgmTrack({ enabled: true, tracks: [] })).toBeUndefined();
  });

  it("falls back to legacy url", () => {
    const picked = pickRandomBgmTrack({ enabled: true, url: "https://legacy.mp3", volume: 0.3 });
    expect(picked?.url).toBe("https://legacy.mp3");
    expect(picked?.volume).toBe(0.3);
  });

  it("picks from tracks by random", () => {
    const bgm = {
      enabled: true,
      tracks: [
        { name: "a", url: "https://a.mp3" },
        { name: "b", url: "https://b.mp3" },
        { name: "c", url: "https://c.mp3" },
      ],
      volume: 0.2,
    };
    expect(pickRandomBgmTrack(bgm, () => 0)?.url).toBe("https://a.mp3");
    expect(pickRandomBgmTrack(bgm, () => 0.5)?.url).toBe("https://b.mp3");
    expect(pickRandomBgmTrack(bgm, () => 0.99)?.url).toBe("https://c.mp3");
  });

  it("lists tracks preferring tracks over legacy url", () => {
    expect(
      listBgmTrackUrls({
        tracks: [{ url: "https://t.mp3" }],
        url: "https://legacy.mp3",
      }).map((t) => t.url),
    ).toEqual(["https://t.mp3"]);
  });
});

describe("normalizeDrawtextColor", () => {
  it("normalizes # and bare hex", () => {
    expect(normalizeDrawtextColor("#ffd700", "0x000000")).toBe("0xFFD700");
    expect(normalizeDrawtextColor("00E5FF", "0x000000")).toBe("0x00E5FF");
    expect(normalizeDrawtextColor("0x112233", "0x000000")).toBe("0x112233");
  });
});
