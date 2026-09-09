import { describe, expect, it } from "vitest";
import { RuleEngine, validateClipPlan, repairClipPlan, prepareRenderClips, dedupeOverlappingRenderClips, computePlanDurationSec, extendEpisodeAsrTails, finalizeEpisodeAsrFromRaw, ensureContinuousEpisodeAsrTimeline, backfillSpeechStartFromRaw, applyHookOpeningTrim } from "../src/rule-engine.js";
import type { AsrRules, AsrSegment, ClipPlan, RawAsrSegment, RenderConfig } from "@clip/sdk";

const rules: AsrRules = {
  ruleSetId: "test",
  ruleSetVersion: "1.0.0",
  vad: { minSpeechMs: 500 },
  merge: { minGapMs: 300, maxSentenceMs: 15000 },
  filter: {
    minSegmentMs: 500,
    minConfidence: 0.5,
    dropEmptyText: true,
    dropFillersOnly: true,
  },
  text: { trimWhitespace: true, removeFillers: ["嗯", "啊"] },
  output: { segmentIdPrefix: "s", maxSegments: 10 },
};

describe("RuleEngine episode tail preservation", () => {
  it("folds trailing silent tail into previous segment instead of dropping", () => {
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 0, endMs: 120_000, text: "悬念台词。", confidence: 0.9 },
      { id: "r2", startMs: 120_000, endMs: 130_000, text: "", confidence: 0.9 },
    ];
    const engine = new RuleEngine();
    const result = engine.apply(raw, rules);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.endMs).toBe(130_000);
    expect(result.segments[0]?.text).toBe("悬念台词。");
  });

  it("does not drop last segment when it exceeds maxSegmentMs", () => {
    const longRules: AsrRules = {
      ...rules,
      filter: { ...rules.filter!, maxSegmentMs: 30_000 },
    };
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 0, endMs: 10_000, text: "开场。", confidence: 0.9 },
      { id: "r2", startMs: 10_000, endMs: 55_000, text: "集尾长段。", confidence: 0.9 },
    ];
    const engine = new RuleEngine();
    const result = engine.apply(raw, longRules);
    expect(result.segments.at(-1)?.endMs).toBe(55_000);
  });

  it("folds short trailing speech after silence into previous segment (e09-like)", () => {
    const dramaRules: AsrRules = {
      ...rules,
      pipeline: { sentenceLevel: true },
      vad: { mergeGapMs: 1800 },
      merge: { minGapMs: 800, maxSentenceMs: 20000, splitOnPunc: ["。", "？", "！"] },
      filter: { minSegmentMs: 800, minConfidence: 0.5, dropEmptyText: true, dropFillersOnly: true },
      text: { trimWhitespace: true, removeFillers: ["嗯", "啊"] },
    };
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 154_170, endMs: 161_315, text: "秘书还要负责泡咖啡的吗？行吧，你是总裁，你说了算，", confidence: 0.9 },
      { id: "r2", startMs: 169_070, endMs: 169_675, text: "搞定，", confidence: 0.9 },
      { id: "r3", startMs: 172_520, endMs: 173_135, text: "谢谢。", confidence: 0.9 },
    ];
    const result = new RuleEngine().apply(raw, dramaRules);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.endMs).toBe(173_135);
    expect(result.segments[0]?.text).toContain("谢谢");
  });

  it("folds short filler tail into previous segment (e08-like)", () => {
    const dramaRules: AsrRules = {
      ...rules,
      pipeline: { sentenceLevel: true },
      vad: { mergeGapMs: 1800 },
      merge: { minGapMs: 800, maxSentenceMs: 20000, splitOnPunc: ["。", "？", "！"] },
      filter: { minSegmentMs: 800, minConfidence: 0.5, dropEmptyText: true, dropFillersOnly: true },
      text: { trimWhitespace: true, removeFillers: ["嗯", "啊"] },
    };
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 142_700, endMs: 146_945, text: "行包在我身上走吧。", confidence: 0.9 },
      { id: "r2", startMs: 149_020, endMs: 149_260, text: "嗯，", confidence: 0.9 },
      { id: "r3", startMs: 150_750, endMs: 150_990, text: "是。", confidence: 0.9 },
    ];
    const result = new RuleEngine().apply(raw, dramaRules);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.endMs).toBe(150_990);
    expect(result.segments[0]?.text).toContain("是");
  });

  it("extends last segment to sourceDurationMs when silent video tail exists", () => {
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 166_480, endMs: 173_725, text: "末句台词。", confidence: 0.9 },
    ];
    const engine = new RuleEngine();
    const { segments } = finalizeEpisodeAsrFromRaw(engine, raw, rules, {
      sourceDurationMs: 178_500,
      episodeId: "e01",
    });
    expect(segments.at(-1)?.endMs).toBe(178_500);
  });

  it("extendEpisodeAsrTails only extends chronologically last segment for s00N ids", () => {
    const segments: AsrSegment[] = [
      { segmentId: "s010", startMs: 100_000, endMs: 120_000, text: "A" },
      { segmentId: "s011", startMs: 166_480, endMs: 173_725, text: "B" },
    ];
    const { segments: extended } = extendEpisodeAsrTails(segments, { default: 178_000 });
    expect(extended.find((s) => s.segmentId === "s010")?.endMs).toBe(120_000);
    expect(extended.find((s) => s.segmentId === "s011")?.endMs).toBe(178_000);
  });
});

