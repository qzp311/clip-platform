import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type FfmpegPathSource =
  | "env_override"
  | "bundled_engines"
  | "bundled_legacy"
  | "path_hint"
  | "path_fallback";

export interface FfmpegCapabilities {
  ffmpegPath: string;
  ffprobePath: string;
  pathSource: FfmpegPathSource;
  version: string;
  h264Nvenc: boolean;
  hevcNvenc: boolean;
  h264Amf: boolean;
  hevcAmf: boolean;
  h264Qsv: boolean;
  hevcQsv: boolean;
  h264Vaapi: boolean;
  hevcVaapi: boolean;
  cudaHwaccel: boolean;
  scaleCuda: boolean;
  nvencSmokeOk: boolean;
  nvencSmokeDetail?: string;
  amfSmokeOk: boolean;
  amfSmokeDetail?: string;
  qsvSmokeOk: boolean;
  qsvSmokeDetail?: string;
  gpuPipelineOk: boolean;
  warnings: string[];
}

export interface NvencSmokeResult {
  ok: boolean;
  exitCode: number;
  detail: string;
}

let cachedCapabilities: FfmpegCapabilities | null = null;
let nvencDisabledForSession = false;
let nvencDisableReason: string | null = null;
let amfDisabledForSession = false;
let amfDisableReason: string | null = null;
let qsvDisabledForSession = false;
let qsvDisableReason: string | null = null;

export function getFfmpegCapabilities(): FfmpegCapabilities | null {
  return cachedCapabilities;
}

export function setFfmpegCapabilities(caps: FfmpegCapabilities): void {
  cachedCapabilities = caps;
  if (!caps.nvencSmokeOk) {
    disableNvencForSession(caps.warnings[0] ?? "NVENC 冒烟测试未通过");
  }
  if (!caps.amfSmokeOk) {
    disableAmfForSession(caps.warnings[0] ?? "AMF 冒烟测试未通过");
  }
  if (!caps.qsvSmokeOk) {
    disableQsvForSession(caps.warnings[0] ?? "QSV 冒烟测试未通过");
  }
}

export function isNvencRenderAvailable(): boolean {
  if (nvencDisabledForSession) return false;
  // 未探测时不能假设可用：run-drama-mix 等子进程若跳过探测，盲目硬编会刷 -22/-40
  if (!cachedCapabilities) return false;
  return cachedCapabilities.nvencSmokeOk;
}

export function isAmfRenderAvailable(): boolean {
  if (amfDisabledForSession) return false;
  if (!cachedCapabilities) return false;
  return cachedCapabilities.amfSmokeOk;
}

export function isQsvRenderAvailable(): boolean {
  if (qsvDisabledForSession) return false;
  if (!cachedCapabilities) return false;
  return cachedCapabilities.qsvSmokeOk;
}

export function isGpuFilterPipelineAvailable(): boolean {
  if (nvencDisabledForSession) return false;
  if (!cachedCapabilities) return false;
  return cachedCapabilities.gpuPipelineOk;
}

export function disableNvencForSession(reason: string): void {
  if (!nvencDisabledForSession) {
    console.warn(`[ffmpeg] 本进程后续渲染跳过 NVENC: ${reason.slice(0, 200)}`);
    nvencDisableReason = reason;
  }
  nvencDisabledForSession = true;
}

export function disableAmfForSession(reason: string): void {
  if (!amfDisabledForSession) {
    console.warn(`[ffmpeg] 本进程后续渲染跳过 AMF: ${reason.slice(0, 200)}`);
    amfDisableReason = reason;
  }
  amfDisabledForSession = true;
}

export function disableQsvForSession(reason: string): void {
  if (!qsvDisabledForSession) {
    console.warn(`[ffmpeg] 本进程后续渲染跳过 QSV: ${reason.slice(0, 200)}`);
    qsvDisableReason = reason;
  }
  qsvDisabledForSession = true;
}

export function shouldAttemptNvenc(preferNvenc: boolean): boolean {
  return preferNvenc && isNvencRenderAvailable();
}

