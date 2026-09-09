import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AsrHighlightType,
  AsrSegment,
  StickerConfig,
  StickerOverlay,
  StickerPosition,
  StickerTemplate,
} from "@clip/sdk";
import type { StickerRegistry } from "./sticker-registry.js";
import { resolveStickerFile, resolveStickerTemplate } from "./sticker-registry.js";

export interface StickerRenderInput {
  config: StickerConfig;
  /** 贴花模板注册表 */
  stickerRegistry: StickerRegistry;
  /** 成片输出高度（px），用于缩放和偏移 */
  outputHeight: number;
  /** 成片总时长（秒），用于结束时间缺省 */
  outputDurationSec: number;
  /** 输入视频标签 */
  baseVideoLabel: string;
  /** 最终输出视频标签 */
  outputVideoLabel: string;
  /** 短剧名，用于替换 text 占位符 */
  dramaTitle?: string;
  /** 当前成片输出序号，用于稳定随机选择 */
  outputIndex?: number;
  /** ASR 片段，用于按高光/场景自动匹配 */
  segments?: AsrSegment[];
}

/** 把路径转成 FFmpeg filter 中可用的单引号字符串（: 和 \ 转义） */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** 把位置枚举转成 overlay 位置表达式 */
function positionToExprs(
  position: StickerPosition,
  offsetX: number,
  offsetY: number,
): { x: string; y: string } {
  const xOffset = offsetX === 0 ? "" : `${offsetX >= 0 ? "+" : ""}${offsetX}`;
  const yOffset = offsetY === 0 ? "" : `${offsetY >= 0 ? "+" : ""}${offsetY}`;
  switch (position) {
    case "top-left":
      return { x: `0${xOffset}`, y: `0${yOffset}` };
    case "top":
      return { x: `(W-w)/2${xOffset}`, y: `0${yOffset}` };
    case "top-right":
      return { x: `W-w${xOffset}`, y: `0${yOffset}` };
    case "center-left":
      return { x: `0${xOffset}`, y: `(H-h)/2${yOffset}` };
    case "center":
      return { x: `(W-w)/2${xOffset}`, y: `(H-h)/2${yOffset}` };
    case "center-right":
      return { x: `W-w${xOffset}`, y: `(H-h)/2${yOffset}` };
    case "bottom-left":
      return { x: `0${xOffset}`, y: `H-h${yOffset}` };
    case "bottom":
      return { x: `(W-w)/2${xOffset}`, y: `H-h${yOffset}` };
    case "bottom-right":
    default:
      return { x: `W-w${xOffset}`, y: `H-h${yOffset}` };
  }
}

/** 估算一个静态/动态贴花在当前成片里应该缩放到的尺寸 */
function computeStickerSize(
  template: StickerTemplate,
  outputHeight: number,
  scale: number,
): { width: number; height: number } | undefined {
  // 模板清单里目前没有真实宽高；按输出高度 × 默认缩放比例 × 用户缩放比例估算
  const defaultScale = template.defaultScale ?? 0.5;
  const targetHeight = Math.round(outputHeight * defaultScale * scale);
  if (targetHeight < 8) return undefined;
  // 宽度按常见 1:1 或 16:9 估算；实际渲染时 FFmpeg 会按输入素材比例
  const width = Math.round(targetHeight * (template.type === "image" ? 1.0 : 1.78));
  return { width, height: targetHeight };
}

/** 将单个贴花配置解析成可渲染的输入文件路径和参数 */
function resolveOverlayInput(
  registry: StickerRegistry,
  overlay: StickerOverlay,
): { filePath: string; template: StickerTemplate } | undefined {
  // 支持直接传本地绝对路径或模板 ID
  const rawId = overlay.templateId.trim();
  if (rawId.includes("/") || rawId.includes("\\") || rawId.endsWith(".png") || rawId.endsWith(".mov") || rawId.endsWith(".mp4") || rawId.endsWith(".gif")) {
    if (existsSync(rawId)) {
      return { filePath: rawId, template: resolveStickerTemplate(registry, rawId) ?? ({
        id: rawId,
        name: rawId,
        type: rawId.match(/\.(mp4|mov|gif)$/i) ? "video" : "image",
        file: rawId,
      } as StickerTemplate) };
    }
    console.warn(`[sticker-overlay] 贴花文件不存在: ${rawId}`);
    return undefined;
  }
  const template = resolveStickerTemplate(registry, rawId);
  if (!template) {
    console.warn(`[sticker-overlay] 模板未注册: ${rawId}`);
    return undefined;
  }
  const filePath = resolveStickerFile(registry, rawId);
  if (!filePath) {
    console.warn(`[sticker-overlay] 模板文件不存在: ${template.file} (template=${rawId})`);
    return undefined;
  }
  return { filePath, template };
}

