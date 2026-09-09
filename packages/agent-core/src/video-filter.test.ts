import { describe, expect, it } from "vitest";
import { buildVideoFilter, resolveOutputVideoSpec } from "../src/video-filter.js";
import type { ClipPlan } from "@clip/sdk";

describe("resolveOutputVideoSpec", () => {
  const plan: ClipPlan = {
    version: "2.0",
    clips: [],
    output: { ratio: "auto" },
  };

  it("uses 16:9 for landscape source", () => {
    const spec = resolveOutputVideoSpec(plan, { encode: { codec: "libx264" } }, { width: 1920, height: 1080 });
    expect(spec.ratio).toBe("16:9");
    expect(spec.width).toBeGreaterThan(spec.height);
  });

  it("overrides stale 9:16 config when source is landscape", () => {
    const spec = resolveOutputVideoSpec(
      { ...plan, output: { ratio: "9:16" } },
      { encode: { codec: "libx264" }, video: { ratio: "9:16", width: 1080, height: 1920 } },
      { width: 1280, height: 720 },
    );
    expect(spec.ratio).toBe("16:9");
  });
});

describe("buildVideoFilter", () => {
  it("does not center-crop landscape source for landscape output", () => {
    const vf = buildVideoFilter(
      { width: 1920, height: 1080, ratio: "16:9", cropMode: "center" },
      { width: 1920, height: 1080 },
    );
    expect(vf).toContain("force_original_aspect_ratio=decrease");
    expect(vf).not.toContain("crop=ih*");
  });
});