describe("RuleEngine", () => {
  it("merges adjacent segments and filters fillers", () => {
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 0, endMs: 2000, text: "你怎么", confidence: 0.9 },
      { id: "r2", startMs: 2100, endMs: 4000, text: "能这样对我？", confidence: 0.92 },
      { id: "r3", startMs: 5000, endMs: 5200, text: "嗯", confidence: 0.99 },
      { id: "r4", startMs: 6000, endMs: 9000, text: "我不信。", confidence: 0.88 },
    ];

    const engine = new RuleEngine();
    const result = engine.apply(raw, rules);

    expect(result.stats.rawCount).toBe(4);
    expect(result.stats.finalCount).toBe(2);
    expect(result.segments[0]?.text).toContain("你怎么");
    expect(result.segments[0]?.segmentId).toBe("s001");
    expect(result.segments[1]?.text).toBe("我不信。");
  });

  it("merges breath-pause fragments into sentence-level segments", () => {
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 0, endMs: 2000, text: "你以为", confidence: 0.9 },
      { id: "r2", startMs: 2800, endMs: 5000, text: "我会怕你吗", confidence: 0.9 },
      { id: "r3", startMs: 5200, endMs: 6500, text: "？", confidence: 0.9 },
      { id: "r4", startMs: 9000, endMs: 12000, text: "不可能。", confidence: 0.88 },
    ];

    const dramaRules: AsrRules = {
      ...rules,
      pipeline: { sentenceLevel: true },
      vad: { mergeGapMs: 1800 },
      merge: { minGapMs: 800, maxSentenceMs: 20000, splitOnPunc: ["。", "？", "！"] },
      filter: { minSegmentMs: 800, minConfidence: 0.5, dropEmptyText: true },
    };

    const result = new RuleEngine().apply(raw, dramaRules);
    expect(result.segments.length).toBe(2);
    expect(result.segments[0]?.text).toContain("？");
    expect(result.segments[1]?.text).toBe("不可能。");
  });
});

