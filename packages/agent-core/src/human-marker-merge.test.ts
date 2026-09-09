import { describe, expect, it } from "vitest";
import {
  applyClientHumanMarkerOverrides,
  HUMAN_HIGHLIGHT_SCORE,
  mergeHumanHighlightMarkersIntoSegments,
} from "./human-marker-merge.js";
import { resolveClipTimestamps, applyHookOpeningTrim, applyCliffClosingTrim } from "./rule-engine.js";
import type { AsrSegment, ClipPlan } from "@clip/sdk";

describe("mergeHumanHighlightMarkersIntoSegments", () => {
  const base: AsrSegment[] = [
    {
      segmentId: "e01_s001",
      startMs: 0,
      endMs: 5000,
      text: "你怎么敢这样对我",
      speechStartMs: 800,
      highlightType: "conflict",
      highlightScore: 4,
      usableAsHook: true,
    },
  ];

  it("human overrides suppress and sets strict start", () => {
    const out = mergeHumanHighlightMarkersIntoSegments(base, [
      {
        startMs: 1000,
        endMs: 4000,
        source: "suppress",
        label: "已忽略",
      },
      {
        startMs: 2500,
        endMs: 4500,
        source: "human",
        highlightType: "hook",
        usableAsHook: true,
        label: "高光",
        markerId: 1,
      },
    ]);
    const seg = out.find((s) => s.segmentId === "e01_s001")!;
    expect(seg.highlightType).toBe("hook");
    expect(seg.highlightScore).toBe(HUMAN_HIGHLIGHT_SCORE);
    expect(seg.usableAsHook).toBe(true);
    expect(seg.humanMarkerStartMs).toBe(2500);
    expect(seg.speechStartMs).toBe(2500);
    expect((seg.labelSource ?? "").includes("human_marker")).toBe(true);
  });

  it("钩子 label maps to closing cliff", () => {
    const out = mergeHumanHighlightMarkersIntoSegments(base, [
      {
        startMs: 2500,
        endMs: 4500,
        source: "human",
        highlightType: "hook",
        label: "钩子",
        markerId: 2,
      },
    ]);
    const seg = out.find((s) => s.segmentId === "e01_s001")!;
    expect(seg.highlightType).toBe("cliff");
    expect(seg.usableAsHook).toBe(false);
    expect(seg.humanMarkerEndMs).toBe(4500);
  });

  it("non-opening human marker keeps existing usableAsHook", () => {
    const out = mergeHumanHighlightMarkersIntoSegments(base, [
      {
        startMs: 1000,
        endMs: 4000,
        source: "human",
        highlightType: "conflict",
        label: "冲突",
        markerId: 3,
      },
    ]);
    const seg = out.find((s) => s.segmentId === "e01_s001")!;
    expect(seg.highlightType).toBe("conflict");
    expect(seg.highlightScore).toBe(HUMAN_HIGHLIGHT_SCORE);
    // 冲突类人工标记不撤销段上已有 hook 资格
    expect(seg.usableAsHook).toBe(true);
  });

  it("inserts virtual closing segment when no overlap", () => {
    const out = mergeHumanHighlightMarkersIntoSegments(base, [
      {
        startMs: 6000,
        endMs: 8000,
        source: "human",
        highlightType: "cliff",
        label: "钩子",
        markerId: 9,
      },
    ]);
    const virtual = out.find((s) => s.segmentId === "human-9");
    expect(virtual?.startMs).toBe(6000);
    expect(virtual?.highlightType).toBe("cliff");
    expect(virtual?.humanMarkerEndMs).toBe(8000);
  });
});

describe("human marker render timestamps", () => {
  const segments: AsrSegment[] = [
    {
      segmentId: "e01_s002",
      startMs: 5000,
      endMs: 12000,
      text: "你给我跪下",
      speechStartMs: 5200,
      highlightType: "hook",
      highlightScore: HUMAN_HIGHLIGHT_SCORE,
      usableAsHook: true,
      humanMarkerStartMs: 7000,
      humanMarkerEndMs: 10000,
      labelSource: "human_marker",
    },
  ];

  const plan: ClipPlan = {
    version: "2.0",
    output: {},
    clips: [{ segmentId: "e01_s002", role: "hook" }],
    hookSegmentId: "e01_s002",
  };

  it("resolveClipTimestamps uses humanMarkerStartMs", () => {
    const resolved = resolveClipTimestamps(plan, segments);
    expect(resolved[0]?.startMs).toBe(7000);
    expect(resolved[0]?.endMs).toBe(10000);
  });

  it("applyHookOpeningTrim uses human start without pad", () => {
    const clipsBeforeTrim = [
      {
        segmentId: "e01_s002",
        episodeId: "e01",
        startMs: 5000,
        endMs: 12000,
        text: "你给我跪下",
      },
    ];
    const { clips, repairs } = applyHookOpeningTrim(clipsBeforeTrim, plan, segments);
    expect(clips[0]?.startMs).toBe(7000);
    expect(repairs.some((r) => r.includes("人工起点"))).toBe(true);
  });
});

describe("applyClientHumanMarkerOverrides", () => {
  it("merges client human fields onto server segments", () => {
    const server: AsrSegment[] = [
      { segmentId: "e01_s001", startMs: 0, endMs: 5000, text: "台词", highlightScore: 3 },
    ];
    const client: AsrSegment[] = [
      {
        segmentId: "e01_s001",
        startMs: 0,
        endMs: 5000,
        text: "台词",
        highlightType: "hook",
        highlightScore: HUMAN_HIGHLIGHT_SCORE,
        humanMarkerStartMs: 1800,
        labelSource: "human_marker",
      },
    ];
    const out = applyClientHumanMarkerOverrides(server, client);
    expect(out[0]?.humanMarkerStartMs).toBe(1800);
    expect(out[0]?.highlightType).toBe("hook");
  });

  it("applyCliffClosingTrim uses humanMarkerEndMs", () => {
    const segments: AsrSegment[] = [
      {
        segmentId: "e01_s003",
        startMs: 8000,
        endMs: 15000,
        text: "走着瞧",
        highlightType: "cliff",
        highlightScore: HUMAN_HIGHLIGHT_SCORE,
        humanMarkerEndMs: 12000,
        highlightTags: ["钩子"],
        labelSource: "human_marker",
      },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      output: {},
      clips: [
        { segmentId: "e01_s001", role: "hook" },
        { segmentId: "e01_s003", throughSegmentId: "e01_s003", role: "cliff" },
      ],
    };
    const clipsBefore = [
      { segmentId: "e01_s001", startMs: 0, endMs: 5000, text: "a" },
      { segmentId: "e01_s003", startMs: 8000, endMs: 15000, text: "走着瞧" },
    ];
    const { clips, repairs } = applyCliffClosingTrim(clipsBefore, plan, segments);
    expect(clips.at(-1)?.endMs).toBe(12000);
    expect(repairs.some((r) => r.includes("人工终点"))).toBe(true);
  });
});
