import {
  buildAudioNormalizeFilter,
  buildGpuScaleNormalizeFilter,
  buildXfadeChain,
} from "./episode-transition.js";
import type { TrimClipSpec } from "./ffmpeg-filter-graph.js";
import type { SinglePassFilterGraph } from "./ffmpeg-filter-graph.js";

function formatSec(sec: number): string {
  return sec.toFixed(3);
}

/** hwdownload 后与 CPU buildScaleNormalizeFilter 对齐：yuv420p + sar + 30fps */
const HWDOWNLOAD_NORMALIZE = "hwdownload,format=yuv420p,setsar=1,fps=30";

function buildGpuClipFilters(clips: TrimClipSpec[], width: number, height: number): string[] {
  const scaleFilter = buildGpuScaleNormalizeFilter(width, height);
  const audioFilter = buildAudioNormalizeFilter();
  const parts: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    parts.push(`[${clip.inputIndex}:v]${scaleFilter}[v${i}n]`);
    parts.push(
      `[${clip.inputIndex}:a]atrim=0:${formatSec(clip.durationSec)},asetpts=PTS-STARTPTS,${audioFilter}[a${i}n]`,
    );
  }

  return parts;
}

/** xfade/concat 仅支持 CPU 帧；下载后与 CPU 路径一致归一化 fps/sar */
function downloadAndNormalizeCudaClips(clips: TrimClipSpec[]): string[] {
  return clips.map((_, i) => `[v${i}n]${HWDOWNLOAD_NORMALIZE}[v${i}d]`);
}

function appendOutputVideoFilter(parts: string[], videoIn: string, outputVf: string): {
  videoOut: string;
} {
  const normalized = outputVf.trim();
  if (!normalized || normalized === "null") {
    return { videoOut: videoIn };
  }
  parts.push(`[${videoIn}]${normalized}[vout]`);
  return { videoOut: "vout" };
}

function buildGpuMultiClipConcatJoin(clips: TrimClipSpec[]): {
  parts: string[];
  videoIn: string;
  audioOut: string;
} {
  const parts = downloadAndNormalizeCudaClips(clips);
  const concatIn = clips.flatMap((_, i) => [`[v${i}d]`, `[a${i}n]`]).join("");
  parts.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
  return { parts, videoIn: "vcat", audioOut: "acat" };
}

function buildGpuMultiClipXfadeJoin(input: {
  clips: TrimClipSpec[];
  transitionTypes: string[];
  transitionDurationSec: number;
}): { parts: string[]; videoIn: string; audioOut: string } {
  const { clips, transitionTypes, transitionDurationSec } = input;
  const parts = downloadAndNormalizeCudaClips(clips);
  const chain = buildXfadeChain({
    clipCount: clips.length,
    durationsSec: clips.map((c) => c.durationSec),
    transitionTypes,
    transitionDurationSec,
    videoLabelSuffix: "d",
  });
  parts.push(...chain.parts);
  return { parts, videoIn: chain.videoOut, audioOut: chain.audioOut };
}

function buildSingleClipGpuGraph(input: {
  clips: TrimClipSpec[];
  workingWidth: number;
  workingHeight: number;
  outputVf: string;
}): SinglePassFilterGraph {
  const { clips, workingWidth, workingHeight, outputVf } = input;
  const parts = buildGpuClipFilters(clips, workingWidth, workingHeight);
  parts.push(`[v0n]${HWDOWNLOAD_NORMALIZE}[v0d]`);
  const { videoOut } = appendOutputVideoFilter(parts, "v0d", outputVf);
  return {
    filterComplex: parts.join(";"),
    videoOut,
    audioOut: "a0n",
  };
}

/** GPU 单 pass：NVDEC + scale_cuda → CPU concat/xfade（fps=30）→ CPU 成片 vf → NVENC */
export function buildSinglePassGpuConcatGraph(input: {
  clips: TrimClipSpec[];
  workingWidth: number;
  workingHeight: number;
  outputVf: string;
}): SinglePassFilterGraph {
  const { clips, workingWidth, workingHeight, outputVf } = input;
  if (clips.length === 0) {
    throw new Error("concat 至少 1 段");
  }
  if (clips.length === 1) {
    return buildSingleClipGpuGraph(input);
  }

  const parts = buildGpuClipFilters(clips, workingWidth, workingHeight);
  const join = buildGpuMultiClipConcatJoin(clips);
  parts.push(...join.parts);
  const { videoOut } = appendOutputVideoFilter(parts, join.videoIn, outputVf);
  return {
    filterComplex: parts.join(";"),
    videoOut,
    audioOut: join.audioOut,
  };
}

/** GPU 单 pass：NVDEC + scale_cuda → CPU xfade（fps=30）→ CPU 成片 vf → NVENC */
export function buildSinglePassGpuXfadeGraph(input: {
  clips: TrimClipSpec[];
  workingWidth: number;
  workingHeight: number;
  outputVf: string;
  transitionTypes: string[];
  transitionDurationSec: number;
}): SinglePassFilterGraph {
  const { clips, workingWidth, workingHeight, outputVf, transitionTypes, transitionDurationSec } =
    input;
  if (clips.length === 1) {
    return buildSingleClipGpuGraph(input);
  }

  const parts = buildGpuClipFilters(clips, workingWidth, workingHeight);
  const join = buildGpuMultiClipXfadeJoin({
    clips,
    transitionTypes,
    transitionDurationSec,
  });
  parts.push(...join.parts);
  const { videoOut } = appendOutputVideoFilter(parts, join.videoIn, outputVf);
  return {
    filterComplex: parts.join(";"),
    videoOut,
    audioOut: join.audioOut,
    transitionTypes,
    transitionDurationSec,
  };
}
