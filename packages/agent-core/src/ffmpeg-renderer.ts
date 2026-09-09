import { spawn } from "node:child_process";
import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClipPlan, AsrSegment, EffectiveConfig } from "@clip/sdk";
import { prepareRenderClips, type PrepareRenderClipsOptions } from "./rule-engine.js";
import { buildVideoFilter, resolveOutputVideoSpec } from "./video-filter.js";
import {
  hasCrossEpisodeBoundary,
  resolveTransitionConfig,
  resolveTransitionDurationSec,
  resolveTransitionTypesForRender,
} from "./episode-transition.js";
import { appendVideoEncodeArgs, resolveVideoCodec, shouldUseGpuVideoPipeline } from "./ffmpeg-encode.js";
import {
  buildSinglePassConcatGraph,
  buildSinglePassXfadeGraph,
  type TrimClipSpec,
} from "./ffmpeg-filter-graph.js";
import {
  buildSinglePassGpuConcatGraph,
  buildSinglePassGpuXfadeGraph,
} from "./ffmpeg-filter-graph-gpu.js";
import {
  buildGpuClipInputArgs,
  buildGpuGlobalArgs,
  disableGpuPipelineForSession,
  shouldAttemptGpuPipeline,
} from "./ffmpeg-gpu.js";
import { disableNvencForSession, isNvencRenderAvailable } from "./ffmpeg-capability.js";
import {
  buildRenderEnhancements,
  pickRandomBgmTrack,
  type EnhancementResult,
} from "./render-enhancements.js";
import { loadStickerRegistry, type StickerRegistry } from "./sticker-registry.js";
import { buildStickerOverlayFilter, type StickerRenderInput } from "./sticker-overlay.js";
import { loadFontRegistry, type FontRegistry } from "./font-registry.js";
import { writeFile } from "node:fs/promises";

export interface FfmpegRunnerOptions {
  ffmpegPath: string;
  ffprobePath?: string;
  workDir: string;
  /** 字体文件目录；传入后渲染时使用白名单字体，未命中自动回退默认字体 */
  fontsDir?: string;
  /** 贴花模板目录；传入后渲染时按标签/场景自动匹配模板 */
  stickersDir?: string;
  /**
   * 限制 FFmpeg 线程数（写入 `-threads N`）；0/不传不限制。
   * 工作时段限流时建议 2。
   */
  threads?: number;
  /** 子进程优先级回调（Windows BelowNormal 等） */
  onSpawn?: (pid: number) => void;
}