/** 根据 ASR 片段提取匹配标签和高光类型 */
function collectSegmentTags(segments?: AsrSegment[]): { tags: string[]; highlightTypes: AsrHighlightType[] } {
  const tags = new Set<string>();
  const highlightTypes = new Set<AsrHighlightType>();
  if (!segments) return { tags: [], highlightTypes: [] };
  for (const seg of segments) {
    if (seg.highlightType) highlightTypes.add(seg.highlightType);
    if (seg.sceneType) tags.add(seg.sceneType);
    if (seg.emotion) tags.add(seg.emotion);
    if (Array.isArray(seg.highlightTags)) {
      for (const tag of seg.highlightTags) tags.add(tag);
    }
  }
  return { tags: Array.from(tags), highlightTypes: Array.from(highlightTypes) };
}

/** 从自动匹配配置生成叠加条目（按标签/高光类型匹配模板） */
function generateAutoOverlays(input: StickerRenderInput): StickerOverlay[] {
  const { config, stickerRegistry, outputIndex = 0, segments } = input;
  const auto = config.autoMatch;
  if (!auto?.enabled) return [];

  const maxOverlays = Math.max(0, Math.min(10, auto.maxOverlays ?? 3));
  if (maxOverlays === 0) return [];

  const { tags, highlightTypes } = collectSegmentTags(segments);
  const matchedTemplates: StickerTemplate[] = [];

  // 按高光类型优先匹配
  for (const ht of auto.matchHighlightTypes ?? highlightTypes) {
    const t = stickerRegistry.byTag.get(ht)?.[0];
    if (t && !matchedTemplates.some((m) => m.id === t.id)) matchedTemplates.push(t);
  }
  // 再按场景标签匹配
  for (const tag of tags) {
    const t = stickerRegistry.byTag.get(tag)?.[0];
    if (t && !matchedTemplates.some((m) => m.id === t.id)) matchedTemplates.push(t);
  }

  // 回退默认模板
  if (matchedTemplates.length === 0 && auto.defaultTemplateId) {
    const t = resolveStickerTemplate(stickerRegistry, auto.defaultTemplateId);
    if (t) matchedTemplates.push(t);
  }

  return matchedTemplates.slice(0, maxOverlays).map((template) => ({
    templateId: template.id,
    enabled: true,
    position: template.defaultPosition ?? "center",
    scale: template.defaultScale ?? 0.5,
    startSec: 0,
    endSec: template.durationSec ?? input.outputDurationSec,
    loop: template.loop ?? true,
    text: template.textPlaceholder ?? undefined,
  } as StickerOverlay));
}