export function resetFfmpegCapabilitySession(): void {
  nvencDisabledForSession = false;
  nvencDisableReason = null;
  amfDisabledForSession = false;
  amfDisableReason = null;
  qsvDisabledForSession = false;
  qsvDisableReason = null;
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function parseFfmpegVersion(stderr: string): string {
  const match = stderr.match(/ffmpeg version (\S+)/i);
  return match?.[1] ?? "unknown";
}

async function probeEncoders(ffmpegPath: string): Promise<{
  h264Nvenc: boolean;
  hevcNvenc: boolean;
  h264Amf: boolean;
  hevcAmf: boolean;
  h264Qsv: boolean;
  hevcQsv: boolean;
  h264Vaapi: boolean;
  hevcVaapi: boolean;
}> {
  const { stdout, stderr, code } = await runCommand(ffmpegPath, ["-hide_banner", "-encoders"]);
  const text = `${stdout}\n${stderr}`;
  if (code !== 0) {
    return {
      h264Nvenc: false,
      hevcNvenc: false,
      h264Amf: false,
      hevcAmf: false,
      h264Qsv: false,
      hevcQsv: false,
      h264Vaapi: false,
      hevcVaapi: false,
    };
  }
  return {
    h264Nvenc: /\bh264_nvenc\b/i.test(text),
    hevcNvenc: /\bhevc_nvenc\b/i.test(text),
    h264Amf: /\bh264_amf\b/i.test(text),
    hevcAmf: /\bhevc_amf\b/i.test(text),
    h264Qsv: /\bh264_qsv\b/i.test(text),
    hevcQsv: /\bhevc_qsv\b/i.test(text),
    h264Vaapi: /\bh264_vaapi\b/i.test(text),
    hevcVaapi: /\bhevc_vaapi\b/i.test(text),
  };
}

async function probeHwaccels(ffmpegPath: string): Promise<boolean> {
  const { stdout, stderr, code } = await runCommand(ffmpegPath, ["-hide_banner", "-hwaccels"]);
  if (code !== 0) return false;
  return /\bcuda\b/i.test(`${stdout}\n${stderr}`);
}

async function probeScaleCuda(ffmpegPath: string): Promise<boolean> {
  const { stdout, stderr, code } = await runCommand(ffmpegPath, ["-hide_banner", "-filters"]);
  if (code !== 0) return false;
  return /\bscale_cuda\b/i.test(`${stdout}\n${stderr}`);
}

function normalizeSpawnPath(path: string): string {
  if (process.platform === "win32" && path.startsWith("\\\\?\\")) {
    return path.slice(4);
  }
  return path;
}

/** 实际调用给定编码器编码几帧，验证驱动/GPU 会话可用 */
async function probeEncoderSmoke(
  ffmpegPath: string,
  codec: string,
  encoderOpts: string[] = [],
): Promise<NvencSmokeResult> {
  const nullOut = process.platform === "win32" ? "NUL" : "/dev/null";
  const ffmpeg = normalizeSpawnPath(ffmpegPath);
  const { stderr, stdout, code } = await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=0.2:size=320x240:rate=30",
    "-frames:v",
    "5",
    "-c:v",
    codec,
    ...encoderOpts,
    "-f",
    "null",
    nullOut,
  ]);
  const combined = `${stderr}\n${stdout}`.trim();
  const failPattern =
    /(cannot load|can't open|no capable devices|invalid argument|error while opening|failed to|not found|unknown encoder|openencode session|nvenc api version|driver does not support|function not implemented|libamd*amdh264e|init_encoder|invalid device|operation failed)/i;
  const exitOk = code === 0;
  const ok = exitOk && !failPattern.test(combined);
  const detail = combined.slice(0, 500) || `(exit ${code}, no output)`;
  return { ok, exitCode: code, detail };
}

export async function probeNvencSmoke(ffmpegPath: string): Promise<NvencSmokeResult> {
  return probeEncoderSmoke(ffmpegPath, "h264_nvenc", ["-preset", "p1"]);
}

export async function probeAmfSmoke(ffmpegPath: string): Promise<NvencSmokeResult> {
  return probeEncoderSmoke(ffmpegPath, "h264_amf", []);
}

export async function probeQsvSmoke(ffmpegPath: string): Promise<NvencSmokeResult> {
  // QSV 需要初始化 MFX，通常 lavfi 输入即可；-qsv_device 可选
  return probeEncoderSmoke(ffmpegPath, "h264_qsv", []);
}