export interface RenderInput {
  sourceVideo?: string;
  /** 跨集混剪：episodeId -> 本地视频路径 */
  sourceVideos?: Record<string, string>;
  plan: ClipPlan;
  segments: AsrSegment[];
  config: EffectiveConfig;
  outputPath: string;
  /** 预计算切条（与 pipeline 日志一致）；未传则内部 prepareRenderClips */
  renderClips?: Array<{
    segmentId: string;
    episodeId?: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  /** 源视频时长（ms），用于集尾无台词转场延伸；未传且提供 sourceVideos 时会 ffprobe */
  episodeSourceDurationMs?: Record<string, number>;
  prepareRenderOptions?: PrepareRenderClipsOptions;
  /** 当前成片在批次中的输出序号，用于角标随机模式稳定判定 */
  outputIndex?: number;
  /** 整剧总成片数，用于花字按整剧比例出现 */
  totalOutputs?: number;
  /** 短剧名，用于替换标题花字中的 ${dramaTitle} 占位符 */
  dramaTitle?: string;
}

export interface RenderResult {
  outputPath: string;
  wallTimeSec: number;
  codec: string;
  /** 成片视频基本数据：宽/高/时长/文件字节数 */
  videoInfo?: VideoBasicInfo;
  /** 成片文件大小（字节） */
  fileSizeBytes?: number;
}

/** 视频基本数据（宽/高/时长/文件大小），上传与入库通用 */
export interface VideoBasicInfo {
  width?: number;
  height?: number;
  durationSec?: number;
  fileSizeBytes?: number;
}

function parseFrameRate(rate?: string): number | undefined {
  if (!rate || rate === "0/0") return undefined;
  const parts = rate.split("/");
  if (parts.length === 2) {
    const num = Number.parseFloat(parts[0] ?? "");
    const den = Number.parseFloat(parts[1] ?? "");
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  }
  const single = Number.parseFloat(rate);
  return Number.isFinite(single) && single > 0 ? single : undefined;
}

type FfprobeStreamEntry = {
  codec_type?: string;
  duration?: string;
  nb_frames?: string;
  r_frame_rate?: string;
  width?: number;
  height?: number;
};

/** ffprobe 读取视频基本数据：宽、高、时长（毫秒）、文件大小（字节） */
export async function probeVideoInfo(
  videoPath: string,
  ffprobePath = "ffprobe",
): Promise<VideoBasicInfo> {
  const [size, durationMs, dimensions] = await Promise.allSettled([
    stat(videoPath).then((s) => s.size).catch(() => undefined),
    probeVideoDurationMs(videoPath, ffprobePath),
    probeVideoSize(videoPath, ffprobePath),
  ]);
  return {
    width: dimensions.status === "fulfilled" ? dimensions.value.width : undefined,
    height: dimensions.status === "fulfilled" ? dimensions.value.height : undefined,
    durationSec: durationMs.status === "fulfilled" ? Math.round(durationMs.value / 1000) : undefined,
    fileSizeBytes: size.status === "fulfilled" ? size.value : undefined,
  };
}

async function probeVideoSize(
  videoPath: string,
  ffprobePath: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      videoPath,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 无法读取视频尺寸: ${videoPath}`));
        return;
      }
      const match = stdout.trim().match(/(\d+)x(\d+)/);
      if (!match) {
        reject(new Error(`ffprobe 未返回有效尺寸: ${stdout.trim()}`));
        return;
      }
      resolve({ width: Number(match[1]), height: Number(match[2]) });
    });
  });
}

/** 单路 stream 时长（秒）；无 duration 时用 nb_frames / r_frame_rate 估算（常见于 MP4 片尾纯画面） */
function streamDurationSec(stream: FfprobeStreamEntry): number | undefined {
  const streamSec = Number.parseFloat(stream.duration ?? "");
  if (Number.isFinite(streamSec) && streamSec > 0) return streamSec;

  const frames = Number.parseInt(stream.nb_frames ?? "", 10);
  const fps = parseFrameRate(stream.r_frame_rate);
  if (Number.isFinite(frames) && frames > 0 && fps && fps > 0) {
    return frames / fps;
  }
  return undefined;
}

/** ffprobe 读取媒体容器时长（毫秒，四舍五入）；取 format 与各 stream 时长的最大值 */
export function probeVideoDurationMs(
  videoPath: string,
  ffprobePath = "ffprobe",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,duration,nb_frames,r_frame_rate",
      "-of",
      "json",
      videoPath,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 无法读取视频时长: ${videoPath} (${stderr.trim() || code})`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: FfprobeStreamEntry[];
        };
        const candidates: number[] = [];
        const formatSec = Number.parseFloat(parsed.format?.duration ?? "");
        if (Number.isFinite(formatSec) && formatSec > 0) candidates.push(formatSec);
        for (const stream of parsed.streams ?? []) {
          const streamSec = streamDurationSec(stream);
          if (streamSec != null && streamSec > 0) candidates.push(streamSec);
        }
        if (!candidates.length) {
          reject(new Error(`ffprobe 未返回有效时长: ${stdout.trim().slice(0, 200)}`));
          return;
        }
        resolve(Math.round(Math.max(...candidates) * 1000));
      } catch (err) {
        reject(
          new Error(
            `ffprobe 解析时长失败: ${videoPath} (${err instanceof Error ? err.message : String(err)})`,
          ),
        );
      }
    });
  });
}

export interface AsrSourceDurationInfo {
  /** 用于 ASR 集尾延伸的权威时长（max(视频容器, 音频轨, 转写返回)） */
  sourceDurationMs: number;
  videoDurationMs?: number;
  audioDurationMs?: number;
  transcribeDurationMs: number;
}

export interface ResolveAsrSourceDurationOptions {
  ffprobePath?: string;
  /** extractAudio 产出的 wav；音轨可能比视频容器短（片尾纯画面） */
  audioPath?: string;
}