/** 构建单个贴花的 FFmpeg 滤镜段；返回新标签和额外输入参数 */
function buildSingleStickerOverlay(
  input: StickerRenderInput,
  overlay: StickerOverlay,
  index: number,
  videoIn: string,
): { filterSuffix: string; videoOut: string; extraInputs: string[] } | undefined {
  const resolved = resolveOverlayInput(input.stickerRegistry, overlay);
  if (!resolved) return undefined;
  const { filePath, template } = resolved;

  const scale = Math.max(0.01, Math.min(10, overlay.scale ?? template.defaultScale ?? 0.5));
  const size = computeStickerSize(template, input.outputHeight, scale);
  if (!size) return undefined;

  const position = overlay.position ?? template.defaultPosition ?? "center";
  const offsetX = Math.round((overlay.offsetX ?? 0) * (input.outputHeight / 1080));
  const offsetY = Math.round((overlay.offsetY ?? 0) * (input.outputHeight / 1080));
  const { x, y } = positionToExprs(position, offsetX, offsetY);
  const rotationRad = ((overlay.rotation ?? 0) * Math.PI) / 180;
  const alpha = Math.max(0, Math.min(1, overlay.alpha ?? 1));
  const startSec = Math.max(0, overlay.startSec ?? 0);
  const endSec = Math.min(input.outputDurationSec, overlay.endSec ?? input.outputDurationSec);
  const loop = overlay.loop ?? template.loop ?? true;

  const escapedPath = escapeFilterPath(filePath);
  const stickerInputLabel = `sticker${index}`;
  const scaledLabel = `sticker${index}s`;
  const rotatedLabel = `sticker${index}r`;
  const outLabel = `vsticker${index}`;

  const extraInputs: string[] = ["-i", filePath];

  const parts: string[] = [];
  // 缩放贴花到目标尺寸；透明素材用 format=yuva420p 保持 alpha
  parts.push(
    `[${stickerInputLabel}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
    `format=yuva420p[${scaledLabel}]`,
  );

  // 旋转；若角度为 0 可跳过，但统一处理更稳
  parts.push(
    `[${scaledLabel}]rotate=${rotationRad}:c=0x00000000:ow=rotw(${rotationRad}):oh=roth(${rotationRad})[${rotatedLabel}]`,
  );

  // 调整透明度 + 时间裁剪
  const enableExpr = `between(t\\,${startSec.toFixed(3)}\\,${endSec.toFixed(3)})`;
  const alphaExpr = alpha < 1 ? `,format=yuva420p,colorchannelmixer=aa=${alpha.toFixed(3)}` : "";
  parts.push(
    `[${videoIn}][${rotatedLabel}]overlay=` +
    `x=${x}:y=${y}:enable='${enableExpr}'${alphaExpr}[${outLabel}]`,
  );

  return { filterSuffix: parts.join(";"), videoOut: outLabel, extraInputs };
}

/** 构建贴花/花字模板系统滤镜；返回可追加到 filter_complex 的滤镜段 */
export function buildStickerOverlayFilter(input: StickerRenderInput): {
  filterSuffix: string;
  videoOut: string;
  extraInputs: string[];
} | null {
  if (!input.config.enabled) return null;

  const autoOverlays = generateAutoOverlays(input);
  const manualOverlays = (input.config.overlays ?? []).filter((o) => o.enabled !== false);
  const overlays = [...autoOverlays, ...manualOverlays];
  if (overlays.length === 0) return null;

  const parts: string[] = [];
  let videoIn = input.baseVideoLabel;
  const extraInputs: string[] = [];

  for (let i = 0; i < overlays.length; i++) {
    const result = buildSingleStickerOverlay(input, overlays[i], i, videoIn);
    if (!result) continue;
    parts.push(result.filterSuffix);
    videoIn = result.videoOut;
    extraInputs.push(...result.extraInputs);
  }

  if (parts.length === 0) return null;

  // 最终输出到指定标签
  if (videoIn !== input.outputVideoLabel) {
    parts.push(`[${videoIn}]null[${input.outputVideoLabel}]`);
  }

  return { filterSuffix: parts.join(";"), videoOut: input.outputVideoLabel, extraInputs };
}

/** 根据模板清单和 ASR 信息推荐可用模板 ID（用于调试或管理台） */
export function suggestStickerTemplates(
  registry: StickerRegistry,
  segments?: AsrSegment[],
  maxSuggestions = 5,
): string[] {
  const { tags, highlightTypes } = collectSegmentTags(segments);
  const result: string[] = [];
  for (const ht of highlightTypes) {
    for (const t of registry.byTag.get(ht) ?? []) {
      if (!result.includes(t.id)) result.push(t.id);
    }
  }
  for (const tag of tags) {
    for (const t of registry.byTag.get(tag) ?? []) {
      if (!result.includes(t.id)) result.push(t.id);
    }
  }
  return result.slice(0, maxSuggestions);
}
