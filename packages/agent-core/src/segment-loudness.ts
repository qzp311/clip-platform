import { spawn } from "node:child_process";
import type { AsrSegment, RawAsrSegment } from "@clip/sdk";

export interface SegmentLoudnessOptions {
  ffmpegPath?: string;
  /** 段短于此毫秒不探测（避免静音毛刺）；默认 200ms */
  minSegmentMs?: number;
  /** 单段探测超时（ms）；默认 15s */
  perSegmentTimeoutMs?: number;
}

export interface SegmentLoudness {
  rmsDb?: number;
  peakDb?: number;
  speechRate?: number;
}

/**
 * 估算文本字数（中文按字、英文按词），用于语速计算。
 */
export function estimateCharCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // 连续拉丁字母+数字视为一个词，其余按单字计
  const matched = trimmed.match(/[A-Za-z0-9]+/g);
  const wordCount = matched ? matched.length : 0;
  const nonLatin = trimmed.replace(/[A-Za-z0-9\s]/g, "").length;
  return wordCount + nonLatin;
}

/** 按段时长与文本字数估算语速（字/秒） */
export function estimateSpeechRate(text: string, durationMs: number): number | undefined {
  if (durationMs <= 0) return undefined;
  const chars = estimateCharCount(text);
  if (chars <= 0) return undefined;
  return Math.round((chars / durationMs) * 1000 * 10) / 10;
}

/**
 * 解析单次 ffmpeg astats stderr，提取 RMS / Peak dB。
 * astats 输出形如：
 *   RMS level dB:     -23.45
 *   Peak level dB:    -3.12
 */
export function parseAstatsOutput(stderr: string): { rmsDb?: number; peakDb?: number } {
  const rmsMatch = stderr.match(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/);
  const peakMatch = stderr.match(/Peak level dB:\s*(-?\d+(?:\.\d+)?)/);
  const rmsDb = rmsMatch ? Number.parseFloat(rmsMatch[1]!) : undefined;
  const peakDb = peakMatch ? Number.parseFloat(peakMatch[1]!) : undefined;
  return { rmsDb, peakDb };
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg astats timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg astats exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/**
 * 对单段音频探测响度：ffmpeg -ss start -t dur -i audio -af astats -f null -
 * astats 默认整体统计（length=0），输出单段 RMS/Peak。
 */
export async function probeSegmentLoudnessAt(
  audioPath: string,
  startMs: number,
  endMs: number,
  options: SegmentLoudnessOptions = {},
): Promise<SegmentLoudness> {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const perSegmentTimeoutMs = options.perSegmentTimeoutMs ?? 15_000;
  const startSec = Math.max(0, startMs / 1000);
  const durSec = Math.max(0.05, (endMs - startMs) / 1000);
  const args = [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(startSec),
    "-t",
    String(durSec),
    "-i",
    audioPath,
    "-af",
    "astats=metadata=1:reset=0",
    "-f",
    "null",
    "-",
  ];
  const stderr = await runFfmpeg(ffmpegPath, args, perSegmentTimeoutMs);
  const { rmsDb, peakDb } = parseAstatsOutput(stderr);
  return { rmsDb, peakDb };
}

/**
 * 批量探测各段响度并回填 rmsDb/peakDb/speechRate。
 * 对每段独立跑一次 astats（剧集音轨短，开销小）。
 * 失败的段静默跳过（不影响主流程）。
 */
export async function probeSegmentLoudnessBatch<T extends RawAsrSegment | AsrSegment>(
  audioPath: string,
  segments: T[],
  options: SegmentLoudnessOptions = {},
): Promise<T[]> {
  const minSegmentMs = options.minSegmentMs ?? 200;
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";

  const enriched = await Promise.all(
    segments.map(async (seg): Promise<T> => {
      const durationMs = seg.endMs - seg.startMs;
      const speechRate = estimateSpeechRate(seg.text, durationMs);
      if (durationMs < minSegmentMs) {
        return { ...seg, speechRate };
      }
      try {
        const { rmsDb, peakDb } = await probeSegmentLoudnessAt(
          audioPath,
          seg.startMs,
          seg.endMs,
          { ffmpegPath, perSegmentTimeoutMs: options.perSegmentTimeoutMs },
        );
        return { ...seg, rmsDb, peakDb, speechRate };
      } catch {
        return { ...seg, speechRate };
      }
    }),
  );
  return enriched;
}

/**
 * 声学分：响度越高分越高。
 * 阈值基于 16bit PCM / dBFS 经验值，后续可按真实素材标定。
 *   rmsDb >= -16 → 2（强爆发/怒吼）
 *   rmsDb >= -22 → 1（明显抬升）
 *   其余 → 0
 */
export function acousticScoreFromRms(rmsDb?: number): number {
  if (rmsDb == null) return 0;
  if (rmsDb >= -16) return 2;
  if (rmsDb >= -22) return 1;
  return 0;
}

/**
 * 常见 filler/语气词。命中不代表一定删除，但纯由这些词构成时该段无叙事价值。
 */
const FILLER_WORDS = [
  "嗯", "啊", "呃", "哦", "哎", "唉", "哟", "哼", "哈", "呵", "哇", "耶",
  "那个", "这个", "就是", "然后", "所以", "那么", "对吧", "是吧", "嗯哼",
  "啊这", "呃呃", "嗯嗯", "啊啊", "哦哦",
];

/** 回答类孤立语气词：会让成片突然冒出一句没有上下文的应答，显得突兀 */
const ANSWER_FILLER_PATTERN = /^(好的|好|是|是的|没错|对|对的|行|行吧|可以|知道了|明白了)[。！!\s…]*$/;

function normalizeForFiller(text: string): string {
  return text
    .replace(/[，。、？！!,?.…~\s]/g, "")
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();
}

/** 判断文本是否基本由 filler 词构成（字数极少且都是 filler） */
export function isFillerOnlyText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 10) return false;
  const norm = normalizeForFiller(t);
  if (!norm) return true;
  if (norm.length <= 2) return true;
  for (const w of FILLER_WORDS) {
    if (norm === w || (norm.includes(w) && norm.length <= w.length + 1)) return true;
  }
  return false;
}

