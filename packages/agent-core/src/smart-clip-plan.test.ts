import { describe, expect, it } from "vitest";
import type { AsrSegment, ClipPlan } from "@clip/sdk";
import {
  applyEditFormToPlan,
  inferDurationStatus,
  resolveTargetDurationSec,
} from "./smart-clip-plan.js";

const segments: AsrSegment[] = [
  { segmentId: "e01_s001", episodeId: "e01", startMs: 0, endMs: 5000, text: "开场" },
  { segmentId: "e01_s002", episodeId: "e01", startMs: 5000, endMs: 12000, text: "冲突" },
  { segmentId: "e01_s020", episodeId: "e01", startMs: 120000, endMs: 125000, text: "你算什么东西，给我滚出去" },
  { segmentId: "e02_s001", episodeId: "e02", startMs: 0, endMs: 5000, text: "第二集开场" },
  { segmentId: "e02_s002", episodeId: "e02", startMs: 5000, endMs: 12000, text: "第二集冲突" },
];

describe("applyEditFormToPlan", () => {
  it("keeps mid-episode burst hook when hookSegmentId points to high-conflict segment", () => {
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      hookSegmentId: "e01_s020",
      hookType: "羞辱冲突",
      clips: [
        { segmentId: "e01_s020", role: "hook", reason: "当众羞辱" },
        { segmentId: "e02_s001", role: "context" },
        { segmentId: "e02_s002", role: "cliff" },
      ],
      output: {},
    };
    const next = applyEditFormToPlan(plan, segments);
    expect(next.clips[0]?.segmentId).toBe("e01_s020");
    expect(next.clips.some((c) => c.segmentId === "e01_s001")).toBe(false);
  });

  it("does not mechanically rewrite weak opening clips (LLM retry instead)", () => {
    const labeled: AsrSegment[] = segments.map((s) =>
      s.segmentId === "e01_s020"
        ? { ...s, usableAsHook: true, highlightType: "conflict", highlightScore: 6 }
        : s,
    );
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      clips: [
        { segmentId: "e01_s001", role: "hook", reason: "弱开场" },
        { segmentId: "e02_s001", role: "escalate" },
      ],
      output: {},
    };
    const next = applyEditFormToPlan(plan, labeled);
    // 不再用 burst 窗强行换段，只建议 hookSegmentId
    expect(next.clips[0]?.segmentId).toBe("e01_s001");
    expect(next.hookSegmentId).toBe("e01_s020");
  });
});

describe("inferDurationStatus", () => {
  it("marks under preferred for short 3min plan", () => {
    expect(inferDurationStatus(120, "3min")).toBe("under_preferred");
  });

  it("resolves target seconds", () => {
    expect(resolveTargetDurationSec("10min")).toBe(600);
    expect(resolveTargetDurationSec("3min")).toBe(180);
  });

  it("marks over preferred for long 10min plan", () => {
    expect(inferDurationStatus(900, "10min")).toBe("over_preferred");
  });
});
