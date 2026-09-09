import { describe, expect, it } from "vitest";
import {
  buildSinglePassGpuConcatGraph,
  buildSinglePassGpuXfadeGraph,
} from "./ffmpeg-filter-graph-gpu.js";
import { buildGpuClipInputArgs, buildGpuGlobalArgs } from "./ffmpeg-gpu.js";

describe("ffmpeg-filter-graph-gpu", () => {
  const clips = [
    { inputIndex: 0, startSec: 1.5, endSec: 60, durationSec: 58.5 },
    { inputIndex: 1, startSec: 0.28, endSec: 142.765, durationSec: 142.485 },
  ];

  it("builds GPU global hw init args without opencl", () => {
    expect(buildGpuGlobalArgs()).toEqual([
      "-init_hw_device",
      "cuda=cuda:0",
      "-filter_hw_device",
      "cuda",
    ]);
    expect(buildGpuGlobalArgs().join(" ")).not.toContain("opencl");
  });

  it("builds per-clip cuda inputs with seek", () => {
    const args = buildGpuClipInputArgs("ep01.mp4", 1.5, 60);
    expect(args).toContain("-hwaccel");
    expect(args).toContain("cuda");
    expect(args).toContain("-ss");
    expect(args).toContain("1.500");
    expect(args).toContain("-i");
    expect(args).toContain("ep01.mp4");
  });

  it("uses scale_cuda and cpu concat via hwdownload with fps normalization", () => {
    const graph = buildSinglePassGpuConcatGraph({
      clips,
      workingWidth: 1080,
      workingHeight: 1920,
      outputVf: "scale=1080:1920:force_original_aspect_ratio=decrease",
    });
    expect(graph.filterComplex).toContain("scale_cuda=1080:1920");
    expect(graph.filterComplex).toContain("pad_cuda=1080:1920");
    expect(graph.filterComplex).toContain("hwdownload,format=yuv420p,setsar=1,fps=30[v0d]");
    expect(graph.filterComplex).toContain("atrim=0:");
    expect(graph.filterComplex).toContain("concat=n=2:v=1:a=1[vcat][acat]");
    expect(graph.filterComplex).not.toContain("hwupload_cuda");
    expect(graph.filterComplex).not.toContain("opencl");
    expect(graph.filterComplex).not.toContain("[0:v]trim=");
  });

  it("builds GPU xfade graph with hwdownload and cpu xfade", () => {
    const graph = buildSinglePassGpuXfadeGraph({
      clips,
      workingWidth: 1080,
      workingHeight: 1920,
      outputVf: "null",
      transitionTypes: ["dissolve"],
      transitionDurationSec: 0.5,
    });
    expect(graph.filterComplex).toContain("xfade=transition=dissolve");
    expect(graph.filterComplex).toContain("[v0d][v1d]");
    expect(graph.filterComplex).toContain("hwdownload,format=yuv420p,setsar=1,fps=30");
    expect(graph.filterComplex).not.toContain("hwupload_cuda");
    expect(graph.videoOut).toBe("vx1");
    expect(graph.audioOut).toBe("ax1");
  });
});