/** 判断是否为孤立回答类语气词 */
export function isAnswerFillerText(text: string): boolean {
  return ANSWER_FILLER_PATTERN.test(text.trim());
}

export interface SegmentSilenceAndFiller {
  /** 前导静音（ms）：segment startMs 到真实开口之间 */
  leadingSilenceMs: number;
  /** 尾随静音（ms）：真实闭口到 segment endMs 之间 */
  trailingSilenceMs: number;
  /** 是否纯 filler/语气词 */
  isFillerOnly: boolean;
  /** 是否孤立回答类语气词 */
  isAnswerFiller: boolean;
}

/**
 * 按秒采样音频 RMS 能量（dB），用于 LLM 选段时提供情绪起伏参考。
 * 单进程实现：一次解码，astats 每窗口重置 + ametadata 把 RMS 打到 stdout，避免逐秒起 ffmpeg。
 */
export async function sampleAudioEnergyCurve(
  audioPath: string,
  durationSec: number,
  intervalSec = 1,
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<Array<{ sec: number; rmsDb: number }>> {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const step = Math.max(0.5, intervalSec);
  const args = [
    "-hide_banner", "-nostats",
    "-i", audioPath,
    "-af",
    `astats=metadata=1:reset=1:length=${step},ametadata=mode=print:file=-`,
    "-f", "null", "-",
  ];
  const points: Array<{ sec: number; rmsDb: number }> = [];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let buf = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("audio energy probe timeout")); }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => { buf += c.toString(); });
      child.stderr?.on("data", (c: Buffer) => { buf += c.toString(); });
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    // ametadata 输出形如（file=- 落在 stdout）：
    // frame:0    pts:0       pts_time:0
    // lavfi.astats.0.RMS_level=-23.45
    const re = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?\d+(?:\.\d+)?|-?inf)/g;
    const samples: Array<{ sec: number; rms: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const sec = Number.parseFloat(m[1]!);
      const rms = m[2] === "-inf" ? -60 : Number.parseFloat(m[2]!);
      samples.push({ sec, rms });
    }
    for (let t = 0; t < durationSec; t += step) {
      // 窗口内取最大 RMS（最能代表情绪峰值）
      let rmsDb = -60;
      for (const s of samples) {
        if (s.sec >= t && s.sec < t + step && s.rms > rmsDb) rmsDb = s.rms;
      }
      points.push({ sec: t, rmsDb });
    }
  } catch {
    // 提取失败不阻塞调用方，返回空曲线
    return [];
  }
  return points;
}

/**
 * 场景切换密度：单次解码跑 scdet，统计每 bucketSec 秒窗内镜头切换次数。
 * 高密度窗口 = 快节奏冲突场，供 LLM 判断节奏。
 */
export async function detectSceneCutDensity(
  videoPath: string,
  durationSec: number,
  bucketSec = 5,
  options: { ffmpegPath?: string; threshold?: number; timeoutMs?: number } = {},
): Promise<Array<{ sec: number; cuts: number }>> {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const threshold = options.threshold ?? 8;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const args = [
    "-hide_banner", "-nostats",
    "-i", videoPath,
    "-vf", `scdet=threshold=${threshold}`,
    "-an", "-f", "null", "-",
  ];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let buf = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("scene cut probe timeout")); }, timeoutMs);
      child.stderr?.on("data", (c: Buffer) => { buf += c.toString(); });
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    // scdet 输出形如: [scdet @ ...] ... pts_time:12.3 ...
    const times: number[] = [];
    const re = /pts_time[:=]([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const t = Number.parseFloat(m[1]!);
      if (Number.isFinite(t) && t >= 0 && t <= durationSec + 1) times.push(t);
    }
    const bucketCount = Math.max(1, Math.ceil(durationSec / bucketSec));
    const buckets: Array<{ sec: number; cuts: number }> = Array.from({ length: bucketCount }, (_, i) => ({
      sec: i * bucketSec,
      cuts: 0,
    }));
    for (const t of times) {
      const b = Math.min(bucketCount - 1, Math.floor(t / bucketSec));
      buckets[b]!.cuts++;
    }
    return buckets;
  } catch {
    return [];
  }
}

/**
 * 综合 ASR 段已有字段，计算静音与 filler 标签。
 * 不额外跑音频探测，依赖 ASR 模型已给出的 speechStartMs/speechEndMs 边界。
 */
export function classifySegmentSilenceAndFiller(seg: {
  startMs: number;
  endMs: number;
  text: string;
  speechStartMs?: number;
  speechEndMs?: number;
}): SegmentSilenceAndFiller {
  const onset = seg.speechStartMs ?? seg.startMs;
  const offset = seg.speechEndMs ?? seg.endMs;
  const leadingSilenceMs = Math.max(0, onset - seg.startMs);
  const trailingSilenceMs = Math.max(0, seg.endMs - offset);
  const isAnswerFiller = isAnswerFillerText(seg.text);
  // 孤立回答语气词属于另一类问题，不再标记为纯 filler
  const isFillerOnly = !isAnswerFiller && isFillerOnlyText(seg.text);
  return {
    leadingSilenceMs,
    trailingSilenceMs,
    isFillerOnly,
    isAnswerFiller,
  };
}
