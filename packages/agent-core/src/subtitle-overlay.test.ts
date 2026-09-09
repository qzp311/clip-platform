import { describe, it, expect } from "vitest";
import { remapClipsToTimeline, buildAssSubtitle } from "./subtitle-overlay.js";

describe("subtitle-overlay", () => {
  it("remaps source timestamps to continuous timeline from 0", () => {
    const clips = [
      { startMs: 5000, endMs: 8000, text: "你好" },
      { startMs: 10000, endMs: 14000, text: "世界" },
    ];
    const entries = remapClipsToTimeline(clips);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ startSec: 0, endSec: 3, text: "你好" });
    expect(entries[1]).toEqual({ startSec: 3, endSec: 7, text: "世界" });
  });

  it("skips clips with empty text but advances cursor", () => {
    const clips = [
      { startMs: 0, endMs: 2000, text: "" },
      { startMs: 2000, endMs: 5000, text: "有台词" },
    ];
    const entries = remapClipsToTimeline(clips);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ startSec: 2, endSec: 5, text: "有台词" });
  });

  it("builds ASS subtitle with header and dialogue events", () => {
    const entries = [
      { startSec: 0, endSec: 3, text: "你好" },
      { startSec: 3, endSec: 7, text: "世界" },
    ];
    const ass = buildAssSubtitle(entries, {
      style: { fontSize: 48, marginV: 80 },
      outputHeight: 1080,
    });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Style: Default,DouyinSansBold,48");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,你好");
    expect(ass).toContain("Dialogue: 0,0:00:03.00,0:00:07.00,Default,,0,0,0,,世界");
  });

  it("scales font size and margin by output height ratio", () => {
    const ass = buildAssSubtitle(
      [{ startSec: 0, endSec: 1, text: "x" }],
      { style: { fontSize: 48, marginV: 80 }, outputHeight: 720 },
    );
    // 720/1080 = 0.667 -> 48*0.667 ≈ 32
    expect(ass).toContain(",32,");
    expect(ass).toContain(",53,"); // 80*0.667 ≈ 53
  });

  it("escapes braces and converts newlines to \\N", () => {
    const ass = buildAssSubtitle(
      [{ startSec: 0, endSec: 1, text: "{test}\nsecond" }],
      { style: {}, outputHeight: 1080 },
    );
    // { and } escaped to \{ and \}, newline -> \N
    expect(ass).toContain("\\{test\\}\\Nsecond");
  });
});
