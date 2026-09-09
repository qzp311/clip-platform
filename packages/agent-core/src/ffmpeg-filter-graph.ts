import {
  buildAudioNormalizeFilter,
  buildScaleNormalizeFilter,
  buildXfadeChain,
} from "./episode-transition.js";

export interface TrimClipSpec {
  /** -i 输入序号（同源可复用同一 index） */
  inputIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface SinglePassFilterGraph {
  filterComplex: string;
  videoOut: string;
  audioOut: string;
  transitionTypes?: string[];
  transitionDurationSec?: number;
}

function formatSec(sec: number): string {
  return sec.toFixed(3);
}

/** 从源文件 trim + 归一化尺寸，产出 v{i}n / a{i}n */
export function buildTrimClipFilters(
  clips: TrimClipSpec[],
  width: number,
  height: number,
): string[] {
  const scaleFilter = buildScaleNormalizeFilter(width, height);
  const audioFilter = buildAudioNormalizeFilter();
  const parts: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const start = formatSec(clip.startSec);
    const end = formatSec(clip.endSec);
    parts.push(
      `[${clip.inputIndex}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,${scaleFilter}[v${i}n]`,
    );
    parts.push(
      `[${clip.inputIndex}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${audioFilter}[a${i}n]`,
    );
  }

  return parts;
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

/** 单 pass：trim → concat → 成片 vf */
export function buildSinglePassConcatGraph(input: {
  clips: TrimClipSpec[];
  workingWidth: number;
  workingHeight: number;
  outputVf: string;
}): SinglePassFilterGraph {
  const { clips, workingWidth, workingHeight, outputVf } = input;
  if (clips.length === 0) {
    throw new Error("concat 至少 1 段");
  }

  const parts = buildTrimClipFilters(clips, workingWidth, workingHeight);

  if (clips.length === 1) {
    const { videoOut } = appendOutputVideoFilter(parts, "v0n", outputVf);
    return {
      filterComplex: parts.join(";"),
      videoOut,
      audioOut: "a0n",
    };
  }

  const concatIn = clips.flatMap((_, i) => [`[v${i}n]`, `[a${i}n]`]).join("");
  parts.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
  const { videoOut } = appendOutputVideoFilter(parts, "vcat", outputVf);
  return {
    filterComplex: parts.join(";"),
    videoOut,
    audioOut: "acat",
  };
}

/** 单 pass：trim → xfade → 成片 vf */
export function buildSinglePassXfadeGraph(input: {
  clips: TrimClipSpec[];
  workingWidth: number;
  workingHeight: number;
  outputVf: string;
  transitionTypes: string[];
  transitionDurationSec: number;
}): SinglePassFilterGraph {
  const { clips, workingWidth, workingHeight, outputVf, transitionTypes, transitionDurationSec } =
    input;
  const parts = buildTrimClipFilters(clips, workingWidth, workingHeight);
  const chain = buildXfadeChain({
    clipCount: clips.length,
    durationsSec: clips.map((c) => c.durationSec),
    transitionTypes,
    transitionDurationSec,
  });
  parts.push(...chain.parts);
  const { videoOut } = appendOutputVideoFilter(parts, chain.videoOut, outputVf);
  return {
    filterComplex: parts.join(";"),
    videoOut,
    audioOut: chain.audioOut,
    transitionTypes,
    transitionDurationSec,
  };
}