/**
 * ASR 集尾应对齐**源视频容器**时长。
 * 片尾 4–5s 转场常无音轨，FunASR/wav 时长会偏短，必须用 ffprobe 读视频。
 */
export async function resolveAsrSourceDurationMs(
  sourceVideoPath: string,
  transcribeDurationMs: number,
  options: ResolveAsrSourceDurationOptions = {},
): Promise<AsrSourceDurationInfo> {
  const probe = options.ffprobePath ?? "ffprobe";
  let videoDurationMs: number | undefined;
  let audioDurationMs: number | undefined;

  try {
    videoDurationMs = await probeVideoDurationMs(sourceVideoPath, probe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[asr] ffprobe 视频时长失败 (${sourceVideoPath}): ${message}`);
  }

  if (options.audioPath) {
    try {
      audioDurationMs = await probeVideoDurationMs(options.audioPath, probe);
    } catch {
      // wav 探测失败可忽略
    }
  }

  const sourceDurationMs = Math.max(
    videoDurationMs ?? 0,
    audioDurationMs ?? 0,
    transcribeDurationMs,
  );

  if (videoDurationMs && transcribeDurationMs && videoDurationMs - transcribeDurationMs > 500) {
    console.log(
      `[asr] 视频(${(videoDurationMs / 1000).toFixed(2)}s) 长于转写(${(transcribeDurationMs / 1000).toFixed(2)}s)，` +
        `片尾缺口 ${((videoDurationMs - transcribeDurationMs) / 1000).toFixed(2)}s 将在 ASR 末段补齐`,
    );
  } else if (!videoDurationMs && transcribeDurationMs > 0) {
    console.warn(
      `[asr] 未能 ffprobe 源视频时长 (${sourceVideoPath})，集尾延伸可能不完整；请检查 ffprobe 路径`,
    );
  }

  return { sourceDurationMs, videoDurationMs, audioDurationMs, transcribeDurationMs };
}

async function probeEpisodeSourceDurations(
  sourceVideos: Record<string, string>,
  ffprobePath?: string,
): Promise<Record<string, number>> {
  const probe = ffprobePath ?? "ffprobe";
  const entries = await Promise.all(
    Object.entries(sourceVideos).map(async ([episodeId, path]) => {
      try {
        const durationMs = await probeVideoDurationMs(path, probe);
        return [episodeId, durationMs] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((e): e is readonly [string, number] => e != null));
}

export class FfmpegRenderer {
  private readonly fontRegistry: FontRegistry | undefined;
  private readonly stickerRegistry: StickerRegistry | undefined;

  constructor(private readonly options: FfmpegRunnerOptions) {
    if (options.fontsDir) {
      this.fontRegistry = loadFontRegistry(options.fontsDir);
    }
    if (options.stickersDir) {
      this.stickerRegistry = loadStickerRegistry(options.stickersDir);
    }
  }

  async extractAudio(sourceVideo: string, outputWav: string): Promise<void> {
    await mkdir(dirname(outputWav), { recursive: true });
    const ffprobe = this.options.ffprobePath ?? "ffprobe";
    const hasAudio = await this.probeAudioStream(sourceVideo, ffprobe).catch(() => false);
    if (!hasAudio) {
      throw new Error(
        `无法从素材提取音频：${sourceVideo} 不含音轨或不是视频文件。请上传带音频的 mp4/mov 等视频。`,
      );
    }
    await this.run([
      "-y",
      "-i",
      sourceVideo,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      outputWav,
    ]);
  }

  /** 从成片抽取一帧作为封面图（默认第 1 秒，避免片头黑场）。输出强制 9:16 竖屏 720x1280，横屏视频居中裁剪。 */
  async extractCoverFrame(
    sourceVideo: string,
    outputImage: string,
    options?: { atSec?: number },
  ): Promise<void> {
    await mkdir(dirname(outputImage), { recursive: true });
    const atSec = options?.atSec ?? 1;
    await this.run([
      "-y",
      "-ss",
      String(atSec),
      "-i",
      sourceVideo,
      "-frames:v",
      "1",
      "-vf",
      "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
      "-q:v",
      "2",
      outputImage,
    ]);
  }

  async render(input: RenderInput): Promise<RenderResult> {
    const started = Date.now();
    const { workDir } = this.options;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(workDir, { recursive: true });

    const { clips, repairs } = input.renderClips?.length
      ? { clips: input.renderClips, repairs: [] as string[] }
      : await (async () => {
          let episodeDurations = input.episodeSourceDurationMs ?? input.prepareRenderOptions?.episodeSourceDurationMs;
          if (!episodeDurations && input.sourceVideos && Object.keys(input.sourceVideos).length > 0) {
            episodeDurations = await probeEpisodeSourceDurations(
              input.sourceVideos,
              this.options.ffprobePath,
            );
          }
          if (!episodeDurations && input.sourceVideo) {
            try {
              const durationMs = await probeVideoDurationMs(
                input.sourceVideo,
                this.options.ffprobePath,
              );
              episodeDurations = { default: durationMs };
            } catch {
              // 无时长则仅按 ASR 切条
            }
          }
          const prepareOptions: PrepareRenderClipsOptions = {
            ...input.prepareRenderOptions,
            episodeSourceDurationMs: episodeDurations ?? input.prepareRenderOptions?.episodeSourceDurationMs,
          };
          return prepareRenderClips(input.plan, input.segments, prepareOptions);
        })();
    if (repairs.length) {
      console.log(`[ffmpeg] 渲染去重: ${repairs.join("; ")}`);
    }
    if (clips.length === 0) {
      throw new Error("混剪计划未包含任何片段，无法渲染");
    }
    console.log(`[ffmpeg] 成片共 ${clips.length} 刀（同集块内不碎切，单 pass 渲染）`);

    const encode = input.config.render.encode;
    const preferNvenc = encode.codec.includes("nvenc");
    // 每次开渲前再解析：sibling 任务若已 disableNvenc，本任务直接 libx264，避免无意义重试刷 WARN
    const resolveActiveCodec = () => resolveVideoCodec(encode.codec);
    let usedCodec = resolveActiveCodec();
    const preferGpu = shouldUseGpuVideoPipeline(encode.codec);

    const uniqueSources = [...new Set(clips.map((c) => resolveClipSource(input, c)).filter(Boolean))] as string[];
    const sourceSizes = await Promise.all(uniqueSources.map((path) => this.probeVideoSize(path)));
    const maxSource = {
      width: Math.max(...sourceSizes.map((s) => s.width)),
      height: Math.max(...sourceSizes.map((s) => s.height)),
    };
    const workingWidth = maxSource.width;
    const workingHeight = maxSource.height;
    const workingSize = { width: workingWidth, height: workingHeight };
    const videoSpec = resolveOutputVideoSpec(input.plan, input.config.render, maxSource);

    const softCpuCodec = () =>
      encode.codec.includes("hevc") || encode.codec.includes("h265") ? "libx265" : "libx264";

    const runPreparedPass = async (gpu: boolean, codecOverride?: string) => {
      const activeCodec = codecOverride ?? resolveActiveCodec();
      usedCodec = activeCodec;
      const prepared = prepareRenderPass({
        input,
        clips,
        gpu,
        workingWidth,
        workingHeight,
        workingSize,
        videoSpec,
      });
      if (gpu) {
        console.log(
          "[ffmpeg] GPU 管线: NVDEC + scale_cuda/pad_cuda → CPU xfade/concat（fps=30）→ NVENC",
        );
      } else if (activeCodec.includes("nvenc")) {
        console.log("[ffmpeg] 使用 CPU 滤镜 + NVENC 编码");
      } else if (preferNvenc) {
        console.log(`[ffmpeg] 使用 CPU 滤镜 + ${activeCodec} 编码（NVENC 跳过/回退）`);
      }
      console.log(
        `[ffmpeg] 源 ${maxSource.width}x${maxSource.height} → 成片 ${videoSpec.width}x${videoSpec.height} (${videoSpec.ratio}) codec=${activeCodec}`,
      );
      const enhancement = await this.prepareEnhancements(
        input,
        clips,
        videoSpec.height,
        prepared.videoOut,
        prepared.audioOut,
      );
      await this.run(buildFfmpegRenderArgs(input, prepared, activeCodec, encode, enhancement));
    };

    /** GPU/NVENC 硬失败：再试 CPU+NVENC 只会重复同一错误，直接 libx264 */
    const isNvencHardFailure = (message: string) =>
      /h264_nvenc|hevc_nvenc|\bnvenc\b|error code: -40|Function not implemented/i.test(message);

    const runCpuNvencOrSoft = async () => {
      // 并发：开渲前再查一次，sibling 已禁用则不再打 NVENC
      if (!preferNvenc || !isNvencRenderAvailable()) {
        await runPreparedPass(false, softCpuCodec());
        return;
      }
      try {
        await runPreparedPass(false);
      } catch (cpuNvencErr) {
        await cleanupFailedRenderOutput(input.outputPath);
        const nvencReason =
          cpuNvencErr instanceof Error ? cpuNvencErr.message : String(cpuNvencErr);
        console.warn(`[ffmpeg] NVENC 编码失败，回退 libx264: ${nvencReason.slice(0, 200)}`);
        disableNvencForSession(nvencReason);
        await runPreparedPass(false, softCpuCodec());
      }
    };

    try {
      if (shouldAttemptGpuPipeline(preferGpu) && resolveActiveCodec().includes("nvenc")) {
        try {
          await runPreparedPass(true);
        } catch (gpuErr) {
          await cleanupFailedRenderOutput(input.outputPath);
          const reason = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
          console.warn(`[ffmpeg] GPU 渲染失败，回退 CPU 滤镜: ${reason.slice(0, 200)}`);
          disableGpuPipelineForSession(reason);
          if (isNvencHardFailure(reason)) {
            disableNvencForSession(reason);
            await runPreparedPass(false, softCpuCodec());
          } else {
            await runCpuNvencOrSoft();
          }
        }
      } else {
        await runCpuNvencOrSoft();
      }
    } catch (err) {
      await cleanupFailedRenderOutput(input.outputPath);
      throw err;
    }

    // 渲染成功后统一探测成片基本数据，供上传和入库使用
    let videoInfo: VideoBasicInfo | undefined;
    let fileSizeBytes: number | undefined;
    try {
      videoInfo = await probeVideoInfo(input.outputPath, this.options.ffprobePath ?? "ffprobe");
      fileSizeBytes = videoInfo.fileSizeBytes;
      console.log(
        `[ffmpeg] 成片信息 ${videoInfo.width ?? "?"}x${videoInfo.height ?? "?"} dur=${videoInfo.durationSec?.toFixed(1) ?? "?"}s size=${fileSizeBytes != null ? `${Math.round(fileSizeBytes / 1024 / 1024)}MB` : "?"}`,
      );
    } catch (infoErr) {
      const msg = infoErr instanceof Error ? infoErr.message : String(infoErr);
      console.warn(`[ffmpeg] 探测成片信息失败: ${msg.slice(0, 200)}`);
    }

    return {
      outputPath: input.outputPath,
      wallTimeSec: (Date.now() - started) / 1000,
      codec: usedCodec,
      videoInfo,
      fileSizeBytes,
    };
  }

  /** 下载 BGM + 生成 ASS 字幕 + 构建增强滤镜段 */
  private async prepareEnhancements(
    input: RenderInput,
    clips: Array<{ segmentId: string; episodeId?: string; startMs: number; endMs: number; text: string }>,
    outputHeight: number,
    baseVideoLabel: string,
    baseAudioLabel: string,
  ): Promise<EnhancementResult | null> {
    const render = input.config.render;
    console.log(
      "[ffmpeg] enhancement config received: titleCards=" +
        JSON.stringify(render.titleCards ?? []) +
        " disclaimer=" +
        JSON.stringify(render.disclaimer ?? null) +
        " cornerWatermark=" +
        JSON.stringify(render.cornerWatermark ?? null) +
        " cornerWatermarks=" +
        JSON.stringify(render.cornerWatermarks ?? []),
    );
    const subtitleStyle = render.subtitleStyle;
    const bgm = render.bgm;
    const titleCards = render.titleCards;
    const planSubtitleOn = input.plan.output.subtitle !== false;

    // 字幕：plan.output.subtitle !== false 且 subtitleStyle.enabled !== false 时烧录
    const effectiveSubtitleStyle =
      planSubtitleOn && subtitleStyle ? subtitleStyle : undefined;

    // 计算成片总时长（秒），供免责声明从开头显示到结尾
    const outputDurationSec = clips.reduce((sum, c) => sum + (c.endMs - c.startMs) / 1000, 0);

    // BGM：多候选随机挑一首再下载
    let bgmLocalPath: string | undefined;
    const pickedBgm = pickRandomBgmTrack(bgm);
    if (pickedBgm?.url) {
      try {
        bgmLocalPath = await this.downloadBgm(pickedBgm.url);
        console.log(`[ffmpeg] BGM 随机选用: ${pickedBgm.url.slice(0, 120)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ffmpeg] BGM 下载失败，跳过: ${msg.slice(0, 200)}`);
      }
    }

    const result = buildRenderEnhancements({
      subtitleStyle: effectiveSubtitleStyle,
      bgm: pickedBgm,
      titleCards,
      disclaimer: render.disclaimer,
      cornerWatermark: render.cornerWatermark,
      cornerWatermarks: render.cornerWatermarks,
      wordArt: render.wordArt,
      stickers: render.stickers,
      renderClips: clips,
      outputHeight,
      outputDurationSec,
      workDir: this.options.workDir,
      bgmLocalPath,
      baseVideoLabel,
      baseAudioLabel,
      dramaTitle: input.dramaTitle,
      outputIndex: input.outputIndex,
      totalOutputs: input.totalOutputs,
      fontRegistry: this.fontRegistry,
      stickerRegistry: this.stickerRegistry,
      segments: input.segments,
    });

    if (result?.artifacts.length) {
      for (const art of result.artifacts) {
        await mkdir(dirname(art.path), { recursive: true }).catch(() => {});
        await writeFile(art.path, art.content, "utf8");
      }
      console.log(`[ffmpeg] 字幕已生成: ${result.artifacts.map((a) => a.path).join(", ")}`);
    }

    // 调试：打印 titleCards / disclaimer / cornerWatermark 等增强滤镜片段
    if (result?.filterSuffix) {
      const firstEnhancement = result.filterSuffix.split(";")[0];
      console.log(`[ffmpeg] enhancement filter first segment: ${firstEnhancement}`);
    }

    return result;
  }

  /** 下载 BGM 到工作目录 */
  private async downloadBgm(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`BGM 下载 HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const ext = url.match(/\.(mp3|wav|aac|m4a|flac)(\?|$)/i)?.[1]?.toLowerCase() ?? "mp3";
    const outPath = `${this.options.workDir}/bgm.${ext}`;
    await mkdir(dirname(outPath), { recursive: true }).catch(() => {});
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, buf);
    console.log(`[ffmpeg] BGM 已下载: ${outPath} (${buf.length} bytes)`);
    return outPath;
  }

  private async probeVideoSize(videoPath: string): Promise<{ width: number; height: number }> {
    return probeVideoSize(videoPath, this.options.ffprobePath ?? "ffprobe");
  }

  private probeAudioStream(sourceVideo: string, ffprobePath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobePath, [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        sourceVideo,
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.includes("audio"));
        else resolve(false);
      });
    });
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let lastProgressLogAt = 0;
      let lastEncodedTime = "";
      const threads = this.options.threads;
      const finalArgs =
        threads && threads > 0 && !args.includes("-threads")
          ? ["-threads", String(Math.floor(threads)), ...args]
          : args;
      const child = spawn(this.options.ffmpegPath, finalArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      if (child.pid && this.options.onSpawn) {
        this.options.onSpawn(child.pid);
      }
      // 只保留尾部，避免长片软编时 stderr 占满内存
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = `${stderrTail}${text}`.slice(-12000);
        const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
        if (match?.[1]) lastEncodedTime = match[1];
        const now = Date.now();
        // 每 15s 打一次进度，避免 UI 误以为卡死（libx264 长片很慢）
        if (lastEncodedTime && now - lastProgressLogAt >= 15_000) {
          lastProgressLogAt = now;
          const wallSec = Math.round((now - started) / 1000);
          console.log(`[ffmpeg] 渲染中… 已编码 ${lastEncodedTime}（墙钟 ${wallSec}s，CPU 软编请耐心等待）`);
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const wallSec = ((Date.now() - started) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`[ffmpeg] 渲染完成，耗时 ${wallSec}s${lastEncodedTime ? `（成片时间轴 ${lastEncodedTime}）` : ""}`);
          resolve();
          return;
        }
        reject(new Error(formatFfmpegError(stderrTail, code)));
      });
    });
  }
}

