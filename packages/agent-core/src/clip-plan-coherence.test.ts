import { describe, expect, it } from "vitest";
import {
  repairClipPlanContiguity,
  dedupePlanClipIds,
  removePlanTimelineAndTextDuplicates,
  removeDuplicateEpisodeBlocks,
  expandPlanToMinDuration,
  expandPlanToDuration,
  expandClipBlockRanges,
  finalizeMixPlanForRender,
} from "../src/clip-plan-coherence.js";
import { validateClipPlan } from "../src/rule-engine.js";
import type { AsrSegment, ClipPlan } from "@clip/sdk";

const e01Segments: AsrSegment[] = [
  { segmentId: "e01_s010", episodeId: "e01", episodeNo: 1, startMs: 10000, endMs: 15000, text: "你怎么能这样" },
  { segmentId: "e01_s011", episodeId: "e01", episodeNo: 1, startMs: 15000, endMs: 20000, text: "这土地是我家的" },
  { segmentId: "e01_s012", episodeId: "e01", episodeNo: 1, startMs: 20000, endMs: 25000, text: "我绝不会签" },
  { segmentId: "e01_s013", episodeId: "e01", episodeNo: 1, startMs: 25000, endMs: 30000, text: "那就别怪我不客气" },
  { segmentId: "e01_s020", episodeId: "e01", episodeNo: 1, startMs: 60000, endMs: 65000, text: "三年后我回来了" },
];

const e02Segments: AsrSegment[] = [
  { segmentId: "e02_s003", episodeId: "e02", episodeNo: 2, startMs: 8000, endMs: 13000, text: "血债血还" },
  { segmentId: "e02_s004", episodeId: "e02", episodeNo: 2, startMs: 13000, endMs: 18000, text: "你等着瞧" },
];

const segments = [...e01Segments, ...e02Segments];

function basePlan(clips: ClipPlan["clips"]): ClipPlan {
  return {
    version: "2.0",
    strategy: "conflict_burst",
    durationTier: "M",
    targetDurationSec: 30,
    estimatedDurationSec: 25,
    clips,
    output: { ratio: "auto", maxDurationSec: 30, subtitle: true },
  };
}

describe("repairClipPlanContiguity drama mix", () => {
  it("repairs jump-pick within episode block but keeps cross-episode clips", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook" },
      { segmentId: "e01_s020", role: "escalate" },
      { segmentId: "e02_s003", role: "cliff" },
    ]);

    const { plan: repaired, repairs } = repairClipPlanContiguity(plan, segments, {
      maxDurationSec: 40,
      maxClipCount: 6,
      minClips: 2,
    });

    expect(repairs.some((r) => r.includes("集内 seq 跳选"))).toBe(true);
    expect(repaired.clips.some((c) => c.segmentId.startsWith("e01_"))).toBe(true);
    expect(repaired.clips.some((c) => c.segmentId.startsWith("e02_"))).toBe(true);
    expect(repaired.clips.at(-1)!.segmentId).toMatch(/^e02_/);
  });

  it("replaces jump-pick single episode with contiguous window", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook" },
      { segmentId: "e01_s020", role: "cliff" },
    ]);

    const { plan: repaired } = repairClipPlanContiguity(plan, e01Segments, {
      maxDurationSec: 30,
      maxClipCount: 5,
      minClips: 2,
    });

    expect(repaired.clips[0]!.segmentId).toBe("e01_s010");
    for (let i = 1; i < repaired.clips.length; i++) {
      const prev = Number.parseInt(repaired.clips[i - 1]!.segmentId.match(/s(\d+)$/)![1]!, 10);
      const cur = Number.parseInt(repaired.clips[i]!.segmentId.match(/s(\d+)$/)![1]!, 10);
      expect(cur - prev).toBe(1);
    }
  });
});

describe("sanitize plan duplicates", () => {
  it("removes duplicate segmentId within plan", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook" },
      { segmentId: "e01_s011", role: "context" },
      { segmentId: "e01_s010", role: "cliff" },
    ]);

    const { plan: deduped, repairs } = dedupePlanClipIds(plan);
    expect(deduped.clips).toHaveLength(2);
    expect(repairs.some((r) => r.includes("e01_s010"))).toBe(true);
  });

  it("removes overlapping timeline segments", () => {
    const overlapping: AsrSegment[] = [
      { segmentId: "e01_s010", episodeId: "e01", startMs: 10000, endMs: 16000, text: "你怎么能这样" },
      { segmentId: "e01_s011", episodeId: "e01", startMs: 15500, endMs: 21000, text: "你怎么能这样对我" },
    ];
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook" },
      { segmentId: "e01_s011", role: "cliff" },
    ]);

    const { plan: cleaned, repairs } = removePlanTimelineAndTextDuplicates(plan, overlapping);
    expect(cleaned.clips).toHaveLength(1);
    expect(repairs.length).toBeGreaterThan(0);
  });

  it("removes second block of same episode", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook" },
      { segmentId: "e01_s011", role: "escalate" },
      { segmentId: "e02_s003", role: "escalate" },
      { segmentId: "e01_s020", role: "cliff" },
    ]);

    const { plan: cleaned, repairs } = removeDuplicateEpisodeBlocks(plan, segments);
    expect(cleaned.clips.map((c) => c.segmentId)).toEqual(["e01_s010", "e01_s011", "e02_s003"]);
    expect(repairs.some((r) => r.includes("e01"))).toBe(true);
  });
});

