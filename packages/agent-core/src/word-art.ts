import type { WordArtConfig, WordArtItem, WordArtStyle } from "@clip/sdk";
import { normalizeDrawtextColor } from "./render-enhancements.js";
import {
  getDefaultFontFamily,
  resolveEffectiveFontName,
  resolveFontFile,
} from "./font-registry.js";
import type { FontRegistry } from "./font-registry.js";
import { existsSync } from "node:fs";

export interface WordArtRenderInput {
  /** 新增花字配置 */
  config: WordArtConfig;
  /** 成片高度（px），用于字号/边距缩放 */
  outputHeight: number;
  /** 成片总时长（秒），用于计算 endSec 默认值 */
  outputDurationSec: number;
  /** 字体注册表 */
  fontRegistry?: FontRegistry;
  /** 主视频输入标签 */
  baseVideoLabel: string;
  /** 输出标签 */
  outputVideoLabel: string;
  /** 短剧名，替换 ${dramaTitle} */
  dramaTitle?: string;
  /** 输出序号，替换 ${index} */
  outputIndex?: number;
  /** 整剧总成片数，用于按整剧比例控制出现频次 */
  totalOutputs?: number;
}

/** 估算字符串在指定字号下的像素宽度（中文按字高，英文按半字高） */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    const half = code > 0x7f ? false : /[a-zA-Z0-9\s]/.test(ch);
    w += half ? fontSize * 0.55 : fontSize;
  }
  return Math.max(fontSize, Math.ceil(w));
}

function textBoxSize(text: string, fontSize: number, paddingX: number, paddingY: number): { w: number; h: number } {
  const w = Math.max(80, estimateTextWidth(text, fontSize) + paddingX * 2);
  const h = Math.max(60, fontSize + paddingY * 2);
  return { w, h };
}

/** 生成 color 源滤镜字符串 */
function colorSource(
  color: string,
  alpha: number,
  width: number,
  height: number,
  duration: number,
): string {
  const hex = color.replace(/^0x/, "").toUpperCase();
  // color 滤镜本身没有 format 选项，后接 format 才能保留 alpha 通道
  return `color=c=0x${hex}@${alpha.toFixed(2)}:s=${width}x${height}:d=${duration},format=yuva420p`;
}

/** #RRGGBB / 0xRRGGBB / 裸 RRGGBB → drawtext 的 0xRRGGBB */
function normalizeDrawtextColorLocal(color: string | undefined, fallback: string): string {
  return normalizeDrawtextColor(color, fallback);
}

/** 返回不带 alpha 的 0xRRGGBB */
function stripAlpha(color: string): string {
  return normalizeDrawtextColorLocal(color, "0x000000");
}

/** 返回带 alpha 的 0xRRGGBBAA */
function withAlpha(color: string, alpha: number): string {
  const hex = stripAlpha(color).replace(/^0x/i, "");
  const aa = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `0x${hex}${aa}`;
}