function resolveClipSource(
  input: RenderInput,
  clip: { segmentId: string; episodeId?: string },
): string | undefined {
  const episodeId = clip.episodeId;
  if (episodeId && input.sourceVideos?.[episodeId]) {
    return input.sourceVideos[episodeId];
  }
  if (input.sourceVideos && Object.keys(input.sourceVideos).length === 1) {
    return Object.values(input.sourceVideos)[0];
  }
  return input.sourceVideo;
}

function formatFfmpegError(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errors = lines.filter((line) => /error|invalid|failed|no such file/i.test(line));
  const summary = (errors.length > 0 ? errors : lines).slice(-4).join(" | ");
  return `ffmpeg exited ${code ?? "?"}: ${summary}`.slice(0, 800);
}

interface PreparedRenderPass {
  gpu: boolean;
  sourcePaths: string[];
  gpuInputArgs: string[];
  filterComplex: string;
  videoOut: string;
  audioOut: string;
}

function prepareRenderPass(input: {
  input: RenderInput;
  clips: Array<{ segmentId: string; episodeId?: string; startMs: number; endMs: number }>;
  gpu: boolean;
  workingWidth: number;
  workingHeight: number;
  workingSize: { width: number; height: number };
  videoSpec: ReturnType<typeof resolveOutputVideoSpec>;
}): PreparedRenderPass {
  const { clips, gpu, workingWidth, workingHeight, workingSize, videoSpec } = input;
  const outputVf = buildVideoFilter(videoSpec, workingSize);

  const sourcePaths: string[] = [];
  const sourceIndexByPath = new Map<string, number>();
  const trimClips: TrimClipSpec[] = [];
  const gpuInputArgs: string[] = [];

  for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
    const clip = clips[clipIndex]!;
    const sourceVideo = resolveClipSource(input.input, clip);
    if (!sourceVideo) {
      throw new Error(`片段 ${clip.segmentId} 找不到对应源视频`);
    }

    const startSec = clip.startMs / 1000;
    const endSec = clip.endMs / 1000;
    const durationSec = (clip.endMs - clip.startMs) / 1000;

    if (gpu) {
      trimClips.push({ inputIndex: clipIndex, startSec, endSec, durationSec });
      gpuInputArgs.push(...buildGpuClipInputArgs(sourceVideo, startSec, endSec));
      if (!sourcePaths.includes(sourceVideo)) {
        sourcePaths.push(sourceVideo);
      }
      continue;
    }

    let inputIndex = sourceIndexByPath.get(sourceVideo);
    if (inputIndex === undefined) {
      inputIndex = sourcePaths.length;
      sourcePaths.push(sourceVideo);
      sourceIndexByPath.set(sourceVideo, inputIndex);
    }
    trimClips.push({ inputIndex, startSec, endSec, durationSec });
  }

  const transitionCfg = resolveTransitionConfig(input.input.config.render.transition);
  const useTransition =
    transitionCfg.enabled && trimClips.length > 1 && hasCrossEpisodeBoundary(clips);

  const buildConcatGraph = () =>
    gpu
      ? buildSinglePassGpuConcatGraph({ clips: trimClips, workingWidth, workingHeight, outputVf })
      : buildSinglePassConcatGraph({ clips: trimClips, workingWidth, workingHeight, outputVf });

  const buildXfadeGraph = (transitionTypes: string[], transitionDurationSec: number) =>
    gpu
      ? buildSinglePassGpuXfadeGraph({
          clips: trimClips,
          workingWidth,
          workingHeight,
          outputVf,
          transitionTypes,
          transitionDurationSec,
        })
      : buildSinglePassXfadeGraph({
          clips: trimClips,
          workingWidth,
          workingHeight,
          outputVf,
          transitionTypes,
          transitionDurationSec,
        });

  let filterComplex: string;
  let videoOut: string;
  let audioOut: string;

  if (useTransition) {
    const durationsSec = trimClips.map((c) => c.durationSec);
    const transitionSec = resolveTransitionDurationSec(durationsSec, transitionCfg);
    if (transitionSec != null) {
      const transitionTypes = resolveTransitionTypesForRender(
        trimClips.length - 1,
        input.input.config.render.transition,
      );
      const graph = buildXfadeGraph(transitionTypes, transitionSec);
      filterComplex = graph.filterComplex;
      videoOut = graph.videoOut;
      audioOut = graph.audioOut;
      const episodeKeys = clips.map((c) => c.episodeId ?? c.segmentId.replace(/_s\d+$/i, ""));
      const pipelineTag = gpu ? "GPU " : "";
      console.log(
        `[ffmpeg] 单 pass ${pipelineTag}跨集转场 ${transitionSec}s × ${trimClips.length - 1} 处 [${transitionTypes.join(", ")}] (${episodeKeys.join(" → ")})`,
      );
    } else {
      console.log("[ffmpeg] 片段过短，跳过跨集转场，使用硬切拼接");
      const graph = buildConcatGraph();
      filterComplex = graph.filterComplex;
      videoOut = graph.videoOut;
      audioOut = graph.audioOut;
    }
  } else {
    const graph = buildConcatGraph();
    filterComplex = graph.filterComplex;
    videoOut = graph.videoOut;
    audioOut = graph.audioOut;
  }

  return { gpu, sourcePaths, gpuInputArgs, filterComplex, videoOut, audioOut };
}