describe("expandPlanToDuration", () => {
  it("expands toward tier target not just minimum", () => {
    const shortSegments: AsrSegment[] = Array.from({ length: 20 }, (_, i) => ({
      segmentId: `e01_s${String(i + 1).padStart(3, "0")}`,
      episodeId: "e01",
      startMs: i * 2000,
      endMs: (i + 1) * 2000,
      text: `line ${i}`,
    }));
    const plan = basePlan([{ segmentId: "e01_s001" }, { segmentId: "e01_s002" }]);

    const { plan: expanded, repairs } = expandPlanToDuration(plan, shortSegments, {
      minDurationSec: 20,
      targetDurationSec: 30,
      maxClipCount: 12,
      maxDurationSec: 60,
      expandClipHardLimit: 16,
    });

    expect(repairs.length).toBeGreaterThan(0);
    let ms = 0;
    for (const c of expanded.clips) {
      const s = shortSegments.find((x) => x.segmentId === c.segmentId)!;
      ms += s.endMs - s.startMs;
    }
    expect(ms).toBeGreaterThanOrEqual(28000);
    expect(ms).toBeLessThan(42000);
  });

  it("appends cross-episode windows when in-block expansion hits episode end", () => {
    const segments: AsrSegment[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        segmentId: `e01_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e01",
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e01-${i}`,
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        segmentId: `e02_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e02",
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e02-${i}`,
      })),
    ];
    const plan = basePlan([
      { segmentId: "e01_s006" },
      { segmentId: "e01_s007" },
      { segmentId: "e01_s008" },
    ]);

    const { plan: expanded, repairs } = expandPlanToDuration(plan, segments, {
      minDurationSec: 0,
      targetDurationSec: 60,
      maxClipCount: 50,
      maxDurationSec: 120,
      expandClipHardLimit: 50,
    });

    expect(repairs.some((r) => r.includes("跨集补块"))).toBe(true);
    expect(expanded.clips.length).toBeGreaterThan(10);
    let ms = 0;
    for (const c of expanded.clips) {
      const s = segments.find((x) => x.segmentId === c.segmentId)!;
      ms += s.endMs - s.startMs;
    }
    expect(ms).toBeGreaterThanOrEqual(55000);
  });

  it("does not append backward episodes when padding cross-episode duration", () => {
    const segments: AsrSegment[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        segmentId: `e05_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e05",
        episodeNo: 5,
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e05-${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        segmentId: `e11_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e11",
        episodeNo: 11,
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e11-${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        segmentId: `e17_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e17",
        episodeNo: 17,
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e17-${i}`,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        segmentId: `e08_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e08",
        episodeNo: 8,
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e08-${i}`,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        segmentId: `e18_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e18",
        episodeNo: 18,
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `e18-${i}`,
      })),
    ];
    const plan = basePlan([
      { segmentId: "e05_s001" },
      { segmentId: "e05_s002" },
      { segmentId: "e11_s001" },
      { segmentId: "e11_s002" },
      { segmentId: "e17_s001" },
      { segmentId: "e17_s002" },
    ]);

    const { plan: expanded } = expandPlanToDuration(plan, segments, {
      minDurationSec: 0,
      targetDurationSec: 120,
      maxClipCount: 50,
      maxDurationSec: 180,
      expandClipHardLimit: 50,
    });

    const episodeNos: number[] = [];
    let lastBlockEp = "";
    for (const clip of expanded.clips) {
      const seg = segments.find((s) => s.segmentId === clip.segmentId)!;
      const ep = seg.episodeId!;
      if (ep !== lastBlockEp) {
        episodeNos.push(seg.episodeNo ?? 0);
        lastBlockEp = ep;
      }
    }
    for (let i = 1; i < episodeNos.length; i++) {
      expect(episodeNos[i]!).toBeGreaterThanOrEqual(episodeNos[i - 1]!);
    }
    expect(episodeNos.some((n) => n === 8)).toBe(false);
    expect(expanded.clips.some((c) => c.segmentId.startsWith("e18_"))).toBe(true);
  });
});

describe("expandClipBlockRanges", () => {
  it("expands throughSegmentId into contiguous clips", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "hook", reason: "块首", throughSegmentId: "e01_s012" },
      { segmentId: "e02_s003", role: "cliff", reason: "跨集块" },
    ]);
    const { plan: expanded, repairs } = expandClipBlockRanges(plan, segments);
    expect(repairs.some((r) => r.includes("LLM 块合并"))).toBe(true);
    expect(expanded.clips.map((c) => c.segmentId)).toEqual([
      "e01_s010",
      "e01_s011",
      "e01_s012",
      "e02_s003",
    ]);
    expect(expanded.clips[0]!.role).toBe("hook");
    expect(expanded.clips[2]!.role).toBe("escalate");
    expect(expanded.clips[3]!.role).toBe("cliff");
  });

  it("puts cliff role on last segment of through block", () => {
    const plan = basePlan([
      { segmentId: "e01_s010", role: "cliff", reason: "片尾块", throughSegmentId: "e01_s012" },
    ]);
    const { plan: expanded } = expandClipBlockRanges(plan, segments);
    expect(expanded.clips.map((c) => c.role)).toEqual(["escalate", "escalate", "cliff"]);
  });
});

describe("finalizeMixPlanForRender", () => {
  it("repairs intra-episode seq jumps before render", () => {
    const plan = basePlan([
      { segmentId: "e02_s025", role: "hook" },
      { segmentId: "e02_s026", role: "context" },
      { segmentId: "e02_s027", role: "escalate" },
      { segmentId: "e02_s028", role: "escalate" },
      { segmentId: "e02_s035", role: "escalate" },
      { segmentId: "e03_s003", role: "cliff" },
    ]);
    const extra: AsrSegment[] = [
      { segmentId: "e02_s025", episodeId: "e02", episodeNo: 2, startMs: 1000, endMs: 5000, text: "a" },
      { segmentId: "e02_s026", episodeId: "e02", episodeNo: 2, startMs: 5000, endMs: 9000, text: "b" },
      { segmentId: "e02_s027", episodeId: "e02", episodeNo: 2, startMs: 9000, endMs: 12000, text: "c" },
      { segmentId: "e02_s028", episodeId: "e02", episodeNo: 2, startMs: 12000, endMs: 15000, text: "d" },
      { segmentId: "e02_s029", episodeId: "e02", episodeNo: 2, startMs: 15000, endMs: 18000, text: "e" },
      { segmentId: "e02_s035", episodeId: "e02", episodeNo: 2, startMs: 35000, endMs: 38000, text: "f" },
      { segmentId: "e03_s003", episodeId: "e03", episodeNo: 3, startMs: 1000, endMs: 5000, text: "g" },
    ];
    const { plan: fixed, repairs } = finalizeMixPlanForRender(plan, extra, {
      minDurationSec: 20,
      maxDurationSec: 60,
    });
    expect(repairs.some((r) => r.includes("seq") || r.includes("连续"))).toBe(true);
    expect(fixed.clips.length).toBeGreaterThan(2);
    expect(fixed.clips.some((c) => c.segmentId.startsWith("e03_"))).toBe(true);
  });

  it("passes validateClipPlan after duration expansion without backward episode jumps", () => {
    const segments: AsrSegment[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        segmentId: `e05_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e05",
        episodeNo: 5,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text: `e05 line ${i}`,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        segmentId: `e06_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e06",
        episodeNo: 6,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text: `e06 line ${i}`,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        segmentId: `e07_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e07",
        episodeNo: 7,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text: `e07 line ${i}`,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        segmentId: `e08_s${String(i + 1).padStart(3, "0")}`,
        episodeId: "e08",
        episodeNo: 8,
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text: `e08 line ${i}`,
      })),
    ];
    const plan = basePlan([
      { segmentId: "e05_s001", role: "hook" },
      { segmentId: "e05_s002", role: "escalate" },
      { segmentId: "e06_s001", role: "escalate" },
      { segmentId: "e06_s002", role: "escalate" },
      { segmentId: "e07_s001", role: "escalate" },
      { segmentId: "e07_s002", role: "cliff" },
    ]);
    plan.targetDurationSec = 120;
    plan.output.maxDurationSec = 180;

    const { plan: fixed } = finalizeMixPlanForRender(plan, segments, {
      minDurationSec: 60,
      maxDurationSec: 180,
      targetDurationSec: 120,
    });

    const validation = validateClipPlan(fixed, segments, { encode: { codec: "libx264" } });
    expect(validation.errors.filter((e) => e.includes("集序倒跳"))).toEqual([]);
    expect(validation.errors.filter((e) => e.includes("隔集跳戏"))).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});