/** 把 0xRRGGBB 颜色按系数缩放 */
function shadeColor(hex: string, factor: number): string {
  const clean = hex.replace(/^0x/i, "").replace(/^#/, "").slice(0, 6);
  const n = parseInt(clean, 16) || 0;
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)));
  const r = clamp((n >> 16) & 0xff);
  const g = clamp((n >> 8) & 0xff);
  const b = clamp(n & 0xff);
  return `0x${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/** 把字体文件路径转义成 drawtext fontfile 参数可用的形式 */
function escapeFontFile(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** Windows 常见中文字体名到字体文件路径映射；与 render-enhancements.ts 保持一致，用于未命中白名单时兜底。 */
const FONT_FILE_MAP: Record<string, string[]> = {
  "Microsoft YaHei": ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyhl.ttc"],
  "SimHei": ["C:/Windows/Fonts/simhei.ttf"],
  "SimSun": ["C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/simsunb.ttf"],
  "SimKai": ["C:/Windows/Fonts/simkai.ttf", "C:/Windows/Fonts/simkai.ttc"],
  "FangSong": ["C:/Windows/Fonts/simfang.ttf", "C:/Windows/Fonts/simfang.ttc"],
  "DengXian": ["C:/Windows/Fonts/Deng.ttf", "C:/Windows/Fonts/Dengb.ttf", "C:/Windows/Fonts/Dengl.ttf"],
  "Microsoft JhengHei": ["C:/Windows/Fonts/msjh.ttc", "C:/Windows/Fonts/msjhbd.ttc", "C:/Windows/Fonts/msjhl.ttc"],
  "Noto Sans SC": ["C:/Windows/Fonts/NotoSansSC-VF.ttf"],
  "Noto Serif SC": ["C:/Windows/Fonts/NotoSerifSC-VF.ttf"],
  "Arial": ["C:/Windows/Fonts/arial.ttf"],
  "HYZhongHeiTi": ["C:/Windows/Fonts/HYZhongHeiTi-197.ttf"],
};

/** 解析字体文件路径和实际字体名；未命中白名单时回退系统字体（与标题花字保持一致） */
function resolveFontFileWithFallback(
  fontName?: string,
  fontRegistry?: FontRegistry,
): { path: string; name: string } | undefined {
  const name = fontName?.trim();
  if (!name) return undefined;
  if (/\.(ttf|ttc|otf|woff|woff2)$/i.test(name) && existsSync(name)) {
    return { path: name, name };
  }
  if (fontRegistry) {
    const bundled = resolveFontFile(fontRegistry, name);
    if (bundled) return { path: bundled, name };
    // 优先按传入字体名精确匹配系统字体
    const exactCandidates = FONT_FILE_MAP[name];
    if (exactCandidates) {
      for (const p of exactCandidates) {
        if (existsSync(p)) {
          console.warn(`[word-art] 字体 "${name}" 未命中白名单文件，回退系统字体 "${name}": ${p}`);
          return { path: p, name };
        }
      }
    }
    // 精确匹配未命中时，按顺序遍历第一个可用的系统字体，避免方块
    for (const [sysName, paths] of Object.entries(FONT_FILE_MAP)) {
      for (const p of paths) {
        if (existsSync(p)) {
          console.warn(`[word-art] 字体 "${name}" 未命中白名单文件，回退系统字体 "${sysName}": ${p}`);
          return { path: p, name: sysName };
        }
      }
    }
    return undefined;
  }
  const candidates = FONT_FILE_MAP[name] ?? [];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, name };
  }
  return undefined;
}

/** 构造 drawtext 字体参数：与标题花字保持一致，优先 fontfile，找不到再回退字体名 */
function buildFontSpec(fontName: string, fontRegistry?: FontRegistry): string {
  const resolved = resolveFontFileWithFallback(fontName, fontRegistry);
  if (resolved) {
    return `fontfile='${escapeFontFile(resolved.path)}'`;
  }
  return `fontfile='':font='${fontName}'`;
}

/** 解析并校验字体名；未命中白名单时回退默认字体 */
function resolveWordArtFontName(fontRegistry: FontRegistry | undefined, fontName?: string): string {
  if (!fontRegistry) {
    return fontName?.trim() || getDefaultFontFamily(undefined);
  }
  return resolveEffectiveFontName(fontRegistry, fontName);
}

/** 按垂直位置返回 y 表达式 */
function buildYExpr(position: "top" | "center" | "bottom" | undefined, marginV: number): string {
  switch (position) {
    case "bottom":
      return `h-text_h-${marginV}`;
    case "center":
      return `(h-text_h)/2`;
    default:
      return `${marginV}`;
  }
}

/** 构建时间区间 enable 表达式 */
function buildTimeEnable(startSec?: number, endSec?: number): string {
  if (startSec != null && endSec != null) {
    return `:enable='between(t,${startSec.toFixed(2)},${endSec.toFixed(2)})'`;
  }
  if (startSec != null) {
    return `:enable='gte(t,${startSec.toFixed(2)})'`;
  }
  if (endSec != null) {
    return `:enable='lte(t,${endSec.toFixed(2)})'`;
  }
  return ":enable='gte(t,0)'";
}

/** 替换文案中的占位符 */
function renderText(text: string, dramaTitle?: string, outputIndex?: number): string {
  let result = text;
  if (dramaTitle != null) {
    result = result.replace(/\$\{dramaTitle\}/g, dramaTitle);
  }
  if (outputIndex != null) {
    result = result.replace(/\$\{index\}/g, String(outputIndex + 1));
  }
  return result;
}

/** 构建通用外发光花字 */
function buildWordArtGlow(
  options: {
    fontSpec: string;
    fontSize: number;
    text: string;
    color: string;
    outlineColor: string;
    outlineWidth: number;
    glowColor: string;
    glowAlpha: number;
    xExpr: string;
    yExpr: string;
    inputVideoLabel: string;
    outputVideoLabel: string;
    duration: number;
    startSec?: number;
    endSec?: number;
  },
): string {
  const {
    fontSpec, fontSize, text, color, outlineColor, outlineWidth, glowColor, glowAlpha,
    xExpr, yExpr, inputVideoLabel, outputVideoLabel, duration, startSec, endSec,
  } = options;
  const escapedText = escapeDrawtext(text);
  const timeEnable = buildTimeEnable(startSec, endSec);

  // 发光透明度为 0 时不生成光晕层，仅渲染描边主文字，避免残留色块
  if (glowAlpha <= 0) {
    return (
      `[${inputVideoLabel}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
      `bordercolor=${outlineColor}:borderw=${outlineWidth}:text='${escapedText}':` +
      `x=${xExpr}:y=${yExpr}${timeEnable}[${outputVideoLabel}]`
    );
  }

  const glowHex = stripAlpha(glowColor).replace(/^0x/, "");
  const padding = Math.round(fontSize * 0.6);
  const { w: textW, h: textH } = textBoxSize(text, fontSize, padding, padding);
  const glowW = textW + fontSize * 2;
  const glowH = textH + fontSize * 2;
  const glowTextX = "(w-text_w)/2";
  const glowTextY = "(h-text_h)/2";
  const toOverlayExpr = (expr: string) =>
    expr.replace(/\bw\b/g, "W").replace(/\bh\b/g, "H").replace(/text_w/g, `${textW}`).replace(/text_h/g, `${textH}`);
  const glowX = `${toOverlayExpr(xExpr)}-${fontSize}`;
  const glowY = `${toOverlayExpr(yExpr)}-${fontSize}`;
  const glowSource =
    colorSource(`0x${glowHex}`, glowAlpha, glowW, glowH, duration) + "," +
    `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=0x${glowHex}:` +
    `bordercolor=0x${glowHex}:borderw=${Math.max(2, Math.round(outlineWidth * 1.5))}:` +
    `text='${escapedText}':x=${glowTextX}:y=${glowTextY},` +
    `format=yuva420p,boxblur=${Math.max(2, Math.round(fontSize * 0.25))}:${Math.max(2, Math.round(fontSize * 0.25))}:1`;
  return (
    `${glowSource}[${outputVideoLabel}_glow];` +
    `[${inputVideoLabel}][${outputVideoLabel}_glow]overlay=` +
    `x=${glowX}:y=${glowY}${timeEnable}[${outputVideoLabel}_glowed];` +
    `[${outputVideoLabel}_glowed]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
    `bordercolor=${outlineColor}:borderw=${outlineWidth}:text='${escapedText}':` +
    `x=${xExpr}:y=${yExpr}${timeEnable}[${outputVideoLabel}]`
  );
}

/** 构建立体描边花字 */
function buildWordArtStroke3d(
  options: {
    fontSpec: string;
    fontSize: number;
    text: string;
    color: string;
    outlineColor: string;
    outlineWidth: number;
    shadowColor?: string;
    xExpr: string;
    yExpr: string;
    inputVideoLabel: string;
    outputVideoLabel: string;
    startSec?: number;
    endSec?: number;
  },
): string {
  const { fontSpec, fontSize, text, color, outlineColor, outlineWidth, shadowColor, xExpr, yExpr, inputVideoLabel, outputVideoLabel, startSec, endSec } = options;
  const escapedText = escapeDrawtext(text);
  const effectiveShadowColor = shadowColor ?? shadeColor(outlineColor, 0.5);
  const offset = Math.max(2, Math.round(fontSize * 0.06));
  const timeEnable = buildTimeEnable(startSec, endSec);
  const parts: string[] = [];
  let current = inputVideoLabel;
  for (let i = 3; i >= 1; i--) {
    const step = i * offset;
    const layerColor = i === 1 ? color : (i === 2 ? outlineColor : effectiveShadowColor);
    const label = i === 1 ? outputVideoLabel : `${outputVideoLabel}_s${i}`;
    const nextInput = i === 3 ? inputVideoLabel : `${outputVideoLabel}_s${i + 1}`;
    parts.push(
      `[${nextInput}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${layerColor}:` +
      `bordercolor=${outlineColor}:borderw=${outlineWidth}:text='${escapedText}':` +
      `x=${xExpr}+${step}:y=${yExpr}+${step}${timeEnable}[${label}]`,
    );
  }
  return parts.join(";");
}

/** 构建单条花字滤镜字符串 */
function buildWordArtItem(
  item: WordArtItem,
  options: Pick<WordArtRenderInput, "outputHeight" | "outputDurationSec" | "fontRegistry"> & {
    inputVideoLabel: string;
    outputVideoLabel: string;
    dramaTitle?: string;
    outputIndex?: number;
  },
): string {
  const scale = options.outputHeight / 1080;
  const fontSize = Math.round((item.fontSize ?? 64) * scale);
  const marginV = Math.round((item.marginV ?? 60) * scale);
  const baseOutlineWidth = Math.max(1, Math.round((item.outlineWidth ?? 3) * scale));
  const color = normalizeDrawtextColorLocal(item.color, "0xFFD700");
  const outlineColor = normalizeDrawtextColorLocal(item.outlineColor, "0x000000");
  const backgroundColor = normalizeDrawtextColorLocal(item.backgroundColor, "0x000000");
  const backgroundAlpha = Math.max(0, Math.min(1, item.backgroundAlpha ?? 0));
  const style: WordArtStyle = item.style ?? "standard";
  const fontName = resolveWordArtFontName(options.fontRegistry, item.fontName);
  const fontSpec = buildFontSpec(fontName, options.fontRegistry);
  const rawText = String(item.text ?? "").trim();
  const text = renderText(rawText, options.dramaTitle, options.outputIndex);
  const position = item.position ?? "top";
  const yExpr = buildYExpr(position, marginV);
  const xExpr = "(w-text_w)/2";
  const duration = Math.max(1, Math.ceil(options.outputDurationSec));
  const startSec = item.startSec;
  const endSec = item.endSec != null ? Math.min(item.endSec, duration) : undefined;
  const escapedText = escapeDrawtext(text);
  const hasBg = backgroundAlpha > 0;
  const userBg = hasBg ? withAlpha(backgroundColor, backgroundAlpha) : undefined;
  const timeEnable = buildTimeEnable(startSec, endSec);

  switch (style) {
    case "glow": {
      return buildWordArtGlow({
        fontSpec,
        fontSize,
        text,
        color,
        outlineColor,
        outlineWidth: baseOutlineWidth,
        glowColor: item.glowColor ? normalizeDrawtextColorLocal(item.glowColor, outlineColor) : outlineColor,
        glowAlpha: Math.max(0, Math.min(1, backgroundAlpha)),
        xExpr,
        yExpr,
        inputVideoLabel: options.inputVideoLabel,
        outputVideoLabel: options.outputVideoLabel,
        duration,
        startSec,
        endSec,
      });
    }
    case "stroke3d": {
      return buildWordArtStroke3d({
        fontSpec,
        fontSize,
        text,
        color,
        outlineColor,
        outlineWidth: baseOutlineWidth,
        shadowColor: item.shadowColor ? normalizeDrawtextColorLocal(item.shadowColor, "0x808080") : undefined,
        xExpr,
        yExpr,
        inputVideoLabel: options.inputVideoLabel,
        outputVideoLabel: options.outputVideoLabel,
        startSec,
        endSec,
      });
    }
    case "bar": {
      const paddingX = Math.round(fontSize * 0.55);
      const paddingY = Math.round(fontSize * 0.3);
      const { w: bgW, h: bgH } = textBoxSize(text, fontSize, paddingX, paddingY);
      const yTop = position === "bottom" ? `${options.outputHeight - bgH - marginV}` : `${marginV}`;
      const barBg =
        colorSource(backgroundColor, backgroundAlpha || 0.6, bgW, bgH, duration) + "," +
        `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:` +
        `text='${escapedText}':x=(w-text_w)/2:y=(h-text_h)/2`;
      return (
        `${barBg},format=yuva420p[${options.outputVideoLabel}_bar];` +
        `[${options.inputVideoLabel}][${options.outputVideoLabel}_bar]overlay=` +
        `x=(W-w)/2:y=${yTop}${timeEnable}[${options.outputVideoLabel}]`
      );
    }
    case "vertical": {
      const charSpacing = Math.round((item.charSpacing ?? 4) * scale);
      // 与标题花字保持一致：逐字符独立 drawtext，避免 ft_load_flags=vertical_layout 把中文拉成竖长方形
      const chars = text.split("");
      const lineHeight = fontSize + charSpacing;
      const totalHeight = chars.length * lineHeight;
      let current = options.inputVideoLabel;
      const parts: string[] = [];
      for (let j = 0; j < chars.length; j++) {
        const ch = escapeDrawtext(chars[j]!);
        const yOffset = (j * lineHeight) - (totalHeight / 2) + (lineHeight / 2);
        const charYExpr = `((h-${Math.round(totalHeight)})/2+${Math.round(yOffset)})`;
        const nextLabel = j === chars.length - 1 ? options.outputVideoLabel : `${options.outputVideoLabel}_c${j}`;
        const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
        parts.push(
          `[${current}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
          `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${ch}':x=${xExpr}:y=${charYExpr}${boxPart}${timeEnable}[${nextLabel}]`,
        );
        current = nextLabel;
      }
      return parts.join(";");
    }
    case "standard":
    default: {
      const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
      return (
        `[${options.inputVideoLabel}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
        `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${escapedText}':` +
        `x=${xExpr}:y=${yExpr}${boxPart}${timeEnable}[${options.outputVideoLabel}]`
      );
    }
  }
}

