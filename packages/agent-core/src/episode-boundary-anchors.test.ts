import { describe, expect, it } from "vitest";
import type { AsrSegment, ClipPlan } from "@clip/sdk";
import {
  buildEpisodeClosingWindow,
  buildEpisodeOpeningWindow,
  enforceEpisodeBoundaryAnchors,
  extendClosingBlockToEpisodeEnd,
  isAtEpisodeEnd,
  isNearEpisodeEnd,
  isNearEpisodeStart,
} from "./episode-boundary-anchors.js";
import { buildCrossEpisodeMixWindow } from "./clip-plan-coherence.js";

function makeEpisode(ep: string, no: number, count: number): AsrSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    segmentId: `${ep}_s${String(i + 1).padStart(3, "0")}`,
    episodeId: ep,
    episodeNo: no,
    startMs: i * 4000,
    endMs: (i + 1) * 4000,
    text: `${ep} line ${i + 1}`,
  }));
}

describe("episode boundary windows", () => {
  const e03 = makeEpisode("e03", 3, 12);
  const e07 = makeEpisode("e07", 7, 15);

  it("buildEpisodeOpeningWindow starts from first segment", () => {
    const win = buildEpisodeOpeningWindow(e03, { maxDurationSec: 30, minClips: 1 });
    expect(win?.clips[0]?.segmentId).toBe("e03_s001");
  });

  it("buildEpisodeClosingWindow ends at last segment", () => {
    const win = buildEpisodeClosingWindow(e07, { maxDurationSec: 30, minClips: 1 });
    expect(win?.clips.at(-1)?.segmentId).toBe("e07_s015");
  });

  it("buildCrossEpisodeMixWindow uses episode start and end", () => {
    const mix = buildCrossEpisodeMixWindow([...e03, ...e07], {
      hookEpisodeId: "e03",
      cliffEpisodeId: "e07",
      maxDurationSec: 120,
      maxClipCount: 20,
    });
    expect(mix).not.toBeNull();
    expect(mix!.clips[0]?.segmentId).toBe("e03_s001");
    expect(mix!.clips.at(-1)?.segmentId).toBe("e07_s015");
  });
});

describe("enforceEpisodeBoundaryAnchors", () => {
  const segments = [...makeEpisode("e02", 2, 10), ...makeEpisode("e05", 5, 12)];

  it("anchors first block to episode start and last block to episode end", () => {
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationSec: 120,
      clips: [
        { segmentId: "e02_s005", role: "hook" },
        { segmentId: "e02_s006", role: "escalate" },
        { segmentId: "e05_s004", role: "escalate" },
        { segmentId: "e05_s005", role: "cliff" },
      ],
      output: { maxDurationSec: 600 },
    };

    expect(isNearEpisodeStart(plan.clips.slice(0, 2), segments.filter((s) => s.episodeId === "e02"))).toBe(
      false,
    );

    const { plan: fixed, repairs } = enforceEpisodeBoundaryAnchors(plan, segments);
    expect(repairs.some((r) => r.includes("片头锚定"))).toBe(true);
    expect(repairs.some((r) => r.includes("片尾锚定"))).toBe(true);
    expect(fixed.clips[0]?.segmentId).toBe("e02_s001");
    expect(fixed.clips.at(-1)?.segmentId).toBe("e05_s012");
  });

  it("is idempotent when already anchored", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e02_s001", role: "hook" },
        { segmentId: "e02_s002", role: "escalate" },
        { segmentId: "e05_s011", role: "escalate" },
        { segmentId: "e05_s012", role: "cliff" },
      ],
      output: {},
    };
    const first = enforceEpisodeBoundaryAnchors(plan, segments);
    const second = enforceEpisodeBoundaryAnchors(first.plan, segments);
    expect(second.repairs).toHaveLength(0);
    expect(second.plan.clips.map((c) => c.segmentId)).toEqual(first.plan.clips.map((c) => c.segmentId));
  });
});

describe("isNearEpisodeStart / isNearEpisodeEnd", () => {
  const list = makeEpisode("e01", 1, 20);

  it("detects start proximity", () => {
    expect(isNearEpisodeStart([{ segmentId: "e01_s001" }], list)).toBe(true);
    expect(isNearEpisodeStart([{ segmentId: "e01_s010" }], list)).toBe(false);
  });

  it("detects end proximity", () => {
    expect(isNearEpisodeEnd([{ segmentId: "e01_s020" }], list)).toBe(true);
    expect(isNearEpisodeEnd([{ segmentId: "e01_s010" }], list)).toBe(false);
  });
});

describe("extendClosingBlockToEpisodeEnd", () => {
  const segments = [...makeEpisode("e02", 2, 10), ...makeEpisode("e08", 8, 16)];

  it("extends last clip through to episode last segment without replacing block start", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e02_s001", role: "hook" },
        { segmentId: "e08_s012", role: "escalate" },
        { segmentId: "e08_s014", role: "cliff" },
      ],
      output: {},
    };
    const { plan: fixed, repairs } = extendClosingBlockToEpisodeEnd(plan, segments);
    expect(repairs.some((r) => r.includes("片尾微延") || r.includes("片尾延伸"))).toBe(true);
    expect(fixed.clips[0]?.segmentId).toBe("e02_s001");
    expect(fixed.clips.at(-1)?.segmentId).toBe("e08_s014");
    expect(fixed.clips.at(-1)?.throughSegmentId).toBe("e08_s016");
    expect(fixed.clips.at(-1)?.role).toBe("cliff");
  });

  it("skips blind extend when closing is far from episode end", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e02_s001", role: "hook" },
        { segmentId: "e08_s003", role: "cliff" },
      ],
      output: {},
    };
    const { plan: fixed, repairs } = extendClosingBlockToEpisodeEnd(plan, segments);
    expect(repairs.some((r) => r.includes("跳过盲补"))).toBe(true);
    expect(fixed.clips.at(-1)?.segmentId).toBe("e08_s003");
    expect(fixed.clips.at(-1)?.throughSegmentId).toBeUndefined();
  });

  it("is no-op when through already at episode end", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e08_s010", throughSegmentId: "e08_s016", role: "cliff" }],
      output: {},
    };
    const { plan: fixed, repairs } = extendClosingBlockToEpisodeEnd(plan, segments);
    expect(repairs).toHaveLength(0);
    expect(fixed.clips.map((c) => c.segmentId)).toEqual(["e08_s010"]);
    expect(fixed.clips[0]?.throughSegmentId).toBe("e08_s016");
  });

  it("is no-op when already at episode end", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [{ segmentId: "e08_s016", role: "cliff" }],
      output: {},
    };
    const { plan: fixed, repairs } = extendClosingBlockToEpisodeEnd(plan, segments);
    expect(repairs).toHaveLength(0);
    expect(fixed.clips.map((c) => c.segmentId)).toEqual(["e08_s016"]);
  });
});

describe("isAtEpisodeEnd", () => {
  const list = makeEpisode("e08", 8, 16);

  it("requires exact last segment (segmentId or through)", () => {
    expect(isAtEpisodeEnd([{ segmentId: "e08_s016" }], list)).toBe(true);
    expect(isAtEpisodeEnd([{ segmentId: "e08_s010", throughSegmentId: "e08_s016" }], list)).toBe(
      true,
    );
    expect(isAtEpisodeEnd([{ segmentId: "e08_s014" }], list)).toBe(false);
  });
});
