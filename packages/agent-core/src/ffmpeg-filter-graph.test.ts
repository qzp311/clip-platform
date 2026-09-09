import { describe, expect, it } from "vitest";
import {
  buildSinglePassConcatGraph,
  buildSinglePassXfadeGraph,
  buildTrimClipFilters,
} from "./ffmpeg-filter-graph.js";

describe("ffmpeg-filter-graph", () => {
  const clips = [
    { inputIndex: 0, startSec: 1.5, endSec: 60, durationSec: 58.5 },
    { inputIndex: 1, startSec: 0.28, endSec: 142.765, durationSec: 142.485 },
  ];

  it("builds trim filters from source inputs", () => {
    const parts = buildTrimClipFilters(clips, 1080, 1920);
    expect(parts[0]).toContain("[0:v]trim=start=1.500:end=60.000");
    expect(parts[1]).toContain("[0:a]atrim=start=1.500:end=60.000");
    expect(parts[2]).toContain("[1:v]trim=start=0.280:end=142.765");
  });

  it("builds single-pass concat graph with output vf", () => {
    const graph = buildSinglePassConcatGraph({
      clips,
      workingWidth: 1080,
      workingHeight: 1920,
      outputVf: "scale=1080:1920",
    });
    expect(graph.filterComplex).toContain("concat=n=2:v=1:a=1[vcat][acat]");
    expect(graph.filterComplex).toContain("[vcat]scale=1080:1920[vout]");
    expect(graph.videoOut).toBe("vout");
    expect(graph.audioOut).toBe("acat");
  });

  it("builds single-pass xfade graph without intermediate files", () => {
    const graph = buildSinglePassXfadeGraph({
      clips,
      workingWidth: 1080,
      workingHeight: 1920,
      outputVf: "scale=1080:1920",
      transitionTypes: ["fade"],
      transitionDurationSec: 0.5,
    });
    expect(graph.filterComplex).toContain("trim=start=");
    expect(graph.filterComplex).toContain("xfade=transition=fade");
    expect(graph.filterComplex).toContain("[vx1]scale=1080:1920[vout]");
    expect(graph.videoOut).toBe("vout");
    expect(graph.audioOut).toBe("ax1");
  });

  it("supports same source index for multiple trims", () => {
    const sameSource = [
      { inputIndex: 0, startSec: 0, endSec: 10, durationSec: 10 },
      { inputIndex: 0, startSec: 20, endSec: 30, durationSec: 10 },
    ];
    const graph = buildSinglePassConcatGraph({
      clips: sameSource,
      workingWidth: 1080,
      workingHeight: 1920,
      outputVf: "null",
    });
    expect(graph.filterComplex.match(/\[0:v\]trim/g)?.length).toBe(2);
    expect(graph.videoOut).toBe("vcat");
  });
});
