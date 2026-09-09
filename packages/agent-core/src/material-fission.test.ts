import { describe, expect, it } from "vitest";
import {
  buildFissionFilterGraph,
  computeKeepRanges,
  generateUniquePlans,
  generateVariantPlan,
  signatureOfOps,
} from "./material-fission.js";

describe("material-fission", () => {
  it("同一 seed 生成可复现方案", () => {
    const a = generateVariantPlan({ seed: 42, durationSec: 30 });
    const b = generateVariantPlan({ seed: 42, durationSec: 30 });
    expect(a.signature).toBe(b.signature);
    expect(a.ops).toEqual(b.ops);
  });

  it("默认每条只执行 1 种操作", () => {
    for (let i = 0; i < 20; i++) {
      const plan = generateVariantPlan({ seed: 1000 + i, durationSec: 45 });
      expect(plan.ops).toHaveLength(1);
    }
  });

  it("批量生成尽量去重", () => {
    const plans = generateUniquePlans({
      count: 30,
      baseSeed: 7,
      durationSec: 40,
    });
    expect(plans).toHaveLength(30);
    const sigs = new Set(plans.map((p) => p.signature));
    expect(sigs.size).toBeGreaterThan(20);
  });

  it("滤镜链包含所选操作", () => {
    const plan = generateVariantPlan({
      seed: 9,
      durationSec: 20,
      allowedOps: ["mirror", "color", "speed"],
      minOps: 3,
      maxOps: 3,
    });
    const kinds = new Set(plan.ops.map((o) => o.kind));
    expect(kinds.has("mirror")).toBe(true);
    expect(kinds.has("color")).toBe(true);
    expect(kinds.has("speed")).toBe(true);
    const g = buildFissionFilterGraph(plan, 20);
    expect(g.videoFilter).toContain("hflip");
    expect(g.videoFilter).toContain("eq=");
    expect(g.videoFilter).toContain("setpts=PTS/");
    expect(g.audioFilter).toContain("atempo=");
    expect(g.outputDurationSec).toBeLessThan(20);
  });

  it("掐头去尾 + 抽帧走 trim/concat", () => {
    const plan = {
      seed: 1,
      signature: "x",
      ops: [
        { kind: "trim_ends" as const, params: { headSec: 0.5, tailSec: 0.5 } },
        {
          kind: "drop_frames" as const,
          params: { windows: [{ startSec: 2, endSec: 2.3 }] },
        },
      ],
    };
    plan.signature = signatureOfOps(plan.ops);
    const g = buildFissionFilterGraph(plan, 10);
    expect(g.filterComplex).toBeTruthy();
    expect(g.filterComplex).toContain("trim=");
    expect(g.filterComplex).toContain("concat=");
    expect(g.mapVideo).toBe("[vout]");
    expect(g.mapAudio).toBe("[aout]");
  });

  it("computeKeepRanges 挖洞正确", () => {
    const ranges = computeKeepRanges(0, 10, [{ startSec: 2, endSec: 2.5 }]);
    expect(ranges).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2.5, endSec: 10 },
    ]);
  });
});