export async function probeFfmpegCapabilities(input: {
  ffmpegPath: string;
  ffprobePath: string;
  pathSource: FfmpegPathSource;
}): Promise<FfmpegCapabilities> {
  const warnings: string[] = [];
  const { ffmpegPath, ffprobePath, pathSource } = input;

  if (!existsSync(ffmpegPath) && pathSource === "path_fallback") {
    warnings.push(`FFmpeg 未找到: ${ffmpegPath}（将回退 PATH，通常无硬编码器）`);
  } else if (pathSource === "path_fallback") {
    warnings.push("未使用 bundled FFmpeg，当前为系统 PATH 回退（可能无硬编码器）");
  }

  let version = "unknown";
  try {
    const ver = await runCommand(ffmpegPath, ["-hide_banner", "-version"]);
    version = parseFfmpegVersion(`${ver.stdout}\n${ver.stderr}`);
  } catch (err) {
    warnings.push(`无法执行 ffmpeg -version: ${err instanceof Error ? err.message : err}`);
  }

  const encoders = await probeEncoders(ffmpegPath);
  const cudaHwaccel = await probeHwaccels(ffmpegPath);
  const scaleCuda = await probeScaleCuda(ffmpegPath);

  if (!encoders.h264Nvenc && !encoders.h264Amf && !encoders.h264Qsv && !encoders.h264Vaapi) {
    warnings.push("当前 FFmpeg 未编译可用 GPU H.264 编码器（将使用 libx264）");
  }
  if (!cudaHwaccel) {
    warnings.push("当前 FFmpeg 不支持 cuda 硬解（-hwaccels）");
  }
  if (!scaleCuda) {
    warnings.push("当前 FFmpeg 无 scale_cuda 滤镜（GPU 管线将跳过）");
  }

  let nvencSmokeOk = false;
  let nvencSmokeDetail: string | undefined;
  if (encoders.h264Nvenc) {
    const smoke = await probeNvencSmoke(ffmpegPath);
    nvencSmokeOk = smoke.ok;
    nvencSmokeDetail = smoke.detail;
    if (!nvencSmokeOk) {
      warnings.push(
        `h264_nvenc 冒烟测试失败（exit=${smoke.exitCode}）: ${smoke.detail.slice(0, 200)}`,
      );
    }
  }

  let amfSmokeOk = false;
  let amfSmokeDetail: string | undefined;
  if (encoders.h264Amf) {
    const smoke = await probeAmfSmoke(ffmpegPath);
    amfSmokeOk = smoke.ok;
    amfSmokeDetail = smoke.detail;
    if (!amfSmokeOk) {
      warnings.push(`h264_amf 冒烟测试失败（exit=${smoke.exitCode}）: ${smoke.detail.slice(0, 200)}`);
    }
  }

  let qsvSmokeOk = false;
  let qsvSmokeDetail: string | undefined;
  if (encoders.h264Qsv) {
    const smoke = await probeQsvSmoke(ffmpegPath);
    qsvSmokeOk = smoke.ok;
    qsvSmokeDetail = smoke.detail;
    if (!qsvSmokeOk) {
      warnings.push(`h264_qsv 冒烟测试失败（exit=${smoke.exitCode}）: ${smoke.detail.slice(0, 200)}`);
    }
  }

  const gpuPipelineOk = encoders.h264Nvenc && cudaHwaccel && scaleCuda && nvencSmokeOk;

  return {
    ffmpegPath,
    ffprobePath,
    pathSource,
    version,
    h264Nvenc: encoders.h264Nvenc,
    hevcNvenc: encoders.hevcNvenc,
    h264Amf: encoders.h264Amf,
    hevcAmf: encoders.hevcAmf,
    h264Qsv: encoders.h264Qsv,
    hevcQsv: encoders.hevcQsv,
    h264Vaapi: encoders.h264Vaapi,
    hevcVaapi: encoders.hevcVaapi,
    cudaHwaccel,
    scaleCuda,
    nvencSmokeOk,
    nvencSmokeDetail,
    amfSmokeOk,
    amfSmokeDetail,
    qsvSmokeOk,
    qsvSmokeDetail,
    gpuPipelineOk,
    warnings,
  };
}