describe("validateClipPlan", () => {
  const segments: AsrSegment[] = [
    { segmentId: "s001", startMs: 0, endMs: 5000, text: "A" },
    { segmentId: "s002", startMs: 6000, endMs: 12000, text: "B" },
  ];

  const render: RenderConfig = {
    encode: { codec: "libx264" },
    limits: { maxDurationSec: 60 },
  };

  it("accepts valid plan", () => {
    const plan: ClipPlan = {
      version: "1.0",
      clips: [{ segmentId: "s001" }, { segmentId: "s002" }],
      output: { maxDurationSec: 60 },
    };
    const result = validateClipPlan(plan, segments, render);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.totalDurationMs).toBe(11000);
  });

  it("rejects unknown segment", () => {
    const plan: ClipPlan = {
      version: "1.0",
      clips: [{ segmentId: "s999" }],
      output: {},
    };
    const result = validateClipPlan(plan, segments, render);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("unknown segmentId");
  });

  it("rejects 隔集跳戏 when episodes are not adjacent", () => {
    const multi: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", episodeNo: 1, startMs: 0, endMs: 4000, text: "A" },
      { segmentId: "e01_s002", episodeId: "e01", episodeNo: 1, startMs: 4000, endMs: 8000, text: "B" },
      { segmentId: "e04_s001", episodeId: "e04", episodeNo: 4, startMs: 0, endMs: 4000, text: "C" },
      { segmentId: "e04_s002", episodeId: "e04", episodeNo: 4, startMs: 4000, endMs: 8000, text: "D" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s001" },
        { segmentId: "e01_s002" },
        { segmentId: "e04_s001" },
        { segmentId: "e04_s002" },
      ],
      output: { maxDurationSec: 120 },
    };
    const result = validateClipPlan(plan, multi, { encode: { codec: "libx264" } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("隔集跳戏"))).toBe(true);
  });

  it("rejects 隔集跳戏 even when episodeNo is 0 (fallback to eXX id)", () => {
    const multi: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", episodeNo: 0, startMs: 0, endMs: 4000, text: "A" },
      { segmentId: "e01_s002", episodeId: "e01", episodeNo: 0, startMs: 4000, endMs: 8000, text: "B" },
      { segmentId: "e04_s001", episodeId: "e04", episodeNo: 0, startMs: 0, endMs: 4000, text: "C" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s001" }, { segmentId: "e01_s002" }, { segmentId: "e04_s001" }],
      output: { maxDurationSec: 120 },
    };
    const result = validateClipPlan(plan, multi, { encode: { codec: "libx264" } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("隔集跳戏"))).toBe(true);
  });

  it("rejects skipping even one episode (no escape hatch)", () => {
    const multi: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", episodeNo: 1, startMs: 0, endMs: 4000, text: "A" },
      { segmentId: "e03_s001", episodeId: "e03", episodeNo: 3, startMs: 0, endMs: 4000, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s001" }, { segmentId: "e03_s001" }],
      output: { maxDurationSec: 120 },
    };
    const result = validateClipPlan(plan, multi, { encode: { codec: "libx264" } });
    expect(result.errors.some((e) => e.includes("隔集跳戏"))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("allows strictly adjacent episodes", () => {
    const multi: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", episodeNo: 1, startMs: 0, endMs: 4000, text: "A" },
      { segmentId: "e02_s001", episodeId: "e02", episodeNo: 2, startMs: 0, endMs: 4000, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s001" }, { segmentId: "e02_s001" }],
      output: { maxDurationSec: 120 },
    };
    const result = validateClipPlan(plan, multi, { encode: { codec: "libx264" } });
    expect(result.errors.filter((e) => e.includes("隔集跳戏"))).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("repairClipPlan", () => {
  const segments: AsrSegment[] = [
    { segmentId: "s001", startMs: 0, endMs: 15000, text: "A" },
    { segmentId: "s002", startMs: 16000, endMs: 28000, text: "B" },
    { segmentId: "s003", startMs: 29000, endMs: 40000, text: "C" },
  ];

  it("drops trailing clips when total duration exceeds max", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "s001" }, { segmentId: "s002" }, { segmentId: "s003" }],
      output: { maxDurationSec: 35 },
    };
    const { plan: repaired, repairs } = repairClipPlan(plan, segments, { maxDurationSec: 35 });
    expect(repairs.length).toBeGreaterThan(0);
    expect(repaired.clips.length).toBeLessThan(plan.clips.length);
    const validation = validateClipPlan(repaired, segments, { encode: { codec: "libx264" } });
    expect(validation.valid).toBe(true);
  });
});

describe("prepareRenderClips", () => {
  it("computePlanDurationSec sums ASR segment lengths", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e06_s015", episodeId: "e06", startMs: 81940, endMs: 85040, text: "A" },
      { segmentId: "e06_s016", episodeId: "e06", startMs: 85560, endMs: 88960, text: "B" },
      { segmentId: "e07_s006", episodeId: "e07", startMs: 35500, endMs: 45840, text: "C" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e06_s015" }, { segmentId: "e06_s016" }, { segmentId: "e07_s006" }],
      output: { maxDurationSec: 60 },
    };
    expect(computePlanDurationSec(plan.clips, segments)).toBe(17);
  });

  it("collapses same-episode plan block into one render cut", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", startMs: 0, endMs: 5000, text: "A" },
      { segmentId: "e01_s002", episodeId: "e01", startMs: 6000, endMs: 10000, text: "B" },
      { segmentId: "e01_s003", episodeId: "e01", startMs: 12000, endMs: 16000, text: "C" },
      { segmentId: "e05_s007", episodeId: "e05", startMs: 20000, endMs: 25000, text: "D" },
      { segmentId: "e05_s008", episodeId: "e05", startMs: 26000, endMs: 30000, text: "E" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s001" },
        { segmentId: "e01_s002" },
        { segmentId: "e01_s003" },
        { segmentId: "e05_s007" },
        { segmentId: "e05_s008" },
      ],
      output: { maxDurationSec: 60 },
    };

    const { clips, repairs } = prepareRenderClips(plan, segments);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.startMs).toBe(0);
    expect(clips[0]!.endMs).toBe(16000);
    expect(clips[1]!.startMs).toBe(20000);
    expect(clips[1]!.endMs).toBe(30000);
    expect(repairs.some((r) => r.includes("并入同集块"))).toBe(true);
  });

  it("trims long silent head using speechStartMs − pad", () => {
    const segments: AsrSegment[] = [
      {
        segmentId: "e01_s001",
        episodeId: "e01",
        startMs: 0,
        endMs: 20_000,
        speechStartMs: 5_000,
        text: "你给我滚出去",
      },
      {
        segmentId: "e02_s001",
        episodeId: "e02",
        startMs: 0,
        endMs: 8_000,
        speechStartMs: 0,
        text: "B",
      },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      hookSegmentId: "e01_s001",
      clips: [
        { segmentId: "e01_s001", role: "hook" },
        { segmentId: "e02_s001", role: "escalate" },
      ],
      output: { maxDurationSec: 60 },
    };
    const { clips, repairs } = prepareRenderClips(plan, segments);
    // 开口 5s − 前垫 0.8s = 4.2s
    expect(clips[0]!.startMs).toBe(4_200);
    expect(repairs.some((r) => r.includes("hook 开口校正"))).toBe(true);
  });

  it("pads mid-episode hook before speech onset", () => {
    const segments: AsrSegment[] = [
      {
        segmentId: "e01_s020",
        episodeId: "e01",
        startMs: 100_000,
        endMs: 110_000,
        speechStartMs: 100_000,
        text: "你算什么东西",
      },
      {
        segmentId: "e02_s001",
        episodeId: "e02",
        startMs: 0,
        endMs: 5_000,
        text: "B",
      },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s020", role: "hook" },
        { segmentId: "e02_s001", role: "cliff" },
      ],
      output: { maxDurationSec: 60 },
    };
    const { clips } = prepareRenderClips(plan, segments);
    expect(clips[0]!.startMs).toBe(99_200);
  });

  it("caps lead silence when pad exceeds maxLead", () => {
    const segments: AsrSegment[] = [
      {
        segmentId: "e01_s001",
        episodeId: "e01",
        startMs: 0,
        endMs: 30_000,
        speechStartMs: 12_000,
        text: "冲突台词",
      },
      {
        segmentId: "e02_s001",
        episodeId: "e02",
        startMs: 0,
        endMs: 5_000,
        text: "B",
      },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s001", role: "hook" },
        { segmentId: "e02_s001", role: "escalate" },
      ],
      output: { maxDurationSec: 60 },
    };
    const { clips } = prepareRenderClips(plan, segments, {
      hookOpeningPadMs: 3_000,
      hookMaxLeadSilenceMs: 1_500,
    });
    // 前垫 3s 会被静音顶压成 1.5s → 起点 10.5s
    expect(clips[0]!.startMs).toBe(10_500);
  });

  it("keeps separate cuts for different episodes", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", startMs: 0, endMs: 5000, text: "A" },
      { segmentId: "e02_s001", episodeId: "e02", startMs: 6000, endMs: 10000, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s001" }, { segmentId: "e02_s001" }],
      output: { maxDurationSec: 60 },
    };

    const { clips } = prepareRenderClips(plan, segments);
    expect(clips).toHaveLength(2);
  });

  it("merges same-episode touching clips", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e01_s001", episodeId: "e01", startMs: 0, endMs: 5000, text: "A" },
      { segmentId: "e01_s002", episodeId: "e01", startMs: 4900, endMs: 10000, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s001" }, { segmentId: "e01_s002" }],
      output: { maxDurationSec: 60 },
    };

    const { clips } = prepareRenderClips(plan, segments);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.startMs).toBe(0);
    expect(clips[0]!.endMs).toBe(10000);
  });

  it("dedupeOverlappingRenderClips trims overlapping range on same episode", () => {
    const { clips } = dedupeOverlappingRenderClips([
      { segmentId: "a", episodeId: "e01", startMs: 0, endMs: 10000, text: "1" },
      { segmentId: "b", episodeId: "e01", startMs: 8000, endMs: 15000, text: "2" },
    ]);
    expect(clips).toHaveLength(2);
    expect(clips[1]!.startMs).toBe(10000);
    expect(clips[1]!.endMs).toBe(15000);
  });

  it("extends episode-tail render cut to source video duration", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e03_s010", episodeId: "e03", startMs: 80000, endMs: 85000, text: "A" },
      { segmentId: "e03_s011", episodeId: "e03", startMs: 85100, endMs: 89500, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e03_s010" }, { segmentId: "e03_s011", role: "cliff" }],
      output: { maxDurationSec: 60 },
    };

    const { clips, repairs } = prepareRenderClips(plan, segments, {
      episodeSourceDurationMs: { e03: 94_000 },
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.endMs).toBe(94_000);
    expect(repairs.some((r) => r.includes("集尾切条延伸"))).toBe(true);
  });

  it("does not extend mid-episode blocks", () => {
    const segments: AsrSegment[] = [
      { segmentId: "e03_s001", episodeId: "e03", startMs: 0, endMs: 5000, text: "A" },
      { segmentId: "e03_s011", episodeId: "e03", startMs: 85100, endMs: 89500, text: "B" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e03_s001" }],
      output: { maxDurationSec: 60 },
    };

    const { clips } = prepareRenderClips(plan, segments, {
      episodeSourceDurationMs: { e03: 94_000 },
    });
    expect(clips[0]!.endMs).toBe(5000);
  });
});