function buildFfmpegRenderArgs(
  input: RenderInput,
  prepared: PreparedRenderPass,
  codec: string,
  encode: EffectiveConfig["render"]["encode"],
  enhancement?: EnhancementResult | null,
): string[] {
  // BGM 额外输入的实际 index = 原有视频源输入数
  // GPU 每段输入为多参数（-ss/-to/-hwaccel/.../-i），按 -i 计数
  const sourceInputCount = prepared.gpu
    ? prepared.gpuInputArgs.filter((a) => a === "-i").length
    : prepared.sourcePaths.length;
  let filterComplex = prepared.filterComplex;
  let videoOut = prepared.videoOut;
  let audioOut = prepared.audioOut;
  let extraInputs: string[] = [];

  if (enhancement) {
    // 用实际 sourceInputCount 替换 BGM input index 占位符
    const correctedSuffix = enhancement.filterSuffix.replaceAll(
      "__BGM_INPUT_INDEX__",
      String(sourceInputCount),
    );
    filterComplex = correctedSuffix
      ? `${prepared.filterComplex};${correctedSuffix}`
      : prepared.filterComplex;
    videoOut = enhancement.videoOut;
    audioOut = enhancement.audioOut;
    extraInputs = enhancement.extraInputs;
  }

  const args = [
    "-y",
    ...(prepared.gpu ? buildGpuGlobalArgs() : []),
    ...(prepared.gpu
      ? prepared.gpuInputArgs
      : prepared.sourcePaths.flatMap((p) => ["-i", p])),
    ...extraInputs,
    "-filter_complex",
    filterComplex,
    "-map",
    `[${videoOut}]`,
    "-map",
    `[${audioOut}]`,
    "-c:v",
    codec,
  ];
  // NVENC/H.264/H.265 均需 yuv420p；CPU 滤镜输出若未显式指定，NVENC 常报 -22 Invalid argument
  args.push("-pix_fmt", "yuv420p");
  appendVideoEncodeArgs(args, codec, encode);
  args.push(
    "-c:a",
    input.config.render.audio?.codec ?? "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-b:a",
    input.config.render.audio?.bitrate ?? "128k",
    input.outputPath,
  );
  return args;
}

async function cleanupFailedRenderOutput(outputPath: string): Promise<void> {
  try {
    const info = await stat(outputPath);
    if (info.size < 4096) {
      await unlink(outputPath);
    }
  } catch {
    // ignore missing file
  }
}
