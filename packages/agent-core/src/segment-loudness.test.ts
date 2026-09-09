import { describe, expect, it } from "vitest";
import type { AsrSegment } from "@clip/sdk";
import {
  acousticScoreFromRms,
  classifySegmentSilenceAndFiller,
  estimateCharCount,
  estimateSpeechRate,
  isAnswerFillerText,
  isFillerOnlyText,
  parseAstatsOutput,
  probeSegmentLoudnessBatch,
} from "./segment-loudness.js";

describe("estimateCharCount", () => {
  it("counts Chinese chars as single units", () => {
    expect(estimateCharCount("滚出去")).toBe(3);
    expect(estimateCharCount("你算什么东西")).toBe(6);
  });

  it("counts latin words as single units", () => {
    expect(estimateCharCount("hello world")).toBe(2);
    expect(estimateCharCount("OK 123 go")).toBe(3);
  });

  it("counts mixed cn+en", () => {
    expect(estimateCharCount("hello 世界")).toBe(3);
  });

  it("returns 0 for empty/whitespace", () => {
    expect(estimateCharCount("")).toBe(0);
    expect(estimateCharCount("   ")).toBe(0);
  });
});

describe("estimateSpeechRate", () => {
  it("computes chars per second", () => {
    // 6 chars over 3000ms = 2.0 chars/s
    expect(estimateSpeechRate("你算什么东西", 3000)).toBe(2);
  });

  it("returns undefined for zero/negative duration", () => {
    expect(estimateSpeechRate("hello", 0)).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(estimateSpeechRate("", 1000)).toBeUndefined();
  });
});

describe("parseAstatsOutput", () => {
  it("extracts RMS and Peak dB from astats stderr", () => {
    const stderr = [
      "[Parsed_astats_0 @ 0x...] Changing sample format.",
      "Duration: 00:00:03.00, bitrate: 1536 kb/s",
      "Channel: MONO",
      "Peak level dB:    -3.12",
      "RMS level dB:     -23.45",
      "DC offset 1: 0.000000",
    ].join("\n");
    const { rmsDb, peakDb } = parseAstatsOutput(stderr);
    expect(rmsDb).toBeCloseTo(-23.45, 2);
    expect(peakDb).toBeCloseTo(-3.12, 2);
  });

  it("returns undefined when metrics absent", () => {
    const { rmsDb, peakDb } = parseAstatsOutput("no metrics here\n");
    expect(rmsDb).toBeUndefined();
    expect(peakDb).toBeUndefined();
  });
});

describe("acousticScoreFromRms", () => {
  it("scores 2 for loud (>= -16 dB)", () => {
    expect(acousticScoreFromRms(-14)).toBe(2);
    expect(acousticScoreFromRms(-16)).toBe(2);
  });

  it("scores 1 for raised (-22..-16 dB)", () => {
    expect(acousticScoreFromRms(-20)).toBe(1);
    expect(acousticScoreFromRms(-22)).toBe(1);
  });

  it("scores 0 for quiet (< -22 dB)", () => {
    expect(acousticScoreFromRms(-25)).toBe(0);
    expect(acousticScoreFromRms(-40)).toBe(0);
  });

  it("scores 0 when rmsDb missing", () => {
    expect(acousticScoreFromRms(undefined)).toBe(0);
  });
});

describe("isFillerOnlyText", () => {
  it("flags pure filler words", () => {
    expect(isFillerOnlyText("嗯")).toBe(true);
    expect(isFillerOnlyText("啊")).toBe(true);
    expect(isFillerOnlyText("嗯嗯")).toBe(true);
    expect(isFillerOnlyText("呃，那个……")).toBe(true);
  });
  it("allows meaningful dialogue", () => {
    expect(isFillerOnlyText("你给我滚出去")).toBe(false);
    expect(isFillerOnlyText("好的，我马上走")).toBe(false);
  });
});

describe("isAnswerFillerText", () => {
  it("flags isolated answer fillers", () => {
    expect(isAnswerFillerText("好的")).toBe(true);
    expect(isAnswerFillerText("是")).toBe(true);
    expect(isAnswerFillerText("对")).toBe(true);
    expect(isAnswerFillerText("知道了")).toBe(true);
    expect(isAnswerFillerText("好")).toBe(true);
  });
  it("rejects non-answer filler or meaningful sentences", () => {
    expect(isAnswerFillerText("好的，我马上走")).toBe(false);
    expect(isAnswerFillerText("是王家的人")).toBe(false);
  });
});

describe("classifySegmentSilenceAndFiller", () => {
  it("computes leading/trailing silence and flags answer filler", () => {
    const seg: AsrSegment = {
      segmentId: "e01_s001",
      startMs: 0,
      endMs: 5000,
      text: "好的",
      speechStartMs: 800,
      speechEndMs: 1600,
    };
    const out = classifySegmentSilenceAndFiller(seg);
    expect(out.leadingSilenceMs).toBe(800);
    expect(out.trailingSilenceMs).toBe(3400);
    expect(out.isAnswerFiller).toBe(true);
  });
  it("falls back to startMs/endMs when speech boundaries absent", () => {
    const seg: AsrSegment = {
      segmentId: "e01_s001",
      startMs: 0,
      endMs: 1000,
      text: "嗯",
    };
    const out = classifySegmentSilenceAndFiller(seg);
    expect(out.leadingSilenceMs).toBe(0);
    expect(out.trailingSilenceMs).toBe(0);
    expect(out.isFillerOnly).toBe(true);
  });
});

describe("probeSegmentLoudnessBatch", () => {
  const segments: AsrSegment[] = [
    {
      segmentId: "e01_s001",
      episodeId: "e01",
      startMs: 0,
      endMs: 5000,
      text: "你算什么东西给我滚出去",
      confidence: 0.9,
    },
    {
      segmentId: "e01_s002",
      episodeId: "e01",
      startMs: 5000,
      endMs: 5200,
      text: "短",
      confidence: 0.9,
    },
  ];

  it("enriches segments with speechRate without calling ffmpeg when segment too short", async () => {
    // ffmpeg not available in test env; long segment will fail + be skipped,
    // short segment (< 200ms) skips ffmpeg and only gets speechRate
    const out = await probeSegmentLoudnessBatch("/nonexistent/audio.wav", segments, {
      ffmpegPath: "/nonexistent/ffmpeg",
      perSegmentTimeoutMs: 500,
    });
    // speechRate always computed
    expect(out[0]!.speechRate).toBe(2.2); // 11 chars / 5s
    expect(out[1]!.speechRate).toBe(5); // 1 char / 0.2s
    // long segment: ffmpeg fails → rmsDb undefined (graceful skip)
    expect(out[0]!.rmsDb).toBeUndefined();
    // short segment: ffmpeg not called → rmsDb undefined
    expect(out[1]!.rmsDb).toBeUndefined();
  });

  it("always returns same-length array as input", async () => {
    const out = await probeSegmentLoudnessBatch("/nonexistent/audio.wav", segments, {
      ffmpegPath: "/nonexistent/ffmpeg",
      perSegmentTimeoutMs: 500,
    });
    expect(out).toHaveLength(segments.length);
    // preserves segmentId
    expect(out.map((s) => s.segmentId)).toEqual(["e01_s001", "e01_s002"]);
  });
});
