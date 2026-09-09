import type { RenderEncodeConfig } from "@clip/sdk";
import { isGpuFilterPipelineAvailable, isNvencRenderAvailable, isAmfRenderAvailable, isQsvRenderAvailable } from "./ffmpeg-capability.js";

/** Windows + NVENC 且探测通过时优先 CUDA 解码 / scale_cuda / NVENC */
export function shouldUseGpuVideoPipeline(codec: string): boolean {
  return process.platform === "win32" && codec.includes("nvenc") && isGpuFilterPipelineAvailable();
}

/** 按本机可用 GPU 编码器自动选择最终 codec。
 * 优先级：NVENC > AMF > QSV > 软编（libx264/libx265）。
 * 非 Windows 或非 NVENC 首选时直接回退 CPU。 */
export function resolveVideoCodec(preferred: string): string {
  const isHevc = preferred.includes("hevc") || preferred.includes("h265");
  // 仅当首选是 GPU 编码器时才做自动降级；若用户/配置指定软编则保持软编
  if (!preferred.includes("nvenc") && !preferred.includes("amf") && !preferred.includes("qsv") && !preferred.includes("vaapi")) {
    return preferred;
  }
  if (process.platform !== "win32") {
    return isHevc ? "libx265" : "libx264";
  }
  if (isNvencRenderAvailable()) {
    return isHevc ? "hevc_nvenc" : "h264_nvenc";
  }
  if (isAmfRenderAvailable()) {
    return isHevc ? "hevc_amf" : "h264_amf";
  }
  if (isQsvRenderAvailable()) {
    return isHevc ? "hevc_qsv" : "h264_qsv";
  }
  return isHevc ? "libx265" : "libx264";
}

/** 根据实际编码器生成对应的编码参数 */
export function appendVideoEncodeArgs(
  args: string[],
  codec: string,
  encode: RenderEncodeConfig,
): void {
  if (codec.includes("nvenc")) {
    // cq 需配合 rc=vbr + b:v=0，否则部分驱动/FFmpeg 会报 Invalid argument (-22)
    args.push(
      "-preset",
      encode.preset ?? "p4",
      "-rc",
      "vbr",
      "-cq",
      String(encode.cq ?? 23),
      "-b:v",
      "0",
    );
    return;
  }
  if (codec.includes("amf")) {
    args.push("-preset", "quality", "-qp_p", String(encode.cq ?? 23), "-qp_i", String(encode.cq ?? 23));
    return;
  }
  if (codec.includes("qsv")) {
    args.push("-preset", "medium", "-global_quality", String(encode.cq ?? 23), "-look_ahead", "0");
    return;
  }
  const fallback = encode.fallback;
  args.push(
    "-preset",
    fallback?.preset ?? "medium",
    "-crf",
    String(encode.crf ?? fallback?.crf ?? 23),
  );
}
