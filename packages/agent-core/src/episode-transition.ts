import type { RenderTransitionConfig } from "@clip/sdk";

/** 适合混剪的 ffmpeg xfade 转场（排除过于花哨/易失败的） */
export const TRANSITION_POOL = [
  "fade",
  "dissolve",
  "fadeblack",
  "smoothleft",
  "smoothright",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "circleopen",
  "circleclose",
  "coverleft",
  "coverright",
] as const;

export type TransitionPoolType = (typeof TRANSITION_POOL)[number];

export const DEFAULT_TRANSITION: Required<Omit<RenderTransitionConfig, "type">> & {
  type: "random";
} = {
  enabled: true,
  type: "random",
  durationSec: 0.5,
};

export interface ClipEpisodeMeta {
  episodeId?: string;
  segmentId: string;
}

export interface XfadeFilterGraph {
  filterComplex: string;
  videoOut: string;
  audioOut: string;
  transitionDurationSec: number;
  /** 各跨集切点实际使用的转场名 */
  transitionTypes: string[];
}

export function resolveTransitionConfig(
  config?: RenderTransitionConfig,
): Required<RenderTransitionConfig> {
  return {
    enabled: config?.enabled ?? DEFAULT_TRANSITION.enabled,
    type: config?.type ?? DEFAULT_TRANSITION.type,
    durationSec: config?.durationSec ?? DEFAULT_TRANSITION.durationSec,
  };
}

/** 从池中随机抽取 N 个转场（每个跨集切点独立随机） */
export function pickRandomTransitionTypes(
  count: number,
  pool: readonly string[] = TRANSITION_POOL,
  random = Math.random,
): string[] {
  if (count <= 0) return [];
  if (pool.length === 0) throw new Error("转场池为空");
  return Array.from({ length: count }, () => pool[Math.floor(random() * pool.length)]!);
}

/**
 * 解析本次渲染各跨集切点使用的转场。
 * type 为 random 或未指定时从池中随机；否则全部切点使用固定 type。
 */
export function resolveTransitionTypesForRender(
  boundaryCount: number,
  config?: RenderTransitionConfig,
  random = Math.random,
): string[] {
  if (boundaryCount <= 0) return [];
  const type = config?.type ?? DEFAULT_TRANSITION.type;
  if (type === "random") {
    return pickRandomTransitionTypes(boundaryCount, TRANSITION_POOL, random);
  }
  return Array.from({ length: boundaryCount }, () => type);
}

export function clipEpisodeKey(clip: ClipEpisodeMeta): string {
  return (
    clip.episodeId ??
    clip.segmentId.replace(/_s\d+$/i, "") ??
    clip.segmentId
  );
}

/** 相邻切条是否跨集（需加转场） */
export function hasCrossEpisodeBoundary(clips: ClipEpisodeMeta[]): boolean {
  if (clips.length <= 1) return false;
  for (let i = 1; i < clips.length; i++) {
    if (clipEpisodeKey(clips[i - 1]!) !== clipEpisodeKey(clips[i]!)) {
      return true;
    }
  }
  return false;
}

/** 根据各段时长限制转场，避免短片段 xfade 失败 */
export function resolveTransitionDurationSec(
  durationsSec: number[],
  config?: RenderTransitionConfig,
): number | null {
  if (durationsSec.length < 2) return null;

  const requested = resolveTransitionConfig(config).durationSec;
  const minClip = Math.min(...durationsSec);
  if (minClip < 0.35) return null;

  const capped = Math.min(requested, minClip * 0.35, 1.2);
  const resolved = Math.max(0.25, capped);
  if (resolved >= minClip * 0.45) return null;
  return Number(resolved.toFixed(3));
}

export function buildScaleNormalizeFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;
}