/**
 * 构建新增花字滤镜段。
 * 返回可直接拼入 filter_complex 的滤镜字符串；无启用条目时返回空字符串。
 */
/** 根据 outputIndex 与整剧总成片数，按 appearanceRatio 决定是否渲染该条花字 */
function shouldApplyWordArtItem(
  item: WordArtItem,
  outputIndex: number | undefined,
  totalOutputs: number | undefined,
): boolean {
  const ratio = Math.max(0, Math.min(1, item.appearanceRatio ?? 1));
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const total = Math.max(1, totalOutputs ?? 1);
  const index = Math.max(0, outputIndex ?? 0);
  // 把 outputIndex 映射到 0~total-1，再按 ratio 切分
  const position = index % total;
  return position < Math.max(1, Math.round(total * ratio));
}

export function buildWordArtFilter(input: WordArtRenderInput): string {
  if (input.config.enabled === false) return "";
  const items = (input.config.items ?? []).filter((item) => item.text?.trim());
  if (items.length === 0) return "";

  const parts: string[] = [];
  let currentLabel = input.baseVideoLabel;
  const duration = Math.max(1, Math.ceil(input.outputDurationSec));

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!shouldApplyWordArtItem(item, input.outputIndex, input.totalOutputs)) continue;

    const outLabel = parts.length === 0 && i === items.length - 1 ? input.outputVideoLabel : `${input.outputVideoLabel}_w${parts.length}`;
    const renderedText = renderText(item.text.trim(), input.dramaTitle, input.outputIndex);
    if (!renderedText) continue;

    const filter = buildWordArtItem(item, {
      outputHeight: input.outputHeight,
      outputDurationSec: duration,
      fontRegistry: input.fontRegistry,
      inputVideoLabel: currentLabel,
      outputVideoLabel: outLabel,
      dramaTitle: input.dramaTitle,
      outputIndex: input.outputIndex,
    });
    if (filter) {
      parts.push(filter);
      currentLabel = outLabel;
    }
  }

  return parts.join(";");
}
