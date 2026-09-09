import { existsSync } from "node:fs";
import type {
  BgmConfig,
  BgmTrackConfig,
  CornerWatermarkConfig,
  CornerWatermarkPosition,
  CornerWatermarkStyle,
  DisclaimerConfig,
  DisclaimerLineConfig,
  DisclaimerLineStyle,
  StickerConfig,
  SubtitleStyleConfig,
  TitleCardConfig,
  TitleCardStyle,
  WordArtConfig,
} from "@clip/sdk";
import { buildAssSubtitle, remapClipsToTimeline, type RenderClipForSubtitle } from "./subtitle-overlay.js";
import type { FontRegistry } from "./font-registry.js";
import {
  getDefaultFontFamily,
  resolveEffectiveFontName,
  resolveFontFile as resolveBundledFontFile,
} from "./font-registry.js";
import { buildWordArtFilter } from "./word-art.js";
import { buildStickerOverlayFilter } from "./sticker-overlay.js";
import type { StickerRegistry } from "./sticker-registry.js";

/** Windows 常见中文字体名到字体文件路径映射；FFmpeg drawtext 用 fontfile 直接指定文件最稳。
 * 只列出当前 Agent 本机 C:\Windows\Fonts\ 下确实存在的字体文件，避免路径不存在导致渲染失败。
 * 当未传入字体注册表（fontRegistry）时，保留旧逻辑做兼容。 */
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

/** 把字体名解析成本机字体文件路径；找不到时返回 undefined。
 * 优先使用字体注册表（白名单）；若白名单字体文件缺失，回退 Windows 系统字体映射。 */
function resolveFontFile(fontName?: string, fontRegistry?: FontRegistry): string | undefined {
  return resolveFontFileWithName(fontName, fontRegistry)?.path;
}

