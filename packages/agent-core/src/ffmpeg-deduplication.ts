import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export type DeduplicationMode = "frame-drop" | "speed-up" | "sharpen" | "color-grade";

export interface DeduplicationResult {
  outputPath: string;
  mode: DeduplicationMode;
}

interface DeduplicationOptions {
  /** 原成片路径 */
  videoPath: string;
  /** ffmpeg 可执行路径 */
  ffmpegPath?: string;
  /** ffprobe 可执行路径 */
  ffprobePath?: string;
  /** 随机种子函数，便于测试 */
  random?: () => number;
  /** 是否禁用（默认启用） */
  disabled?: boolean;
}

/** 从 4 种去重模式中随机选一种 */
function randomMode(random = Math.random): DeduplicationMode {
  const modes: DeduplicationMode[] = ["frame-drop", "speed-up", "sharpen", "color-grade"];
  return modes[Math.floor(random() * modes.length)]!;
}

function tempOutputPath(inputPath: string): string {
  const base = basename(inputPath, extname(inputPath));
  return join(tmpdir(), `${base}-dedup-${Date.now()}${extname(inputPath)}`);
}

function parseFrameRate(raw: string): number | undefined {
  const parts = raw.trim().split("/");
  if (parts.length === 2) {
    const num = Number.parseFloat(parts[0] ?? "");
    const den = Number.parseFloat(parts[1] ?? "");
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  }
  const single = Number.parseFloat(raw);
  return Number.isFinite(single) && single > 0 ? single : undefined;
}

async function probeFrameRate(videoPath: string, ffprobePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "csv=p=0",
        videoPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      resolve(parseFrameRate(stdout));
    });
  });
}

async function runFfmpeg(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  videoFilter: string,
  audioFilter?: string,
): Promise<void> {
  const args = ["-y", "-i", inputPath, "-vf", videoFilter];
  if (audioFilter) {
    args.push("-af", audioFilter);
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "22",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg 去重处理失败: ${stderr.slice(-400)}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * 对成片做轻度随机处理避免平台判重。
 * 上传 TOS 前调用，默认 4 选 1：抽帧 / 加速 / 锐化 / 调色。
 * 失败时回退原视频路径，不阻断上传。
 */
export async function applyDeduplication(options: DeduplicationOptions): Promise<DeduplicationResult> {
  const { videoPath, ffmpegPath = "ffmpeg", ffprobePath = "ffprobe", random = Math.random } = options;
  if (options.disabled) {
    return { outputPath: videoPath, mode: "frame-drop" };
  }

  const mode = randomMode(random);
  const outputPath = tempOutputPath(videoPath);

  try {
    switch (mode) {
      case "frame-drop": {
        // 每秒随机抽掉 1 帧（仅对 >=25fps 生效），视觉几乎无感
        const fps = await probeFrameRate(videoPath, ffprobePath);
        const targetFps = fps && fps >= 25 ? Math.max(20, fps - 1) : undefined;
        const filter = targetFps ? `fps=${targetFps.toFixed(2)},format=yuv420p` : "fps=floor(24000/1001),format=yuv420p";
        await runFfmpeg(ffmpegPath, videoPath, outputPath, filter);
        break;
      }
      case "speed-up": {
        // 整体加速约 1.02 倍，时长缩短约 2%，音调不变
        await runFfmpeg(ffmpegPath, videoPath, outputPath, "setpts=PTS/1.02,format=yuv420p", "atempo=1.02");
        break;
      }
      case "sharpen": {
        // 轻微锐化
        await runFfmpeg(ffmpegPath, videoPath, outputPath, "unsharp=3:3:0.3:3:3:0.0,format=yuv420p");
        break;
      }
      case "color-grade": {
        // 轻微调色：亮度 +2%、对比度 +3%
        await runFfmpeg(ffmpegPath, videoPath, outputPath, "eq=brightness=0.02:contrast=1.03,format=yuv420p");
        break;
      }
    }

    const s = await stat(outputPath);
    if (s.size === 0) {
      throw new Error("去重输出文件大小为 0");
    }
    console.log(`[deduplication] 已执行 ${mode}: ${videoPath} -> ${outputPath} (${Math.round(s.size / 1024 / 1024)}MB)`);
    return { outputPath, mode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[deduplication] ${mode} 失败，回退原视频: ${msg.slice(0, 200)}`);
    try {
      await unlink(outputPath);
    } catch {
      /* ignore */
    }
    return { outputPath: videoPath, mode };
  }
}
