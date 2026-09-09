import type { ClipPlan, RenderConfig } from "@clip/sdk";

export interface VideoDimensions {
  width: number;
  height: number;
}

export interface OutputVideoSpec {
  width: number;
  height: number;
  ratio: string;
  cropMode: string;
}

function parseRatio(ratio: string): [number, number] {
  const normalized = ratio.replace(/\s+/g, "");
  if (normalized.includes(":")) {
    const [w, h] = normalized.split(":").map(Number);
    if (w && h) return [w, h];
  }
  if (normalized.includes("/")) {
    const [w, h] = normalized.split("/").map(Number);
    if (w && h) return [w, h];
  }
  return [16, 9];
}

/** 根据原片比例与配置决定成片分辨率 */
export function resolveOutputVideoSpec(
  plan: ClipPlan,
  render: RenderConfig,
  source: VideoDimensions,
): OutputVideoSpec {
  const video = render.video ?? {};
  const sourceLandscape = source.width >= source.height;

  let ratio = plan.output.ratio ?? video.ratio ?? "auto";
  if (ratio === "auto" || ratio === "source") {
    ratio = sourceLandscape ? "16:9" : "9:16";
  }

  // 横屏素材默认出横屏，避免误用竖屏配置把画面裁成 9:16
  if (sourceLandscape && source.width / Math.max(1, source.height) > 1.05 && ratio === "9:16") {
    ratio = "16:9";
  }

  const [rw, rh] = parseRatio(ratio);
  const isLandscape = rw >= rh;

  let width = video.width ?? (isLandscape ? 1920 : 1080);
  let height = video.height ?? (isLandscape ? 1080 : 1920);

  if (isLandscape && height > width) {
    width = 1920;
    height = 1080;
  }
  if (!isLandscape && width > height) {
    width = 1080;
    height = 1920;
  }

  return {
    width,
    height,
    ratio,
    cropMode: video.cropMode ?? "center",
  };
}

/** 构建 ffmpeg -vf 滤镜：横屏保横屏，竖屏目标才 center crop */
export function buildVideoFilter(
  spec: OutputVideoSpec,
  source: VideoDimensions,
): string {
  const { width, height, ratio, cropMode } = spec;
  const [rw, rh] = parseRatio(ratio);
  const targetAspect = rw / rh;
  const sourceAspect = source.width / Math.max(1, source.height);

  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;

  // 横屏成片：等比缩放 + 黑边，不裁切
  if (targetAspect >= 1) {
    return scalePad;
  }

  // 竖屏成片 + 横屏源：居中裁切为 9:16
  if (sourceAspect > targetAspect + 0.02) {
    const cropExpr =
      cropMode === "center"
        ? `crop=ih*${rw}/${rh}:ih:(iw-ow)/2:0`
        : `crop=ih*${rw}/${rh}:ih`;
    return `${cropExpr},scale=${width}:${height}`;
  }

  // 竖屏源 → 竖屏成片
  return scalePad;
}

function buildGpuScalePad(width: number, height: number): string {
  return `scale_cuda=${width}:${height}:force_original_aspect_ratio=decrease:interp_algo=bilinear,pad_cuda=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** GPU 版 buildVideoFilter：scale_cuda + pad_cuda */
export function buildGpuVideoFilter(
  spec: OutputVideoSpec,
  source: VideoDimensions,
): string {
  const { width, height, ratio, cropMode } = spec;
  const [rw, rh] = parseRatio(ratio);
  const targetAspect = rw / rh;
  const sourceAspect = source.width / Math.max(1, source.height);

  const scalePad = buildGpuScalePad(width, height);

  if (targetAspect >= 1) {
    return scalePad;
  }

  if (sourceAspect > targetAspect + 0.02) {
    if (cropMode === "center") {
      return `scale_cuda=${width}:${height}:force_original_aspect_ratio=increase:interp_algo=bilinear,pad_cuda=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    }
    return `scale_cuda=${width}:${height}:force_original_aspect_ratio=increase:interp_algo=bilinear,pad_cuda=${width}:${height}:0:(oh-ih)/2:color=black`;
  }

  return scalePad;
}
