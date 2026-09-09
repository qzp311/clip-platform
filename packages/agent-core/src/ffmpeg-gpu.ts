/** FFmpeg GPU 视频管线：CUDA 解码/滤镜 + NVENC（拼接/转场经 hwdownload 走 CPU xfade/concat） */

import { isGpuFilterPipelineAvailable } from "./ffmpeg-capability.js";

let gpuPipelineDisabledForSession = false;

/** 本 Agent 进程内 GPU 管线是否仍值得尝试（首次失败后跳过后续 clip 的双 pass） */
export function shouldAttemptGpuPipeline(preferGpu: boolean): boolean {
  return preferGpu && isGpuFilterPipelineAvailable() && !gpuPipelineDisabledForSession;
}

export function disableGpuPipelineForSession(reason: string): void {
  if (!gpuPipelineDisabledForSession) {
    console.warn(`[ffmpeg] 本任务后续 clip 跳过 GPU 尝试: ${reason.slice(0, 160)}`);
  }
  gpuPipelineDisabledForSession = true;
}

export function resetGpuPipelineSession(): void {
  gpuPipelineDisabledForSession = false;
}

export function buildGpuGlobalArgs(): string[] {
  return ["-init_hw_device", "cuda=cuda:0", "-filter_hw_device", "cuda"];
}

/** 每段切条独立输入：输入级 seek + NVDEC，避免 CPU trim 滤镜 */
export function buildGpuClipInputArgs(sourcePath: string, startSec: number, endSec: number): string[] {
  return [
    "-ss",
    startSec.toFixed(3),
    "-to",
    endSec.toFixed(3),
    "-hwaccel",
    "cuda",
    "-hwaccel_output_format",
    "cuda",
    "-i",
    sourcePath,
  ];
}

/** @deprecated GPU 管线已在 filter graph 内 fps=30 归一化，勿在编码器重复 -r 30 */
export function appendGpuOutputTimingArgs(args: string[]): void {
  args.push("-fps_mode", "cfr", "-r", "30");
}