/** GPU 归一化：scale_cuda + pad_cuda（需 FFmpeg 8+ 与 bundled win64 build） */
export function buildGpuScaleNormalizeFilter(width: number, height: number): string {
  return `scale_cuda=${width}:${height}:force_original_aspect_ratio=decrease:interp_algo=bilinear,pad_cuda=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** xfade_opencl 支持的转场名；其余从池中映射为 fade */
const OPENCL_TRANSITIONS = new Set([
  "fade",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "smoothleft",
  "smoothright",
  "circleopen",
  "circleclose",
  "rectcrop",
  "distance",
  "fadeblack",
  "fadewhite",
]);

export function mapTransitionToOpenCl(type: string): string {
  if (OPENCL_TRANSITIONS.has(type)) return type;
  if (type === "dissolve") return "fade";
  if (type === "coverleft") return "slideleft";
  if (type === "coverright") return "slideright";
  return "fade";
}

export function buildAudioNormalizeFilter(): string {
  return "aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=none";
}

export interface XfadeChainResult {
  parts: string[];
  videoOut: string;
  audioOut: string;
}

/** 已归一化的 v{i}n / a{i}n 标签链式 xfade */
export function buildXfadeChain(input: {
  clipCount: number;
  durationsSec: number[];
  transitionTypes: string[];
  transitionDurationSec: number;
  /** 视频垫标签后缀，默认 n；GPU 管线 hwdownload 后用 d */
  videoLabelSuffix?: string;
}): XfadeChainResult {
  const { clipCount, durationsSec, transitionTypes, transitionDurationSec } = input;
  const videoSuffix = input.videoLabelSuffix ?? "n";
  if (clipCount < 2 || durationsSec.length !== clipCount) {
    throw new Error("xfade 至少需要 2 段且 durations 与 clip 数一致");
  }
  if (transitionTypes.length !== clipCount - 1) {
    throw new Error("transitionTypes 数量须为 clipCount - 1");
  }

  const parts: string[] = [];
  let videoIn = `v0${videoSuffix}`;
  let audioIn = "a0n";
  let cumulativeDuration = durationsSec[0]!;

  for (let i = 1; i < clipCount; i++) {
    const transitionType = transitionTypes[i - 1]!;
    const offset = cumulativeDuration - transitionDurationSec;
    const videoOut = `vx${i}`;
    const audioOut = `ax${i}`;
    parts.push(
      `[${videoIn}][v${i}${videoSuffix}]xfade=transition=${transitionType}:duration=${transitionDurationSec.toFixed(3)}:offset=${offset.toFixed(3)}[${videoOut}]`,
    );
    parts.push(
      `[${audioIn}][a${i}n]acrossfade=d=${transitionDurationSec.toFixed(3)}[${audioOut}]`,
    );
    videoIn = videoOut;
    audioIn = audioOut;
    cumulativeDuration += durationsSec[i]! - transitionDurationSec;
  }

  return { parts, videoOut: videoIn, audioOut: audioIn };
}

/** OpenCL 硬件帧标签链式 xfade_opencl（调用方需先 hwmap 到 opencl） */
export function buildOpenClXfadeChain(input: {
  clipCount: number;
  durationsSec: number[];
  transitionTypes: string[];
  transitionDurationSec: number;
  videoLabelSuffix?: string;
}): XfadeChainResult {
  const {
    clipCount,
    durationsSec,
    transitionTypes,
    transitionDurationSec,
    videoLabelSuffix = "ocl",
  } = input;
  if (clipCount < 2 || durationsSec.length !== clipCount) {
    throw new Error("xfade_opencl 至少需要 2 段且 durations 与 clip 数一致");
  }
  if (transitionTypes.length !== clipCount - 1) {
    throw new Error("transitionTypes 数量须为 clipCount - 1");
  }

  const parts: string[] = [];
  let videoIn = `v0${videoLabelSuffix}`;
  let audioIn = "a0n";
  let cumulativeDuration = durationsSec[0]!;

  for (let i = 1; i < clipCount; i++) {
    const transitionType = mapTransitionToOpenCl(transitionTypes[i - 1]!);
    const offset = cumulativeDuration - transitionDurationSec;
    const videoOut = `vx${i}${videoLabelSuffix}`;
    const audioOut = `ax${i}`;
    parts.push(
      `[${videoIn}][v${i}${videoLabelSuffix}]xfade_opencl=transition=${transitionType}:duration=${transitionDurationSec.toFixed(3)}:offset=${offset.toFixed(3)}[${videoOut}]`,
    );
    parts.push(
      `[${audioIn}][a${i}n]acrossfade=d=${transitionDurationSec.toFixed(3)}[${audioOut}]`,
    );
    videoIn = videoOut;
    audioIn = audioOut;
    cumulativeDuration += durationsSec[i]! - transitionDurationSec;
  }

  return { parts, videoOut: videoIn, audioOut: audioIn };
}

/**
 * 构建 ffmpeg filter_complex：多段 clip 按顺序 xfade + acrossfade 拼接。
 * 调用方需按 clip 顺序传入 -i clip_0 -i clip_1 ...
 */
export function buildCrossEpisodeXfadeFilterGraph(input: {
  clipCount: number;
  durationsSec: number[];
  /** 长度 clipCount-1，每个跨集切点一种转场 */
  transitionTypes: string[];
  transitionDurationSec: number;
  width: number;
  height: number;
}): XfadeFilterGraph {
  const { clipCount, durationsSec, transitionTypes, transitionDurationSec, width, height } = input;

  const scaleFilter = buildScaleNormalizeFilter(width, height);
  const audioFilter = buildAudioNormalizeFilter();
  const parts: string[] = [];

  for (let i = 0; i < clipCount; i++) {
    parts.push(`[${i}:v]${scaleFilter}[v${i}n]`);
    parts.push(`[${i}:a]${audioFilter}[a${i}n]`);
  }

  const chain = buildXfadeChain({
    clipCount,
    durationsSec,
    transitionTypes,
    transitionDurationSec,
  });
  parts.push(...chain.parts);

  return {
    filterComplex: parts.join(";"),
    videoOut: chain.videoOut,
    audioOut: chain.audioOut,
    transitionDurationSec,
    transitionTypes,
  };
}
