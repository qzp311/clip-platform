import { describe, expect, it } from "vitest";
import {
  buildCrossEpisodeXfadeFilterGraph,
  hasCrossEpisodeBoundary,
  pickRandomTransitionTypes,
  resolveTransitionDurationSec,
  resolveTransitionTypesForRender,
  TRANSITION_POOL,
} from "./episode-transition.js";

describe("episode-transition", () => {
  it("detects cross-episode boundaries", () => {
    expect(
      hasCrossEpisodeBoundary([
        { segmentId: "e01_s001", episodeId: "e01" },
        { segmentId: "e02_s003", episodeId: "e02" },
      ]),
    ).toBe(true);
    expect(
      hasCrossEpisodeBoundary([{ segmentId: "e01_s001", episodeId: "e01" }]),
    ).toBe(false);
  });

  it("caps transition duration for short clips", () => {
    expect(resolveTransitionDurationSec([2, 3], { durationSec: 0.5 })).toBe(0.5);
    expect(resolveTransitionDurationSec([0.2, 3], { durationSec: 0.5 })).toBeNull();
  });

  it("picks random types from pool per boundary", () => {
    let i = 0;
    const types = pickRandomTransitionTypes(3, TRANSITION_POOL, () => {
      i += 1;
      return (i % TRANSITION_POOL.length) / TRANSITION_POOL.length;
    });
    expect(types).toHaveLength(3);
    expect(types.every((t) => TRANSITION_POOL.includes(t as (typeof TRANSITION_POOL)[number]))).toBe(true);
  });

  it("uses fixed type when configured", () => {
    expect(resolveTransitionTypesForRender(2, { type: "wipeleft" })).toEqual([
      "wipeleft",
      "wipeleft",
    ]);
  });

  it("randomizes when type is random", () => {
    const types = resolveTransitionTypesForRender(2, { type: "random" }, () => 0.99);
    expect(types).toHaveLength(2);
    expect(types[0]).toBe(TRANSITION_POOL.at(-1));
  });

  it("builds chained xfade with per-boundary types", () => {
    const graph = buildCrossEpisodeXfadeFilterGraph({
      clipCount: 3,
      durationsSec: [10, 8, 12],
      transitionTypes: ["fade", "wipeleft"],
      transitionDurationSec: 0.5,
      width: 1920,
      height: 1080,
    });
    expect(graph.filterComplex).toContain("xfade=transition=fade:duration=0.500:offset=9.500");
    expect(graph.filterComplex).toContain("xfade=transition=wipeleft:duration=0.500:offset=17.000");
    expect(graph.transitionTypes).toEqual(["fade", "wipeleft"]);
    expect(graph.videoOut).toBe("vx2");
    expect(graph.audioOut).toBe("ax2");
  });
});