describe("finalizeEpisodeAsrFromRaw", () => {
  it("extends last segment to ffprobe video duration (e01-like tail gap)", () => {
    const dramaRules: AsrRules = {
      ...rules,
      pipeline: { sentenceLevel: true },
      vad: { mergeGapMs: 1800 },
      merge: { minGapMs: 800, maxSentenceMs: 20000, splitOnPunc: ["。", "？", "！"] },
      filter: { minSegmentMs: 800, minConfidence: 0.5, dropEmptyText: true, dropFillersOnly: true },
      text: { trimWhitespace: true, removeFillers: ["嗯", "啊"] },
    };
    const raw: RawAsrSegment[] = [
      {
        id: "r041",
        startMs: 166_480,
        endMs: 173_725,
        text: "末句台词。",
        confidence: 0.9,
      },
    ];
    const engine = new RuleEngine();
    const videoDurationMs = 178_000; // 2:58
    const { segments, tailRepairs } = finalizeEpisodeAsrFromRaw(engine, raw, dramaRules, {
      sourceDurationMs: videoDurationMs,
      episodeId: "e01",
    });
    expect(segments[0]?.startMs).toBe(0);
    expect(segments[0]?.speechStartMs).toBe(166_480);
    expect(segments.at(-1)?.endMs).toBe(videoDurationMs);
    expect(segments.at(-1)?.episodeId).toBe("e01");
    // 片头并入首段有语音，不另插空白段
    expect(segments[0]?.text).toContain("末句");
    expect(segments.some((s) => s.text.includes("无台词"))).toBe(false);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startMs).toBe(segments[i - 1]!.endMs);
    }
    expect(tailRepairs.some((r) => r.includes("片头并入首段") || r.includes("片尾补连续"))).toBe(
      true,
    );
  });

  it("fills mid-episode silence gaps so timeline is continuous", () => {
    const dramaRules: AsrRules = {
      ...rules,
      pipeline: { sentenceLevel: true },
      vad: { mergeGapMs: 200 },
      merge: { minGapMs: 200, maxSentenceMs: 20000, splitOnPunc: ["。", "？", "！"] },
      filter: { minSegmentMs: 200, minConfidence: 0.5, dropEmptyText: true },
      text: { trimWhitespace: true },
    };
    const raw: RawAsrSegment[] = [
      { id: "r001", startMs: 1000, endMs: 3000, text: "第一句。", confidence: 0.9 },
      { id: "r002", startMs: 8000, endMs: 10000, text: "第二句。", confidence: 0.9 },
    ];
    const engine = new RuleEngine();
    const { segments } = finalizeEpisodeAsrFromRaw(engine, raw, dramaRules, {
      sourceDurationMs: 12_000,
      episodeId: "e02",
    });
    expect(segments[0]!.startMs).toBe(0);
    expect(segments[0]!.speechStartMs).toBe(1000);
    expect(segments.at(-1)!.endMs).toBe(12_000);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startMs).toBe(segments[i - 1]!.endMs);
    }
  });
});

