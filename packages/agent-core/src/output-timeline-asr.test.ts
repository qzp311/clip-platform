import { describe, it, expect } from "vitest";
import type { AsrSegment, ClipPlan } from "@clip/sdk";
import { remapPlanAsrToOutputTimeline } from "./output-timeline-asr.js";

function seg(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  extra: Partial<AsrSegment> = {},
): AsrSegment {
  return { segmentId: id, startMs, endMs, text, ...extra };
}

describe("remapPlanAsrToOutputTimeline", () => {
  it("maps ASR sentences onto continuous output timeline across two knives", () => {
    const segments: AsrSegment[] = [
      seg("e01_s001", 0, 2000, "开场", { episodeId: "e01", episodeNo: 1, highlightType: "hook", usableAsHook: true }),
      seg("e01_s002", 2000, 5000, "冲突", { episodeId: "e01", episodeNo: 1, highlightType: "conflict" }),
      seg("e02_s001", 0, 3000, "反转", { episodeId: "e02", episodeNo: 2, highlightType: "twist" }),
      seg("e02_s002", 3000, 6000, "悬念", { episodeId: "e02", episodeNo: 2 }),
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s001", throughSegmentId: "e01_s002", role: "hook" },
        { segmentId: "e02_s001", throughSegmentId: "e02_s002", role: "cliff" },
      ],
      output: { maxDurationSec: 60 },
    };

    const result = remapPlanAsrToOutputTimeline(plan, segments, { disableHookOpeningTrim: true });
    expect(result.knives.length).toBeGreaterThanOrEqual(1);
    expect(result.segments.length).toBeGreaterThanOrEqual(3);

    // 第一刀 0..5000 → 成片 0..5000；第二刀接在后面
    const first = result.segments.find((s) => s.segmentId === "e01_s001");
    const second = result.segments.find((s) => s.segmentId === "e01_s002");
    const third = result.segments.find((s) => s.segmentId === "e02_s001");
    expect(first?.startMs).toBe(0);
    expect(first?.endMs).toBe(2000);
    expect(first?.highlightType).toBe("hook");
    expect(first?.usableAsHook).toBe(true);
    expect(second?.startMs).toBe(2000);
    expect(second?.endMs).toBe(5000);
    expect(second?.highlightType).toBe("conflict");
    expect(third?.startMs).toBe(5000);
    expect(third?.endMs).toBe(8000);
    expect(third?.highlightType).toBe("twist");

    expect(result.highlights.some((h) => h.segmentId === "e01_s001")).toBe(true);
    expect(result.highlights.some((h) => h.segmentId === "e01_s002")).toBe(true);
    expect(result.highlights.some((h) => h.segmentId === "e02_s001")).toBe(true);
    // 无高光的 e02_s002 不应进 highlights
    expect(result.highlights.some((h) => h.segmentId === "e02_s002")).toBe(false);
  });

  it("clips overlapping sentences to knife bounds on output axis", () => {
    const segments: AsrSegment[] = [
      seg("e01_s010", 8000, 15000, "长句跨刀外", { episodeId: "e01" }),
    ];
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e01_s010", role: "escalate" }],
      output: {},
    };
    // prepareRenderClips 会按段时间切；这里直接验证映射结果非空且在成片轴从 0 起
    const result = remapPlanAsrToOutputTimeline(plan, segments, { disableHookOpeningTrim: true });
    expect(result.segments.length).toBe(1);
    expect(result.segments[0]!.startMs).toBe(0);
    expect(result.segments[0]!.endMs).toBe(7000);
    expect(result.segments[0]!.sourceStartMs).toBe(8000);
    expect(result.segments[0]!.sourceEndMs).toBe(15000);
  });
});
