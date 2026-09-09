import { describe, expect, it } from "vitest";
import type { AsrSegment } from "@clip/sdk";
import {
  buildHighlightPrelabel,
  formatHighlightPrelabelForPrompt,
} from "./highlight-prelabel.js";

function seg(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  ep = "e01",
  no = 1,
): AsrSegment {
  return {
    segmentId: id,
    episodeId: ep,
    episodeNo: no,
    startMs,
    endMs,
    text,
    confidence: 0.9,
  };
}

describe("buildHighlightPrelabel", () => {
  it("marks conflict and hook-usable lines from ASR text", () => {
    const segments = [
      seg("e01_s001", "今天天气不错我们出去走走", 0, 3000),
      seg("e01_s002", "你这个穷鬼也配进裴家？给我滚出去", 3000, 8000),
      seg("e01_s003", "原来他才是真正的继承人", 8000, 12000),
      seg("e01_s004", "你给我等着，真相还没说完", 50_000, 55_000),
    ];
    const hits = buildHighlightPrelabel(segments);
    expect(hits.some((h) => h.segmentId === "e01_s002" && h.usableAsHook)).toBe(true);
    expect(hits.some((h) => h.segmentId === "e01_s003" && (h.type === "twist" || h.score >= 3))).toBe(
      true,
    );
    expect(hits.some((h) => h.segmentId === "e01_s004" && h.type === "cliff")).toBe(true);
    expect(hits.every((h) => h.segmentId !== "e01_s001")).toBe(true);
  });

  it("excludes suppressed segments from all candidates", () => {
    const baseline = [
      seg("e01_s002", "你这个穷鬼也配进裴家？给我滚出去", 3000, 8000),
      seg("e01_s003", "原来他才是真正的继承人", 8000, 12_000),
    ];
    const suppressed: AsrSegment = {
      ...seg("e01_s009", "你这个穷鬼也配进裴家？给我滚出去", 20_000, 25_000),
      highlightScore: 0,
      labelSource: "suppressed",
    };
    const input = [...baseline, suppressed];
    const hits = buildHighlightPrelabel(input);
    expect(hits.some((h) => h.segmentId === "e01_s002")).toBe(true);
    expect(hits.every((h) => h.segmentId !== "e01_s009")).toBe(true);

    const prompt = formatHighlightPrelabelForPrompt(input);
    expect(prompt.includes("e01_s009")).toBe(false);
    expect(prompt.includes("e01_s002")).toBe(true);
  });
});

describe("formatHighlightPrelabelForPrompt", () => {
  it("emits hook / mid / cliff sections for prompt injection", () => {
    const segments = [
      seg("e01_s002", "跪下道歉，废物", 1000, 4000),
      seg("e02_s003", "居然你出轨了", 10_000, 14_000, "e02", 2),
      seg("e02_s008", "下集告诉你真相，你先别问", 40_000, 45_000, "e02", 2),
    ];
    const text = formatHighlightPrelabelForPrompt(segments);
    expect(text).toContain("ASR 高光预标");
    expect(text).toContain("可作片头");
    expect(text).toContain("冲突 / 反转");
    expect(text).toContain("悬念");
    expect(text).toContain("e01_s002");
  });
});