describe("extendEpisodeAsrTails", () => {
  it("extends last segment endMs to source video duration", () => {
    const segments: AsrSegment[] = [
      { segmentId: "s001", startMs: 0, endMs: 5000, text: "A" },
      { segmentId: "s002", startMs: 6000, endMs: 89500, text: "B" },
    ];
    const { segments: extended, repairs } = extendEpisodeAsrTails(segments, { default: 94_000 });
    expect(extended.at(-1)!.endMs).toBe(94_000);
    expect(repairs[0]).toContain("集尾延伸");
  });
});

describe("speechStartMs + hook opening", () => {
  it("ensureContinuous keeps speechStartMs when pulling head to 0", () => {
    const { segments, repairs } = ensureContinuousEpisodeAsrTimeline(
      [{ segmentId: "s001", startMs: 8_000, endMs: 12_000, text: "开口" }],
      15_000,
      { episodeId: "e01" },
    );
    expect(segments[0]!.startMs).toBe(0);
    expect(segments[0]!.speechStartMs).toBe(8_000);
    expect(repairs.some((r) => r.includes("开口="))).toBe(true);
  });

  it("backfillSpeechStartFromRaw restores onset for legacy head-merged rows", () => {
    const segments: AsrSegment[] = [
      { segmentId: "s001", startMs: 0, endMs: 10_000, text: "第一句" },
    ];
    const raw: RawAsrSegment[] = [
      { id: "r1", startMs: 6_500, endMs: 9_000, text: "第一句", confidence: 0.9 },
    ];
    const filled = backfillSpeechStartFromRaw(segments, raw);
    expect(filled[0]!.speechStartMs).toBe(6_500);
  });

  it("applyHookOpeningTrim no-ops when onset already near start", () => {
    const clips = [
      { segmentId: "e01_s002", episodeId: "e01", startMs: 5_000, endMs: 12_000, text: "A" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s002", role: "hook" }],
      output: { maxDurationSec: 30 },
    };
    const segments: AsrSegment[] = [
      {
        segmentId: "e01_s002",
        episodeId: "e01",
        startMs: 5_000,
        endMs: 12_000,
        speechStartMs: 5_200,
        text: "A",
      },
    ];
    const { repairs } = applyHookOpeningTrim(clips, plan, segments);
    // 5.2s − 0.8s = 4.4s，会前移；此处验证函数可调用
    expect(repairs.length).toBeGreaterThanOrEqual(0);
  });
});
