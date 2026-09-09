import { existsSync } from "node:fs";
import type { SubtitleStyleConfig } from "@clip/sdk";
import type { FontRegistry } from "./font-registry.js";
import { getDefaultFontFamily, resolveEffectiveFontName, resolveFontFile as resolveBundledFontFile } from "./font-registry.js";


/** Windows 常见中文字体名到字体文件路径映射；ASS 字幕指定字体文件最稳。
 * 只列出当前 Agent 本机 C:\Windows\Fonts\ 下确实存在的字体文件。 */
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

/** 把字体名解析成本机字体文件路径和实际字体名；找不到时返回 undefined。
 * 优先使用字体注册表（白名单）；若白名单字体文件缺失，回退 Windows 系统字体映射。 */
function resolveFontFileWithName(
  fontName?: string,
  fontRegistry?: FontRegistry,
): { path: string; name: string } | undefined {
  const name = fontName?.trim();
  if (!name) return undefined;
  if (fontRegistry) {
    const bundled = resolveBundledFontFile(fontRegistry, name);
    if (bundled) return { path: bundled, name };
    // 优先按传入字体名精确匹配系统字体；未找到时回退到第一个可用的系统字体
    const exactCandidates = FONT_FILE_MAP[name];
    if (exactCandidates) {
      for (const p of exactCandidates) {
        if (existsSync(p)) {
          console.warn(`[subtitle] 字体 "${name}" 未命中白名单文件，回退系统字体 "${name}": ${p}`);
          return { path: p, name };
        }
      }
    }
    // 精确匹配未命中时，按顺序遍历第一个存在的系统字体，避免方块
    for (const [sysName, paths] of Object.entries(FONT_FILE_MAP)) {
      for (const p of paths) {
        if (existsSync(p)) {
          console.warn(`[subtitle] 字体 "${name}" 未命中白名单文件，回退系统字体 "${sysName}": ${p}`);
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

export interface RenderClipForSubtitle {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleEntry {
  startSec: number;
  endSec: number;
  text: string;
}

/** 把 renderClips（源时间戳）重映射到成片时间轴（从 0 连续累加） */
export function remapClipsToTimeline(clips: RenderClipForSubtitle[]): SubtitleEntry[] {
  let cursorSec = 0;
  const entries: SubtitleEntry[] = [];
  for (const clip of clips) {
    const durSec = Math.max(0, (clip.endMs - clip.startMs) / 1000);
    if (durSec <= 0) continue;
    const text = clip.text?.trim();
    if (text) {
      entries.push({ startSec: cursorSec, endSec: cursorSec + durSec, text });
    }
    cursorSec += durSec;
  }
  return entries;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ASS 时间格式：H:MM:SS.cc */
function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${pad2(m)}:${pad2(s)}.${String(c).padStart(2, "0")}`;
}

/** #RRGGBB -> ASS &H00BBGGRR */
function hexToAss(hex: string, defaultAss: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return defaultAss;
  const r = m[1]!.slice(0, 2);
  const g = m[1]!.slice(2, 4);
  const b = m[1]!.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

/** 解析 &HAABBGGRR 或 #RRGGBB 为 &H00BBGGRR */
function normalizeAssColor(raw: string | undefined, fallback: string): string {
  const s = (raw ?? "").trim();
  if (!s) return fallback;
  if (s.startsWith("&H")) return s;
  return hexToAss(s, fallback);
}

/** 对 &H00BBGGRR 颜色做亮度缩放，返回 ASS 颜色 */
function shadeAssColor(assColor: string, factor: number): string {
  const m = /^&H([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(assColor);
  if (!m) return assColor;
  const a = m[1]!;
  const b = parseInt(m[2]!, 16);
  const g = parseInt(m[3]!, 16);
  const r = parseInt(m[4]!, 16);
  const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n * factor)));
  return `&H${a}${clamp(b).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(r).toString(16).padStart(2, "0")}`.toUpperCase();
}

function resolveAlignment(pos: SubtitleStyleConfig["alignment"]): number {
  switch (pos) {
    case "top": return 8;
    case "center": return 5;
    default: return 2;
  }
}

/** 转义 ASS 文本中的特殊字符 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export interface BuildAssOptions {
  style: SubtitleStyleConfig;
  /** 成片高度（px），用于把 fontSize/marginV 按比例缩放 */
  outputHeight: number;
  /** 字体注册表；传入后字幕字体走白名单，未命中自动回退默认字体 */
  fontRegistry?: FontRegistry;
}

/** 生成完整 ASS 字幕文件内容 */
export function buildAssSubtitle(entries: SubtitleEntry[], options: BuildAssOptions): string {
  const s = options.style;
  const scale = options.outputHeight / 1080;
  const fontSize = Math.round((s.fontSize ?? 48) * scale);
  const marginV = Math.round((s.marginV ?? 80) * scale);
  const outlineWidth = Math.round((s.outlineWidth ?? 2) * scale);
  const primaryColor = normalizeAssColor(s.primaryColor, "&H00FFFFFF");
  const outlineColor = normalizeAssColor(s.outlineColor, "&H00000000");
  const effectiveFontName = resolveEffectiveFontName(options.fontRegistry, s.fontName);
  const alignment = resolveAlignment(s.alignment);
  const style: import("@clip/sdk").SubtitleStyle = s.style ?? "standard";
  // ASS 使用系统字体名；若白名单字体文件缺失，回退到 Windows 系统字体名
  const resolvedFont = resolveFontFileWithName(effectiveFontName, options.fontRegistry);
  const fontName = resolvedFont?.name ?? effectiveFontName;
  const fontFile = resolvedFont?.path;

  // 不同模板对应不同 Style：glow 用多层描边发光，stroke3d 用阴影错位，softshadow 用柔阴影
  const glowOuter = shadeAssColor(outlineColor, 1.5);
  const glowInner = shadeAssColor(primaryColor, 1.2);
  const shadow3d = "&H80000000";
  const shadowSoft = "&H60000000";

  const header = `[Script Info]
Title: Clip Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: ${options.outputHeight}
WrapStyle: 2
ScaledBorderAndShadow: yes
${fontFile ? `; Font path: ${fontFile}` : ""}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},${outlineColor},&H80000000,0,0,0,0,100,100,0,0,1,${outlineWidth},0,${alignment},40,40,${marginV},1
Style: GlowOuter,${fontName},${fontSize},${glowOuter},${glowOuter},&H00000000,0,0,0,0,100,100,0,0,1,${outlineWidth * 4},0,${alignment},40,40,${marginV},1
Style: GlowInner,${fontName},${fontSize},${glowInner},${glowInner},&H00000000,0,0,0,0,100,100,0,0,1,${outlineWidth * 2},0,${alignment},40,40,${marginV},1
Style: Shadow3d,${fontName},${fontSize},${shadow3d},${shadow3d},&H00000000,0,0,0,0,100,100,0,0,1,${outlineWidth},4,${alignment},40,40,${marginV},1
Style: SoftShadow,${fontName},${fontSize},${primaryColor},${outlineColor},${shadowSoft},0,0,0,0,100,100,0,0,1,${outlineWidth},8,${alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = entries
    .map((e) => {
      const text = escapeAssText(e.text);
      if (style === "glow") {
        return (
          `Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},GlowOuter,,0,0,0,,${text}\n` +
          `Dialogue: 1,${assTime(e.startSec)},${assTime(e.endSec)},GlowInner,,0,0,0,,${text}\n` +
          `Dialogue: 2,${assTime(e.startSec)},${assTime(e.endSec)},Default,,0,0,0,,${text}`
        );
      }
      if (style === "stroke3d") {
        return (
          `Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Shadow3d,,0,0,0,,${text}\n` +
          `Dialogue: 1,${assTime(e.startSec)},${assTime(e.endSec)},Default,,0,0,0,,${text}`
        );
      }
      if (style === "softshadow") {
        return `Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},SoftShadow,,0,0,0,,${text}`;
      }
      return `Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return header + events + "\n";
}