/** 解析字体文件路径和实际字体名；白名单字体缺失时回退系统字体 */
function resolveFontFileWithName(
  fontName?: string,
  fontRegistry?: FontRegistry,
): { path: string; name: string } | undefined {
  const name = fontName?.trim();
  if (!name) return undefined;
  if (/\.(ttf|ttc|otf|woff|woff2)$/i.test(name) && existsSync(name)) {
    return { path: name, name };
  }
  if (fontRegistry) {
    const bundled = resolveBundledFontFile(fontRegistry, name);
    if (bundled) return { path: bundled, name };
    // 优先按传入字体名精确匹配系统字体；未找到时回退到第一个可用的系统字体
    const exactCandidates = FONT_FILE_MAP[name];
    if (exactCandidates) {
      for (const p of exactCandidates) {
        if (existsSync(p)) {
          console.warn(`[font] 字体 "${name}" 未命中白名单文件，回退系统字体 "${name}": ${p}`);
          return { path: p, name };
        }
      }
    }
    // 精确匹配未命中时，按顺序遍历第一个存在的系统字体，避免方块
    for (const [sysName, paths] of Object.entries(FONT_FILE_MAP)) {
      for (const p of paths) {
        if (existsSync(p)) {
          console.warn(`[font] 字体 "${name}" 未命中白名单文件，回退系统字体 "${sysName}": ${p}`);
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

/** 把字体文件路径转义成 drawtext fontfile 参数可用的形式（: 和 \ 需要转义） */
function escapeFontFile(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** 构造 drawtext 的字体参数：优先用字体文件路径，找不到再回退字体名。
 * 传入字体注册表时，未命中白名单的字体将自动回退到默认字体（抖音美好体）。 */
function buildDrawtextFontSpec(fontName?: string, fontRegistry?: FontRegistry): string {
  let effectiveName: string;
  if (fontRegistry) {
    effectiveName = resolveEffectiveFontName(fontRegistry, fontName);
  } else {
    effectiveName = fontName?.trim() || "Microsoft YaHei";
  }
  const resolved = resolveFontFileWithName(effectiveName, fontRegistry);
  if (resolved) {
    // 单字体文件直接指定 fontfile 即可；再加 font=family 反而可能因 FFmpeg 匹配不到而方块
    return `fontfile='${escapeFontFile(resolved.path)}'`;
  }
  return `fontfile='':font='${effectiveName}'`;
}

export interface EnhancementResult {
  /** 追加到 filter_complex 末尾的滤镜段（不含前导分号） */
  filterSuffix: string;
  /** 最终视频输出标签 */
  videoOut: string;
  /** 最终音频输出标签 */
  audioOut: string;
  /** 额外 -i 输入参数（如 BGM 文件路径） */
  extraInputs: string[];
  /** 额外输入数量（用于计算 BGM 的 input index） */
  extraInputCount: number;
  /** 渲染前需写入本地的文件（ass 字幕） */
  artifacts: Array<{ path: string; content: string }>;
}

export interface EnhancementOptions {
  subtitleStyle?: SubtitleStyleConfig;
  /** 已解析为单曲的 BGM（含 url）；多候选请先 pickRandomBgmTrack */
  bgm?: BgmConfig;
  titleCards?: TitleCardConfig[];
  /** 免责声明/剧集提示条配置 */
  disclaimer?: DisclaimerConfig;
  /** 渲染切条（用于字幕时间轴重映射） */
  renderClips: RenderClipForSubtitle[];
  /** 成片高度（px），用于字号/边距缩放 */
  outputHeight: number;
  /** 工作目录，ass 文件写入此处 */
  workDir: string;
  /** 已下载到本地的 BGM 文件路径（外部下载后传入） */
  bgmLocalPath?: string;
  /** 主滤镜图视频输出标签（默认 vout） */
  baseVideoLabel?: string;
  /** 主滤镜图音频输出标签（默认 acat；xfade 实为 axN） */
  baseAudioLabel?: string;
  /** 成片总时长（秒），用于免责声明从开头显示到结尾 */
  outputDurationSec?: number;
  /** 短剧名，用于替换标题花字中的 ${dramaTitle} 占位符 */
  dramaTitle?: string;
  /** 当前成片在批次中的输出序号，用于角标随机模式稳定判定 */
  outputIndex?: number;
  /** 整剧总成片数，用于花字按整剧比例出现 */
  totalOutputs?: number;
  /** 右上角角标配置（旧版兼容） */
  cornerWatermark?: CornerWatermarkConfig;
  /** 多角标配置（优先） */
  cornerWatermarks?: CornerWatermarkConfig[];
  /** 新增花字配置（与现有功能独立） */
  wordArt?: WordArtConfig;
  /** 贴花/花字模板系统配置（与现有功能独立） */
  stickers?: StickerConfig;
  /** ASR 片段，用于贴花按场景自动匹配 */
  segments?: import("@clip/sdk").AsrSegment[];
  /** 字体注册表，用于校验和解析白名单字体 */
  fontRegistry?: FontRegistry;
  /** 贴花模板注册表，用于解析和匹配模板 */
  stickerRegistry?: StickerRegistry;
}

/** 收集可用 BGM URL（tracks 优先，否则回退旧 url） */
export function listBgmTrackUrls(bgm?: BgmConfig | null): BgmTrackConfig[] {
  if (!bgm) return [];
  const out: BgmTrackConfig[] = [];
  if (Array.isArray(bgm.tracks)) {
    for (const t of bgm.tracks) {
      const url = typeof t?.url === "string" ? t.url.trim() : "";
      if (!url) continue;
      out.push({ url, name: t.name?.trim() || undefined });
    }
  }
  if (!out.length && typeof bgm.url === "string" && bgm.url.trim()) {
    out.push({ url: bgm.url.trim() });
  }
  return out;
}

/** 渲染前随机选一首；返回带单 url 的配置供下载/混音 */
export function pickRandomBgmTrack(
  bgm?: BgmConfig | null,
  random: () => number = Math.random,
): BgmConfig | undefined {
  if (!bgm?.enabled) return undefined;
  const tracks = listBgmTrackUrls(bgm);
  if (!tracks.length) return undefined;
  const idx = Math.min(tracks.length - 1, Math.max(0, Math.floor(random() * tracks.length)));
  const picked = tracks[idx]!;
  return {
    enabled: true,
    url: picked.url,
    volume: bgm.volume,
    fadeInSec: bgm.fadeInSec,
    fadeOutSec: bgm.fadeOutSec,
    loop: bgm.loop,
  };
}

/** #RRGGBB / 0xRRGGBB / 裸 RRGGBB → drawtext 的 0xRRGGBB */
export function normalizeDrawtextColor(color: string | undefined, fallback: string): string {
  const raw = (color ?? "").trim();
  if (!raw) return fallback.startsWith("0x") ? fallback : `0x${fallback.replace(/^#/, "")}`;
  const hex = raw.replace(/^0x/i, "").replace(/^#/, "");
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) return `0x${hex.toUpperCase()}`;
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return `0x${hex.slice(2).toUpperCase()}`; // 丢掉 alpha
  return raw;
}

/** 把十六进制字符串转成纯数字 0xRRGGBB（用于 FFmpeg expr 中） */
function hexToNumber(hex: string): number {
  const clean = hex.replace(/^0x/i, "").replace(/^#/, "").slice(0, 6);
  return parseInt(clean, 16) || 0;
}

/** 生成 0xRRGGBB 颜色，并在 RGB 三个通道上按系数缩放（factor>1 变亮，<1 变暗） */
function shadeColor(hex: string, factor: number): string {
  const n = hexToNumber(hex);
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)));
  const r = clamp((n >> 16) & 0xff);
  const g = clamp((n >> 8) & 0xff);
  const b = clamp(n & 0xff);
  return `0x${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
}

const DEFAULT_DISCLAIMER_LINES = [
  "热门短剧 影视效果 请勿模仿",
  "本故事纯属虚构 请树立正确价值观",
  "热门短剧 剧情虚构 无不良引导",
  "热门短剧 本故事纯属虚构",
  "剧情纯属虚构 请勿模仿",
  "剧情演绎纯属虚构 爆款短剧 正在热播",
];

function splitDisclaimerLines(text: string): string[] {
  return text
    .split(/\\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/** 估算字符串在指定字号下的像素宽度（按字符数保守估算，中文按字高，英文按半字高） */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    const half = code > 0x7f ? false : /[a-zA-Z0-9\s]/.test(ch);
    w += half ? fontSize * 0.55 : fontSize;
  }
  return Math.max(fontSize, Math.ceil(w));
}

/** 从数组中按 outputIndex 稳定选择一条，避免同批次每次渲染结果不同 */
function pickStableByIndex<T>(arr: T[], index: number): T {
  if (arr.length === 0) {
    throw new Error("Cannot pick from empty array");
  }
  return arr[Math.abs(index) % arr.length];
}

function shouldApplyCornerWatermark(
  cfg: CornerWatermarkConfig | undefined,
  outputIndex: number,
): boolean {
  if (!cfg) return false;
  if (cfg.enabled === false || cfg.mode === "none" || cfg.style === "none") return false;
  if (cfg.mode === "random") {
    const ratio = Math.max(0, Math.min(1, cfg.randomRatio ?? 0.5));
    const seed = cfg.randomSeed ?? 0;
    const r = Math.abs(Math.sin((seed + outputIndex * 17.37) * 9973.1)) % 1;
    return r < ratio;
  }
  return true;
}

/** 按垂直位置返回 y 表达式字符串 */
function buildYExpr(position: "top" | "center" | "bottom" | undefined, marginV: number, textHeightExpr = "text_h"): string {
  switch (position) {
    case "bottom":
      return `h-${textHeightExpr}-${marginV}`;
    case "center":
      return `(h-${textHeightExpr})/2`;
    default:
      return `${marginV}`;
  }
}

/** 生成 color 源滤镜字符串（无输入 pad，纯源） */
function colorSource(
  color: string,
  alpha: number,
  width: number,
  height: number,
  duration: number,
): string {
  const hex = color.replace(/^0x/, "").toUpperCase();
  // color 滤镜本身没有 format 选项，必须后接 format 滤镜才能保留 alpha 通道
  return `color=c=0x${hex}@${alpha.toFixed(2)}:s=${width}x${height}:d=${duration},format=yuva420p`;
}

/** 把 0xRRGGBB 与 alpha 转为 drawtext boxcolor 可接受的 0xRRGGBBAA */
function boxColorWithAlpha(color: string, alpha: number): string {
  const hex = color.replace(/^0x/i, "").replace(/^#/, "").toUpperCase().slice(0, 6);
  const aa = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `0x${hex}${aa}`;
}

/** 返回不带 alpha 的 0xRRGGBB */
function stripAlpha(color: string): string {
  return normalizeDrawtextColor(color, "0x000000");
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

function positionOverlayExprs(position: CornerWatermarkPosition, margin: number): { x: string; y: string } {
  switch (position) {
    case "top-left":
      return { x: `${margin}`, y: `${margin}` };
    case "center-left":
      return { x: `${margin}`, y: "(H-h)/2" };
    case "bottom-left":
      return { x: `${margin}`, y: `H-h-${margin}` };
    case "top-right":
      return { x: `W-w-${margin}`, y: `${margin}` };
    case "center-right":
      return { x: `W-w-${margin}`, y: "(H-h)/2" };
    case "bottom-right":
      return { x: `W-w-${margin}`, y: `H-h-${margin}` };
    default:
      return { x: `W-w-${margin}`, y: `${margin}` };
  }
}

function defaultRotationForPosition(position: CornerWatermarkPosition): number {
  switch (position) {
    case "top-left":
    case "center-left":
      return -30;
    case "bottom-left":
    case "bottom-right":
      return 15;
    case "top-right":
    case "center-right":
    default:
      return 30;
  }
}

/** 将 color 源 + 可选 drawtext 居中文字 + 旋转，贴到主视频指定位置。
 * markExpr 必须以输出标签 [${outputVideoLabel}_src] 结束。 */
function overlayToPosition(
  markExpr: string,
  inputVideoLabel: string,
  outputVideoLabel: string,
  margin: number,
  rotationRad: number,
  position: import("@clip/sdk").CornerWatermarkPosition,
): string {
  const rotateExpr = `${rotationRad}`;
  const { x, y } = positionOverlayExprs(position, margin);
  return (
    `${markExpr};` +
    `[${outputVideoLabel}_src]format=yuva420p,` +
    `rotate=${rotateExpr}:c=0x00000000:ow=rotw(${rotateExpr}):oh=roth(${rotateExpr})[${outputVideoLabel}_mark];` +
    `[${inputVideoLabel}][${outputVideoLabel}_mark]overlay=` +
    `x=${x}:y=${y}:enable='gte(t,0)'[${outputVideoLabel}]`
  );
}

/** 估算文字背景矩形尺寸 */
function textBoxSize(text: string, fontSize: number, paddingX: number, paddingY: number): { w: number; h: number } {
  const w = Math.max(80, estimateTextWidth(text, fontSize) + paddingX * 2);
  const h = Math.max(60, fontSize + paddingY * 2);
  return { w, h };
}

/**
 * 构建多层文字，模拟外发光或立体效果。
 * 每一层从上一层输入，最后主文字层输出到 outputLabel。
 */
function buildLayeredText(
  inputLabel: string,
  outputLabel: string,
  options: {
    fontSpec: string;
    fontSize: number;
    text: string;
    xExpr: string;
    yExpr: string;
    color: string;
    outlineColor: string;
    layers: Array<{ color: string; alpha?: number; borderw?: number }>;
    boxColor?: string;
    borderw?: number;
  },
): string {
  const { fontSpec, fontSize, text, xExpr, yExpr, color, outlineColor, layers, boxColor, borderw = 0 } = options;
  const escapedText = escapeDrawtext(text);
  const parts: string[] = [];
  let current = inputLabel;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const alpha = layer.alpha ?? 1;
    const layerBorderw = layer.borderw ?? Math.max(2, Math.round(fontSize * (0.12 + i * 0.08)));
    const baseColor = stripAlpha(layer.color);
    const fontColor = alpha < 1 ? withAlpha(baseColor, alpha) : baseColor;
    const nextLabel = `${outputLabel}_glow${i}`;
    parts.push(
      `[${current}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${fontColor}:` +
      `bordercolor=${baseColor}:borderw=${layerBorderw}:text='${escapedText}':x=${xExpr}:y=${yExpr}:` +
      `enable='gte(t,0)'[${nextLabel}]`,
    );
    current = nextLabel;
  }

  const mainColor = stripAlpha(color);
  const mainOutlineColor = stripAlpha(outlineColor);
  const mainBoxPart = boxColor ? `:box=1:boxcolor=${boxColor}` : "";
  parts.push(
    `[${current}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${mainColor}:` +
    `bordercolor=${mainOutlineColor}:borderw=${borderw}:text='${escapedText}':x=${xExpr}:y=${yExpr}` +
    `${mainBoxPart}:enable='gte(t,0)'[${outputLabel}]`,
  );

  return parts.join(";");
}

/**
 * 构建通用外发光花字：
 * 在指定颜色画布上绘制文字，把文字 alpha 通道模糊，叠加到主视频对应位置，再叠加主文字。
 * 返回可直接拼入 filter_complex 的滤镜字符串（产生 outputVideoLabel 标签）。
 */
export interface FancyTextGlowOptions {
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
  /** 是否仅显示在指定时间区间；提供后 overlay 添加 enable 表达式 */
  startSec?: number;
  endSec?: number;
}

function buildFancyTextGlow(options: FancyTextGlowOptions): string {
  const { fontSpec, fontSize, text, color, outlineColor, outlineWidth, glowColor, glowAlpha, xExpr, yExpr, inputVideoLabel, outputVideoLabel, duration, startSec, endSec } = options;
  const escapedText = escapeDrawtext(text);
  const glowHex = stripAlpha(glowColor).replace(/^0x/, "");
  const padding = Math.round(fontSize * 0.6);
  const { w: textW, h: textH } = textBoxSize(text, fontSize, padding, padding);
  const timeEnable = buildTimeEnable(startSec, endSec);

  // 发光透明度为 0 时不生成光晕层，仅渲染描边主文字，避免残留色块
  if (glowAlpha <= 0) {
    return (
      `[${inputVideoLabel}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
      `bordercolor=${outlineColor}:borderw=${outlineWidth}:text='${escapedText}':` +
      `x=${xExpr}:y=${yExpr}${timeEnable}[${outputVideoLabel}]`
    );
  }

  const glowW = textW + fontSize * 2;
  const glowH = textH + fontSize * 2;
  const glowTextX = "(w-text_w)/2";
  const glowTextY = "(h-text_h)/2";
  // overlay 中主视频宽高是 W/H，drawtext 中是 w/h；把表达式换算成基于 W/H 和估算文字尺寸
  const toOverlayExpr = (expr: string) =>
    expr.replace(/\bw\b/g, "W").replace(/\bh\b/g, "H").replace(/text_w/g, `${textW}`).replace(/text_h/g, `${textH}`);
  const glowX = `${toOverlayExpr(xExpr)}-${fontSize}`;
  const glowY = `${toOverlayExpr(yExpr)}-${fontSize}`;
  // 用 glow 色做画布，画上文字后取 alpha 模糊，形成光晕
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

/** 构建时间区间 enable 表达式；未指定则全程显示 */
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

/**
 * 构建通用立体描边花字：多层错位描边 + 主文字。
 */
export interface FancyStroke3dOptions {
  fontSpec: string;
  fontSize: number;
  text: string;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  xExpr: string;
  yExpr: string;
  inputVideoLabel: string;
  outputVideoLabel: string;
  shadowColor?: string;
  startSec?: number;
  endSec?: number;
}

function buildFancyStroke3d(options: FancyStroke3dOptions): string {
  const { fontSpec, fontSize, text, color, outlineColor, outlineWidth, xExpr, yExpr, inputVideoLabel, outputVideoLabel, shadowColor, startSec, endSec } = options;
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

/**
 * 构建标题花字，与免责声明共享样式模板：
 * standard=标准描边；bar=高对比条；glow=外发光；stroke3d=3D立体描边；vertical=竖排。
 */
function buildTitleCard(
  card: TitleCardConfig,
  options: Pick<EnhancementOptions, "outputHeight" | "outputDurationSec" | "fontRegistry">,
  inputVideoLabel: string,
  outputVideoLabel: string,
): string {
  const scale = options.outputHeight / 1080;
  const fontSize = Math.round((card.fontSize ?? 64) * scale);
  const marginV = Math.round((card.marginV ?? 60) * scale);
  const baseOutlineWidth = Math.max(1, Math.round((card.outlineWidth ?? 3) * scale));
  const color = normalizeDrawtextColor(card.color, "0xFFD700");
  const outlineColor = normalizeDrawtextColor(card.outlineColor, "0x000000");
  const backgroundColor = normalizeDrawtextColor(card.backgroundColor, "0x000000");
  const backgroundAlpha = Math.max(0, Math.min(1, card.backgroundAlpha ?? 0.35));
  const fontName = card.fontName?.trim() || getDefaultFontFamily(options.fontRegistry);
  const fontSpec = buildDrawtextFontSpec(fontName, options.fontRegistry);
  const text = String(card.text ?? "").trim();
  const position = card.position ?? "top";
  const yExpr = buildYExpr(position, marginV);
  const xExpr = "(w-text_w)/2";
  const style: TitleCardStyle = card.style ?? "standard";
  const duration = Math.max(1, Math.ceil(options.outputDurationSec ?? 120));
  const escapedText = escapeDrawtext(text);
  const hasBg = backgroundAlpha > 0;
  const userBg = hasBg ? boxColorWithAlpha(backgroundColor, backgroundAlpha) : undefined;

  switch (style) {
    case "glow": {
      return buildFancyTextGlow({
        fontSpec,
        fontSize,
        text,
        color,
        outlineColor,
        outlineWidth: baseOutlineWidth,
        glowColor: outlineColor,
        glowAlpha: backgroundAlpha,
        xExpr,
        yExpr,
        inputVideoLabel,
        outputVideoLabel,
        duration,
      });
    }
    case "stroke3d": {
      return buildFancyStroke3d({
        fontSpec,
        fontSize,
        text,
        color,
        outlineColor,
        outlineWidth: baseOutlineWidth,
        xExpr,
        yExpr,
        inputVideoLabel,
        outputVideoLabel,
      });
    }
    case "bar": {
      const paddingX = Math.round(fontSize * 0.55);
      const paddingY = Math.round(fontSize * 0.3);
      const { w: bgW, h: bgH } = textBoxSize(text, fontSize, paddingX, paddingY);
      const yTop = position === "bottom" ? `${options.outputHeight - bgH - marginV}` : `${marginV}`;
      const barBg =
        colorSource(backgroundColor, backgroundAlpha, bgW, bgH, duration) + "," +
        `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:` +
        `text='${escapedText}':x=(w-text_w)/2:y=(h-text_h)/2`;
      return (
        `${barBg},format=yuva420p[${outputVideoLabel}_bar];` +
        `[${inputVideoLabel}][${outputVideoLabel}_bar]overlay=` +
        `x=(W-w)/2:y=${yTop}:enable='gte(t,0)'[${outputVideoLabel}]`
      );
    }
    case "vertical": {
      const charSpacing = Math.round((card.charSpacing ?? 4) * scale);
      const chars = text.split("");
      const lineHeight = fontSize + charSpacing;
      const totalHeight = chars.length * lineHeight;
      let current = inputVideoLabel;
      const parts: string[] = [];
      for (let j = 0; j < chars.length; j++) {
        const ch = escapeDrawtext(chars[j]!);
        const yOffset = (j * lineHeight) - (totalHeight / 2) + (lineHeight / 2);
        const charYExpr = `((h-${Math.round(totalHeight)})/2+${Math.round(yOffset)})`;
        const nextLabel = j === chars.length - 1 ? outputVideoLabel : `${outputVideoLabel}_c${j}`;
        const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
        parts.push(
          `[${current}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
          `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${ch}':x=${xExpr}:y=${charYExpr}${boxPart}:enable='gte(t,0)'[${nextLabel}]`,
        );
        current = nextLabel;
      }
      return parts.join(";");
    }
    case "standard":
    default: {
      const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
      return (
        `[${inputVideoLabel}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
        `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${escapedText}':` +
        `x=${xExpr}:y=${yExpr}${boxPart}:enable='gte(t,0)'[${outputVideoLabel}]`
      );
    }
  }
}

/** 构建免责声明/提示条，支持 standard / bar / glow / vertical */
function buildDisclaimerLine(
  cfg: DisclaimerLineConfig,
  options: Pick<EnhancementOptions, "outputHeight" | "outputDurationSec" | "fontRegistry">,
  inputVideoLabel: string,
  outputVideoLabel: string,
): string {
  const scale = options.outputHeight / 1080;
  const fontSize = Math.round((cfg.fontSize ?? 28) * scale);
  const margin = Math.round((cfg.margin ?? 24) * scale);
  const baseOutlineWidth = Math.max(1, Math.round((cfg.outlineWidth ?? 2) * scale));
  const color = normalizeDrawtextColor(cfg.color, "0xFFFFFF");
  const outlineColor = normalizeDrawtextColor(cfg.outlineColor, "0x000000");
  const backgroundColor = normalizeDrawtextColor(cfg.backgroundColor, "0x000000");
  const backgroundAlpha = Math.max(0, Math.min(1, cfg.backgroundAlpha ?? 0.35));
  const fontName = cfg.fontName?.trim() || getDefaultFontFamily(options.fontRegistry);
  const fontSpec = buildDrawtextFontSpec(fontName, options.fontRegistry);
  const text = String(cfg.text ?? "").trim();
  const position = cfg.position ?? "bottom";
  const duration = Math.max(1, Math.ceil(options.outputDurationSec ?? 120));
  const style: DisclaimerLineStyle = cfg.style ?? "standard";
  const escapedText = escapeDrawtext(text);
  const hasBg = backgroundAlpha > 0;
  const userBg = hasBg ? boxColorWithAlpha(backgroundColor, backgroundAlpha) : undefined;

  let xExpr = "(w-text_w)/2";
  let yExpr = `h-text_h-${margin}`;
  const isVertical = position === "left" || position === "right";

  if (position === "top") yExpr = `${margin}`;
  else if (position === "bottom") yExpr = `h-text_h-${margin}`;
  else if (position === "left") { xExpr = `${margin}`; yExpr = "(h-text_h)/2"; }
  else if (position === "right") { xExpr = `w-text_w-${margin}`; yExpr = "(h-text_h)/2"; }

  if (isVertical && style === "vertical") {
    const charSpacing = Math.round((cfg.charSpacing ?? 4) * scale);
    const chars = text.split("");
    const lineHeight = fontSize + charSpacing;
    const totalHeight = chars.length * lineHeight;
    let current = inputVideoLabel;
    const parts: string[] = [];
    for (let j = 0; j < chars.length; j++) {
      const ch = escapeDrawtext(chars[j]!);
      const yOffset = (j * lineHeight) - (totalHeight / 2) + (lineHeight / 2);
      const charYExpr = `((h-${Math.round(totalHeight)})/2+${Math.round(yOffset)})`;
      const nextLabel = j === chars.length - 1 ? outputVideoLabel : `${outputVideoLabel}_c${j}`;
      const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
      parts.push(
        `[${current}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
        `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${ch}':x=${xExpr}:y=${charYExpr}${boxPart}:enable='gte(t,0)'[${nextLabel}]`,
      );
      current = nextLabel;
    }
    return parts.join(";");
  }

  if (style === "bar") {
    const paddingX = Math.round(fontSize * 0.5);
    const paddingY = Math.round(fontSize * 0.2);
    const { w: bgW, h: bgH } = textBoxSize(text, fontSize, paddingX, paddingY);
    const yTop = position === "bottom" ? `${options.outputHeight - bgH - margin}` : `${margin}`;
    const barBg =
      colorSource(backgroundColor, backgroundAlpha, bgW, bgH, duration) + "," +
      `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:` +
      `text='${escapedText}':x=(w-text_w)/2:y=(h-text_h)/2`;
    return (
      `${barBg},format=yuva420p[${outputVideoLabel}_bar];` +
      `[${inputVideoLabel}][${outputVideoLabel}_bar]overlay=` +
      `x=(W-w)/2:y=${yTop}:enable='gte(t,0)'[${outputVideoLabel}]`
    );
  }

  if (style === "glow") {
    return buildFancyTextGlow({
      fontSpec,
      fontSize,
      text,
      color,
      outlineColor,
      outlineWidth: baseOutlineWidth,
      glowColor: outlineColor,
      glowAlpha: backgroundAlpha,
      xExpr,
      yExpr,
      inputVideoLabel,
      outputVideoLabel,
      duration,
    });
  }

  // standard 默认
  const boxPart = userBg ? `:box=1:boxcolor=${userBg}:boxborderw=${Math.max(2, Math.round(fontSize * 0.15))}` : "";
  return (
    `[${inputVideoLabel}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${color}:` +
    `bordercolor=${outlineColor}:borderw=${baseOutlineWidth}:text='${escapedText}':` +
    `x=${xExpr}:y=${yExpr}${boxPart}:enable='gte(t,0)'[${outputVideoLabel}]`
  );
}

/**
 * 构建角标花字：所有样式都是带描边/发光/立体的花字，并贴到指定位置旋转。
 * style: glow=外发光, stroke3d=3D立体描边, ribbon=花字丝带, tape=花字胶带,
 *        badge=花字徽章, flag=花字旗帜, pulsing=呼吸闪烁花字, standard=描边花字。
 */
function buildCornerWatermark(
  cfg: CornerWatermarkConfig,
  options: Pick<EnhancementOptions, "outputHeight" | "outputIndex" | "outputDurationSec" | "fontRegistry">,
  inputVideoLabel: string,
  outputVideoLabel: string,
): string {
  const scale = options.outputHeight / 1080;
  const fontSize = Math.round((cfg.fontSize ?? 48) * scale);
  const margin = Math.round((cfg.margin ?? 24) * scale);
  const position = cfg.position ?? "top-right";
  const rotationDeg = cfg.rotation ?? defaultRotationForPosition(position);
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const text = String(cfg.text ?? "").trim() || "热门短剧";
  const bgColor = normalizeDrawtextColor(cfg.backgroundColor, "0xFF0000");
  const fontColor = normalizeDrawtextColor(cfg.color, "0xFFFFFF");
  const outlineColor = normalizeDrawtextColor(cfg.outlineColor, "0x000000");
  const bgAlpha = Math.max(0, Math.min(1, cfg.backgroundAlpha ?? 1));
  const outlineWidth = Math.max(1, Math.round((cfg.outlineWidth ?? 2) * scale));
  const fontName = cfg.fontName?.trim() || getDefaultFontFamily(options.fontRegistry);
  const fontSpec = buildDrawtextFontSpec(fontName, options.fontRegistry);
  const duration = Math.max(1, Math.ceil(options.outputDurationSec ?? 120));
  const style: CornerWatermarkStyle = cfg.style ?? "ribbon";
  const escapedText = escapeDrawtext(text);

  const paddingX = Math.round(fontSize * 0.45);
  const paddingY = Math.round(fontSize * 0.35);
  const { w: textW, h: textH } = textBoxSize(text, fontSize, paddingX, paddingY);
  // 画布在文字四周留够描边/旋转余量
  const canvasW = Math.round(textW + fontSize * 1.5);
  const canvasH = Math.round(textH + fontSize * 1.2);
  const centerX = "(w-text_w)/2";
  const centerY = "(h-text_h)/2";

  // 基础花字文字：描边 + 主文字，画在透明背景上
  const baseTextDraw =
    `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${fontColor}:` +
    `bordercolor=${outlineColor}:borderw=${outlineWidth}:` +
    `text='${escapedText}':x=${centerX}:y=${centerY}`;

  // 根据外形生成不同样式的花字画布
  let markExpr: string;
  switch (style) {
    case "glow": {
      // 外发光花字：透明画布 + 发光层 + 主文字
      const glowHex = stripAlpha(outlineColor).replace(/^0x/, "");
      const glowW = textW + fontSize * 2;
      const glowH = textH + fontSize * 2;
      const glowCanvasW = Math.max(canvasW, glowW + Math.round(fontSize * 0.5));
      const glowCanvasH = Math.max(canvasH, glowH + Math.round(fontSize * 0.5));
      const glowX = `(w-${glowW})/2`;
      const glowY = `(h-${glowH})/2`;
      const glowAlpha = Math.max(0, Math.min(1, bgAlpha || 0.75));
      const glowBlur = Math.max(2, Math.round(fontSize * 0.25));
      if (glowAlpha <= 0) {
        // 不需要发光层时直接退化为标准描边花字，避免透明色块残留
        markExpr =
          `color=c=0x00000000:s=${glowCanvasW}x${glowCanvasH}:d=${duration},` +
          `${baseTextDraw}[${outputVideoLabel}_src]`;
      } else {
        markExpr =
          `color=c=0x00000000:s=${glowCanvasW}x${glowCanvasH}:d=${duration},` +
          `${baseTextDraw}[${outputVideoLabel}_txt];` +
          `color=c=0x${glowHex}@${glowAlpha.toFixed(2)}:s=${glowW}x${glowH}:d=${duration},` +
          `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=0x${glowHex}:` +
          `bordercolor=0x${glowHex}:borderw=${Math.max(2, Math.round(outlineWidth * 1.5))}:` +
          `text='${escapedText}':x=(w-text_w)/2:y=(h-text_h)/2,` +
          `format=yuva420p,boxblur=${glowBlur}:${glowBlur}:1[${outputVideoLabel}_glow];` +
          `[${outputVideoLabel}_txt][${outputVideoLabel}_glow]overlay=` +
          `x=${glowX}:y=${glowY}:enable='gte(t,0)'[${outputVideoLabel}_src]`;
      }
      break;
    }
    case "stroke3d": {
      // 3D立体描边花字：多层错位描边 + 主文字
      const shadowColor = shadeColor(outlineColor, 0.5);
      const offset = Math.max(2, Math.round(fontSize * 0.06));
      const parts: string[] = [];
      parts.push(`color=c=0x00000000:s=${canvasW}x${canvasH}:d=${duration}[${outputVideoLabel}_base]`);
      for (let i = 3; i >= 1; i--) {
        const step = i * offset;
        const layerColor = i === 1 ? fontColor : (i === 2 ? outlineColor : shadowColor);
        const label = i === 1 ? `${outputVideoLabel}_src` : `${outputVideoLabel}_s${i}`;
        const nextInput = i === 3 ? `${outputVideoLabel}_base` : `${outputVideoLabel}_s${i + 1}`;
        parts.push(
          `[${nextInput}]drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${layerColor}:` +
          `bordercolor=${outlineColor}:borderw=${outlineWidth}:text='${escapedText}':` +
          `x=${centerX}+${step}:y=${centerY}+${step}:enable='gte(t,0)'[${label}]`,
        );
      }
      markExpr = parts.join(";");
      break;
    }
    case "tape": {
      // 胶带花字：长条背景 + 描边文字
      const tapeW = textW + Math.round(fontSize * 0.8);
      const tapeH = textH + Math.round(fontSize * 0.5);
      markExpr =
        colorSource(bgColor, bgAlpha, tapeW, tapeH, duration) + "," +
        `${baseTextDraw}[${outputVideoLabel}_src]`;
      break;
    }
    case "badge": {
      // 徽章花字：圆形背景 + 描边文字
      const badgeSize = Math.max(textW, textH) + Math.round(fontSize * 0.8);
      markExpr =
        colorSource(bgColor, bgAlpha, badgeSize, badgeSize, duration) + "," +
        `${baseTextDraw}[${outputVideoLabel}_src]`;
      break;
    }
    case "flag": {
      // 旗帜花字：背景条 + 描边文字
      const flagW = textW + Math.round(fontSize * 1.2);
      const flagH = textH + Math.round(fontSize * 0.6);
      markExpr =
        colorSource(bgColor, bgAlpha, flagW, flagH, duration) + "," +
        `${baseTextDraw}[${outputVideoLabel}_src]`;
      break;
    }
    case "pulsing": {
      // 呼吸闪烁花字：文字透明度随时间正弦波动
      markExpr =
        `color=c=0x00000000:s=${canvasW}x${canvasH}:d=${duration},` +
        `drawtext=${fontSpec}:fontsize=${fontSize}:fontcolor=${fontColor}:` +
        `bordercolor=${outlineColor}:borderw=${outlineWidth}:` +
        `text='${escapedText}':x=${centerX}:y=${centerY}:` +
        `alpha=0.5+0.5*sin(t*3)[${outputVideoLabel}_src]`;
      break;
    }
    case "standard": {
      // 标准描边花字
      markExpr =
        `color=c=0x00000000:s=${canvasW}x${canvasH}:d=${duration},` +
        `${baseTextDraw}[${outputVideoLabel}_src]`;
      break;
    }
    case "ribbon":
    default: {
      // 丝带花字：背景色块 + 描边文字
      markExpr =
        colorSource(bgColor, bgAlpha, textW + Math.round(fontSize * 0.4), textH + Math.round(fontSize * 0.3), duration) + "," +
        `${baseTextDraw}[${outputVideoLabel}_src]`;
    }
  }

  return overlayToPosition(markExpr, inputVideoLabel, outputVideoLabel, margin, rotationRad, position);
}

/** 构建字幕/BGM/标题花字增强滤镜；无任何增强时返回 null */
export function buildRenderEnhancements(options: EnhancementOptions): EnhancementResult | null {
  const parts: string[] = [];
  let videoIn = options.baseVideoLabel?.trim() || "vout";
  let audioIn = options.baseAudioLabel?.trim() || "acat";
  const artifacts: Array<{ path: string; content: string }> = [];
  const extraInputs: string[] = [];
  let extraInputCount = 0;

  // 字幕烧录
  const subStyle = options.subtitleStyle;
  const subEnabled = subStyle?.enabled !== false;
  if (subEnabled && subStyle && options.renderClips.length) {
    const entries = remapClipsToTimeline(options.renderClips);
    if (entries.length) {
      const assPath = `${options.workDir}/subtitle.ass`.replace(/\\/g, "/");
      const assContent = buildAssSubtitle(entries, {
        style: subStyle,
        outputHeight: options.outputHeight,
        fontRegistry: options.fontRegistry,
      });
      artifacts.push({ path: assPath, content: assContent });
      const escapedAssPath = assPath.replace(/:/g, "\\:");
      const label = "vsub";
      // 优先使用白名字体目录渲染 ASS；无注册表时回退 Windows 系统字体目录
      const fontsDir = options.fontRegistry
        ? options.fontRegistry.dir.replace(/:/g, "\\:").replace(/\\/g, "/")
        : "C:/Windows/Fonts".replace(/:/g, "\\:").replace(/\\/g, "/");
      parts.push(`[${videoIn}]subtitles='${escapedAssPath}':charenc=UTF-8:fontsdir='${fontsDir}'[${label}]`);
      videoIn = label;
    }
  }

  // 标题花字：默认每成片只选一条（one_random），只有显式 all 才全部叠加
  const rawCards = options.titleCards ?? [];
  const dramaTitle = options.dramaTitle?.trim() || "";
  const activeCards: TitleCardConfig[] = rawCards
    .filter((c) => c.text?.trim())
    .map((card) => ({
      ...card,
      text: dramaTitle ? card.text.replace(/\$\{dramaTitle\}/g, dramaTitle) : card.text,
    }));
  if (activeCards.length > 0) {
    const titleCardMode = activeCards.some((c) => c.mode === "all") ? "all" : "one_random";
    const chosenCards = titleCardMode === "all" ? activeCards : [pickStableByIndex(activeCards, options.outputIndex ?? 0)];
    for (let i = 0; i < chosenCards.length; i++) {
      const card = chosenCards[i]!;
      const label = `vcard${i}`;
      const subParts = buildTitleCard(card, options, videoIn, label);
      if (subParts) {
        parts.push(subParts);
        videoIn = label;
      }
    }
  }

  // 免责声明/剧集提示条：默认每成片只选一条（one_random），round_robin 按序号轮询，all 全部叠加
  const disclaimer = options.disclaimer;
  if (disclaimer?.enabled) {
    const label = "vdisclaimer";
    const defaultLines = disclaimer.defaultLines?.length
      ? disclaimer.defaultLines
      : DEFAULT_DISCLAIMER_LINES;

    let lineCfgs: DisclaimerLineConfig[] = [];
    if (Array.isArray(disclaimer.lines) && disclaimer.lines.length > 0) {
      lineCfgs = disclaimer.lines.filter((l) => l.enabled !== false);
    }

    if (lineCfgs.length === 0) {
      const allPositions: Array<"top" | "bottom" | "left" | "right"> = ["top", "bottom", "left", "right"];
      const randomPosition = allPositions[Math.floor(Math.random() * allPositions.length)];
      const randomText = defaultLines[Math.floor(Math.random() * defaultLines.length)] || "";
      lineCfgs = [
        {
          text: randomText,
          enabled: true,
          position: randomPosition,
        } as DisclaimerLineConfig,
      ];
    }

    if (lineCfgs.length > 0) {
      const disclaimerMode = disclaimer.mode ?? "one_random";
      const chosenLines = disclaimerMode === "all"
        ? lineCfgs
        : disclaimerMode === "round_robin"
          ? [lineCfgs[Math.abs(options.outputIndex ?? 0) % lineCfgs.length]!]
          : [pickStableByIndex(lineCfgs, options.outputIndex ?? 0)];

      for (let i = 0; i < chosenLines.length; i++) {
        const cfg = chosenLines[i]!;
        const rawText = (cfg.text ?? "").trim();
        const text = rawText || defaultLines[Math.floor(Math.random() * defaultLines.length)] || "";
        if (!text) continue;

        const lineLabel = i === chosenLines.length - 1 ? label : `vdisclaimer${i}`;
        const inputLabel = i === 0 ? videoIn : `vdisclaimer${i - 1}`;
        const subParts = buildDisclaimerLine({ ...cfg, text }, options, inputLabel, lineLabel);
        if (subParts) {
          parts.push(subParts);
          if (i === 0) videoIn = lineLabel;
        }
      }
      videoIn = label;
    }
  }

  // 多角标支持：优先 cornerWatermarks 数组，否则回退旧版单条 cornerWatermark
  // 每成片只从全部角标配置中随机/稳定选一条，忽略单个角标的 mode
  const cornerWmList: CornerWatermarkConfig[] = options.cornerWatermarks?.length
    ? options.cornerWatermarks
    : options.cornerWatermark
      ? [options.cornerWatermark]
      : [];
  if (cornerWmList.length > 0) {
    const enabledWms = cornerWmList.filter((wm) => wm.enabled !== false);
    if (enabledWms.length > 0) {
      const chosenWm = pickStableByIndex(enabledWms, options.outputIndex ?? 0);
      parts.push(buildCornerWatermark(chosenWm, options, videoIn, "vcornerwm"));
      videoIn = "vcornerwm";
    }
  }

  // 新增花字：与 titleCards/disclaimer/cornerWatermark 独立，按 appearanceRatio 与整剧总数控制出现
  if (options.wordArt?.enabled && options.wordArt.items?.length) {
    const wordArtFilter = buildWordArtFilter({
      config: options.wordArt,
      outputHeight: options.outputHeight,
      outputDurationSec: options.outputDurationSec ?? 120,
      fontRegistry: options.fontRegistry,
      baseVideoLabel: videoIn,
      outputVideoLabel: "vwordart",
      dramaTitle: options.dramaTitle,
      outputIndex: options.outputIndex,
      totalOutputs: options.totalOutputs,
    });
    if (wordArtFilter) {
      parts.push(wordArtFilter);
      videoIn = "vwordart";
    }
  }

  // 贴花/花字模板：与 titleCards/disclaimer/cornerWatermark/wordArt 独立，支持手动叠加和自动匹配
  if (options.stickers?.enabled && options.stickerRegistry) {
    const stickerResult = buildStickerOverlayFilter({
      config: options.stickers,
      stickerRegistry: options.stickerRegistry,
      outputHeight: options.outputHeight,
      outputDurationSec: options.outputDurationSec ?? 120,
      baseVideoLabel: videoIn,
      outputVideoLabel: "vstickers",
      dramaTitle: options.dramaTitle,
      outputIndex: options.outputIndex,
      segments: options.segments,
    });
    if (stickerResult) {
      parts.push(stickerResult.filterSuffix);
      videoIn = stickerResult.videoOut;
      extraInputs.push(...stickerResult.extraInputs);
      extraInputCount += stickerResult.extraInputs.filter((a) => a === "-i").length;
    }
  }

  // BGM 混音
  const bgm = options.bgm;
  if (bgm?.enabled && bgm.url && options.bgmLocalPath) {
    extraInputs.push("-i", options.bgmLocalPath);
    const bgmInputIndex = "__BGM_INPUT_INDEX__";
    const volume = bgm.volume ?? 0.25;
    const fadeIn = bgm.fadeInSec ?? 1;
    const loop = bgm.loop !== false;
    const afFilters = [`volume=${volume}`];
    if (fadeIn > 0) afFilters.push(`afade=t=in:st=0:d=${fadeIn}`);
    const label = `abgm${extraInputCount}`;
    parts.push(
      `[${bgmInputIndex}:a]${loop ? "aloop=loop=-1:size=2e9," : ""}${afFilters.join(",")}[${label}]`,
    );
    const mixLabel = `amix${extraInputCount}`;
    parts.push(`[${audioIn}][${label}]amix=inputs=2:duration=first:dropout_transition=0[${mixLabel}]`);
    audioIn = mixLabel;
    extraInputCount += 1;
  }

  if (parts.length === 0 && artifacts.length === 0) return null;

  return {
    filterSuffix: parts.join(";"),
    videoOut: videoIn,
    audioOut: audioIn,
    extraInputs,
    extraInputCount,
    artifacts,
  };
}
