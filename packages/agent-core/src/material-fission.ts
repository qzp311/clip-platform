/**
 * 素材裂变：本地 FFmpeg 单 pass 随机组合变换（调色/锐化/缩放/加速/抽帧/掐头去尾/镜像）
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { appendVideoEncodeArgs, resolveVideoCodec } from "./ffmpeg-encode.js";
import { isNvencRenderAvailable } from "./ffmpeg-capability.js";
import { probeVideoDurationMs } from "./ffmpeg-renderer.js";

export const FISSION_OP_KINDS = [
  "color",
  "sharpen",
  "zoom",
  "speed",
  "drop_frames",
  "trim_ends",
  "mirror",
] as const;

export type FissionOpKind = (typeof FISSION_OP_KINDS)[number];

export const FISSION_OP_LABELS: Record<FissionOpKind, string> = {
  color: "智能调色",
  sharpen: "画面锐化",
  zoom: "缩放画面",
  speed: "视频加速",
  drop_frames: "随机抽帧",
  trim_ends: "掐头去尾",
  mirror: "视频镜像",
};

export interface FissionColorParams {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface FissionZoomParams {
  factor: number;
}

export interface FissionSpeedParams {
  rate: number;
}

export interface FissionSharpenParams {
  amount: number;
}

export interface FissionTrimParams {
  headSec: number;
  tailSec: number;
}

export interface FissionDropWindow {
  startSec: number;
  endSec: number;
}

export interface FissionDropParams {
  windows: FissionDropWindow[];
}

export type FissionAppliedOp =
  | { kind: "color"; params: FissionColorParams }
  | { kind: "sharpen"; params: FissionSharpenParams }
  | { kind: "zoom"; params: FissionZoomParams }
  | { kind: "speed"; params: FissionSpeedParams }
  | { kind: "drop_frames"; params: FissionDropParams }
  | { kind: "trim_ends"; params: FissionTrimParams }
  | { kind: "mirror" };

export interface FissionVariantPlan {
  seed: number;
  signature: string;
  ops: FissionAppliedOp[];
}

/** Mulberry32：可复现的轻量 PRNG */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function round(n: number, digits = 3): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** 量化后的签名，用于去重 */
export function signatureOfOps(ops: FissionAppliedOp[]): string {
  const normalized = ops
    .map((op) => {
      switch (op.kind) {
        case "color":
          return {
            kind: op.kind,
            b: round(op.params.brightness, 2),
            c: round(op.params.contrast, 2),
            s: round(op.params.saturation, 2),
          };
        case "sharpen":
          return { kind: op.kind, a: round(op.params.amount, 2) };
        case "zoom":
          return { kind: op.kind, f: round(op.params.factor, 2) };
        case "speed":
          return { kind: op.kind, r: round(op.params.rate, 2) };
        case "trim_ends":
          return {
            kind: op.kind,
            h: round(op.params.headSec, 2),
            t: round(op.params.tailSec, 2),
          };
        case "drop_frames":
          return {
            kind: op.kind,
            w: op.params.windows.map((w) => [round(w.startSec, 2), round(w.endSec, 2)]),
          };
        case "mirror":
          return { kind: op.kind };
      }
    })
    .sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 10);
}

function buildOp(
  kind: FissionOpKind,
  rng: () => number,
  durationSec: number,
): FissionAppliedOp | null {
  switch (kind) {
    case "color":
      return {
        kind: "color",
        params: {
          brightness: round(pickFloat(rng, -0.06, 0.08)),
          contrast: round(pickFloat(rng, 0.92, 1.12)),
          saturation: round(pickFloat(rng, 0.88, 1.18)),
        },
      };
    case "sharpen":
      return {
        kind: "sharpen",
        params: { amount: round(pickFloat(rng, 0.35, 0.85)) },
      };
    case "zoom":
      return {
        kind: "zoom",
        params: { factor: round(pickFloat(rng, 1.05, 1.2)) },
      };
    case "speed":
      return {
        kind: "speed",
        params: { rate: round(pickFloat(rng, 1.05, 1.25)) },
      };
    case "mirror":
      return { kind: "mirror" };
    case "trim_ends": {
      if (durationSec < 3) return null;
      const maxCut = Math.min(1.5, durationSec * 0.1);
      const headSec = round(pickFloat(rng, 0.2, Math.max(0.2, maxCut)));
      const tailSec = round(pickFloat(rng, 0.2, Math.max(0.2, maxCut)));
      if (headSec + tailSec >= durationSec * 0.2) return null;
      if (headSec + tailSec + 1 >= durationSec) return null;
      return { kind: "trim_ends", params: { headSec, tailSec } };
    }
    case "drop_frames": {
      if (durationSec < 4) return null;
      const protect = Math.max(0.4, durationSec * 0.08);
      const usable = durationSec - protect * 2;
      if (usable < 1) return null;
      const count = pickInt(rng, 1, 3);
      const windows: FissionDropWindow[] = [];
      for (let i = 0; i < count; i++) {
        const len = round(pickFloat(rng, 0.1, 0.4));
        const start = round(protect + rng() * Math.max(0.1, usable - len));
        const end = round(Math.min(durationSec - protect, start + len));
        if (end - start < 0.08) continue;
        // 避免与已有窗重叠过多
        if (windows.some((w) => !(end <= w.startSec || start >= w.endSec))) continue;
        windows.push({ startSec: start, endSec: end });
      }
      if (!windows.length) return null;
      windows.sort((a, b) => a.startSec - b.startSec);
      return { kind: "drop_frames", params: { windows } };
    }
  }
}

/**
 * 从允许的操作中随机抽 1 种并生成参数（默认每种变体只执行一种变换）。
 * 时长过短时自动跳过不可行项并换其它操作。
 */
export function generateVariantPlan(input: {
  seed: number;
  durationSec: number;
  allowedOps?: FissionOpKind[];
  minOps?: number;
  maxOps?: number;
}): FissionVariantPlan {
  const rng = createRng(input.seed);
  const allowed = (input.allowedOps?.length ? input.allowedOps : [...FISSION_OP_KINDS]).filter(
    (k) => FISSION_OP_KINDS.includes(k),
  );
  const minOps = Math.max(1, input.minOps ?? 1);
  const maxOps = Math.max(minOps, input.maxOps ?? 1);
  const pool = [...allowed];
  shuffleInPlace(pool, rng);
  const want = Math.min(pool.length, pickInt(rng, minOps, Math.min(maxOps, pool.length)));

  const ops: FissionAppliedOp[] = [];
  for (const kind of pool) {
    if (ops.length >= want) break;
    const op = buildOp(kind, rng, input.durationSec);
    if (op) ops.push(op);
  }
  // 兜底：至少镜像或轻调色
  if (!ops.length) {
    ops.push({ kind: "mirror" });
  }
  return {
    seed: input.seed,
    signature: signatureOfOps(ops),
    ops,
  };
}

/** 生成 count 条尽量不重复的变体方案 */
export function generateUniquePlans(input: {
  count: number;
  baseSeed: number;
  durationSec: number;
  allowedOps?: FissionOpKind[];
  minOps?: number;
  maxOps?: number;
}): FissionVariantPlan[] {
  const plans: FissionVariantPlan[] = [];
  const seen = new Set<string>();
  let attempt = 0;
  const hardLimit = Math.max(input.count * 20, 100);
  while (plans.length < input.count && attempt < hardLimit) {
    const seed = (input.baseSeed + attempt * 9973 + plans.length * 131) >>> 0;
    attempt += 1;
    const plan = generateVariantPlan({
      seed,
      durationSec: input.durationSec,
      allowedOps: input.allowedOps,
      minOps: input.minOps,
      maxOps: input.maxOps,
    });
    if (seen.has(plan.signature)) continue;
    seen.add(plan.signature);
    plans.push(plan);
  }
  // 签名撞完时允许补足（仍换 seed，可能参数近似）
  while (plans.length < input.count) {
    const seed = (input.baseSeed + 1_000_000 + plans.length * 17) >>> 0;
    plans.push(
      generateVariantPlan({
        seed,
        durationSec: input.durationSec,
        allowedOps: input.allowedOps,
        minOps: input.minOps,
        maxOps: input.maxOps,
      }),
    );
  }
  return plans;
}

function fmtSec(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

/** 从 [start,end) 挖掉 drop 窗，得到保留区间（原片时间轴） */
export function computeKeepRanges(
  startSec: number,
  endSec: number,
  drops: FissionDropWindow[],
): FissionDropWindow[] {
  const sorted = [...drops]
    .map((w) => ({
      startSec: Math.max(startSec, w.startSec),
      endSec: Math.min(endSec, w.endSec),
    }))
    .filter((w) => w.endSec - w.startSec >= 0.05)
    .sort((a, b) => a.startSec - b.startSec);

  const ranges: FissionDropWindow[] = [];
  let cursor = startSec;
  for (const w of sorted) {
    if (w.startSec > cursor + 0.05) {
      ranges.push({ startSec: cursor, endSec: w.startSec });
    }
    cursor = Math.max(cursor, w.endSec);
  }
  if (endSec > cursor + 0.05) {
    ranges.push({ startSec: cursor, endSec: endSec });
  }
  if (!ranges.length) {
    ranges.push({ startSec, endSec: Math.max(startSec + 0.2, endSec) });
  }
  return ranges;
}

function buildVisualEffects(plan: FissionVariantPlan): string[] {
  const mirror = plan.ops.some((o) => o.kind === "mirror");
  const zoom = plan.ops.find((o): o is Extract<FissionAppliedOp, { kind: "zoom" }> => o.kind === "zoom");
  const color = plan.ops.find((o): o is Extract<FissionAppliedOp, { kind: "color" }> => o.kind === "color");
  const sharpen = plan.ops.find(
    (o): o is Extract<FissionAppliedOp, { kind: "sharpen" }> => o.kind === "sharpen",
  );
  const effects: string[] = [];
  if (mirror) effects.push("hflip");
  if (zoom) {
    const z = Math.max(1.01, Math.min(1.35, zoom.params.factor));
    // 偶数分辨率，避免 yuv420p 编码失败
    effects.push(
      `scale=trunc(iw*${z}/2)*2:trunc(ih*${z}/2)*2`,
      `crop=trunc(iw/${z}/2)*2:trunc(ih/${z}/2)*2`,
    );
  }
  if (color) {
    const { brightness, contrast, saturation } = color.params;
    effects.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  }
  if (sharpen) {
    const amt = Math.max(0.2, Math.min(1.2, sharpen.params.amount));
    effects.push(`unsharp=5:5:${amt}:5:5:0.0`);
  }
  effects.push("format=yuv420p", "setsar=1");
  return effects;
}

export interface FissionFilterGraph {
  /** 无抽帧时走 -vf / -af */
  videoFilter?: string;
  audioFilter?: string;
  /** 有抽帧时走 filter_complex + map */
  filterComplex?: string;
  mapVideo?: string;
  mapAudio?: string;
  /** 变换后预估输出时长（秒） */
  outputDurationSec: number;
}

/**
 * 组装单条滤镜链（CPU 滤镜；编码侧可走 NVENC）
 * 抽帧用 trim+concat（避免 select 转义导致整段无画面）
 */
export function buildFissionFilterGraph(
  plan: FissionVariantPlan,
  durationSec: number,
  options?: { withAudio?: boolean },
): FissionFilterGraph {
  const withAudio = options?.withAudio !== false;
  const trim = plan.ops.find((o): o is Extract<FissionAppliedOp, { kind: "trim_ends" }> => o.kind === "trim_ends");
  const drop = plan.ops.find(
    (o): o is Extract<FissionAppliedOp, { kind: "drop_frames" }> => o.kind === "drop_frames",
  );
  const speed = plan.ops.find((o): o is Extract<FissionAppliedOp, { kind: "speed" }> => o.kind === "speed");

  let start = 0;
  let end = Math.max(0.2, durationSec);
  if (trim) {
    start = Math.max(0, trim.params.headSec);
    end = Math.max(start + 0.2, durationSec - trim.params.tailSec);
  }

  const absDrops = (drop?.params.windows ?? [])
    .map((w) => ({
      startSec: Math.max(start, w.startSec),
      endSec: Math.min(end, w.endSec),
    }))
    .filter((w) => w.endSec - w.startSec >= 0.05);

  const keep = computeKeepRanges(start, end, absDrops);
  let timelineDur = keep.reduce((s, r) => s + (r.endSec - r.startSec), 0);
  timelineDur = Math.max(0.2, timelineDur);

  const visual = buildVisualEffects(plan);
  const rate = speed ? Math.max(1.01, Math.min(2, speed.params.rate)) : 1;
  const outDur = timelineDur / rate;

  // 多段保留 → filter_complex concat；单段 → 简单 -vf/-af
  if (keep.length > 1) {
    const parts: string[] = [];
    for (let i = 0; i < keep.length; i++) {
      const r = keep[i]!;
      parts.push(`[0:v]trim=${fmtSec(r.startSec)}:${fmtSec(r.endSec)},setpts=PTS-STARTPTS[v${i}]`);
      if (withAudio) {
        parts.push(`[0:a]atrim=${fmtSec(r.startSec)}:${fmtSec(r.endSec)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
    const vLabs = keep.map((_, i) => `[v${i}]`).join("");
    parts.push(`${vLabs}concat=n=${keep.length}:v=1:a=0[vcat]`);

    let vChain = visual.join(",");
    if (rate !== 1) vChain = `${vChain},setpts=PTS/${rate}`;
    parts.push(`[vcat]${vChain}[vout]`);

    if (withAudio) {
      const aLabs = keep.map((_, i) => `[a${i}]`).join("");
      parts.push(`${aLabs}concat=n=${keep.length}:v=0:a=1[acat]`);
      const aFx = ["aformat=sample_rates=48000:channel_layouts=stereo"];
      if (rate !== 1) aFx.unshift(`atempo=${rate}`);
      parts.push(`[acat]${aFx.join(",")}[aout]`);
    }

    return {
      filterComplex: parts.join(";"),
      mapVideo: "[vout]",
      mapAudio: withAudio ? "[aout]" : undefined,
      outputDurationSec: round(outDur, 3),
    };
  }

  const only = keep[0]!;
  const v: string[] = [];
  const a: string[] = [];
  if (only.startSec > 0.001 || only.endSec < durationSec - 0.01) {
    v.push(`trim=${fmtSec(only.startSec)}:${fmtSec(only.endSec)}`, "setpts=PTS-STARTPTS");
    if (withAudio) {
      a.push(`atrim=${fmtSec(only.startSec)}:${fmtSec(only.endSec)}`, "asetpts=PTS-STARTPTS");
    }
  }
  v.push(...visual);
  if (rate !== 1) {
    v.push(`setpts=PTS/${rate}`);
    if (withAudio) a.push(`atempo=${rate}`);
  }
  if (withAudio) a.push("aformat=sample_rates=48000:channel_layouts=stereo");

  return {
    videoFilter: v.join(","),
    audioFilter: withAudio && a.length ? a.join(",") : undefined,
    outputDurationSec: round(outDur, 3),
  };
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-900)}`));
    });
  });
}

async function probeHasAudio(ffprobePath: string, media: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", media],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", () => resolve(out.trim().length > 0));
    child.on("error", () => resolve(false));
  });
}

async function probeHasVideo(ffprobePath: string, media: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", media],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", () => resolve(/video/i.test(out) || out.trim().length > 0));
    child.on("error", () => resolve(false));
  });
}

export interface RenderFissionVariantInput {
  ffmpegPath: string;
  ffprobePath?: string;
  sourcePath: string;
  outputPath: string;
  plan: FissionVariantPlan;
  durationSec?: number;
  /** 默认 h264_nvenc（Windows 探测通过时） */
  preferredCodec?: string;
}

export interface RenderFissionVariantResult {
  outputPath: string;
  wallTimeSec: number;
  codec: string;
  plan: FissionVariantPlan;
  outputDurationSec: number;
}

/** 单条变体：一次滤镜 + 一次编码（优先 NVENC） */
export async function renderFissionVariant(
  input: RenderFissionVariantInput,
): Promise<RenderFissionVariantResult> {
  const ffprobe = input.ffprobePath ?? "ffprobe";
  const durationSec =
    input.durationSec && input.durationSec > 0
      ? input.durationSec
      : (await probeVideoDurationMs(input.sourcePath, ffprobe)) / 1000;
  const hasAudio = await probeHasAudio(ffprobe, input.sourcePath);
  const graph = buildFissionFilterGraph(input.plan, durationSec, { withAudio: hasAudio });

  const preferred = input.preferredCodec ?? "h264_nvenc";
  let codec = resolveVideoCodec(preferred);
  if (codec.includes("nvenc") && !isNvencRenderAvailable()) {
    codec = "libx264";
  }

  await mkdir(dirname(input.outputPath), { recursive: true });

  const encode = {
    codec,
    preset: codec.includes("nvenc") ? "p1" : "veryfast",
    cq: 28,
    crf: 26,
    fallback: { codec: "libx264", preset: "veryfast", crf: 26 },
  };

  const buildArgs = (useCodec: string, withAudio: boolean): string[] => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.sourcePath];
    if (graph.filterComplex) {
      args.push("-filter_complex", graph.filterComplex, "-map", graph.mapVideo ?? "[vout]");
      if (withAudio) {
        args.push("-map", graph.mapAudio ?? "[aout]", "-c:a", "aac", "-b:a", "128k");
      } else {
        args.push("-an");
      }
    } else {
      args.push("-vf", graph.videoFilter ?? "format=yuv420p");
      if (withAudio) {
        args.push("-af", graph.audioFilter ?? "anull", "-c:a", "aac", "-b:a", "128k");
      } else {
        args.push("-an");
      }
    }
    args.push("-c:v", useCodec);
    appendVideoEncodeArgs(args, useCodec, encode);
    args.push("-movflags", "+faststart", input.outputPath);
    return args;
  };

  const started = Date.now();
  const tryEncode = async (useCodec: string) => {
    await runFfmpeg(input.ffmpegPath, buildArgs(useCodec, hasAudio));
    const okVideo = await probeHasVideo(ffprobe, input.outputPath);
    if (!okVideo) {
      throw new Error("输出缺少视频流（抽帧/滤镜异常）");
    }
  };

  try {
    await tryEncode(codec);
  } catch (err) {
    if (codec.includes("nvenc")) {
      codec = "libx264";
      await tryEncode(codec);
    } else {
      throw err;
    }
  }

  return {
    outputPath: input.outputPath,
    wallTimeSec: (Date.now() - started) / 1000,
    codec,
    plan: input.plan,
    outputDurationSec: graph.outputDurationSec,
  };
}

export function fissionOutputFileName(sourcePath: string, index: number, signature: string): string {
  const base = basename(sourcePath, extname(sourcePath)).replace(/[^\w\u4e00-\u9fff\-]+/g, "_");
  const safe = base.slice(0, 48) || "clip";
  return `${safe}_f${String(index).padStart(3, "0")}_${signature}.mp4`;
}

export async function writeFissionManifest(
  outDir: string,
  manifest: unknown,
): Promise<string> {
  const path = join(outDir, "manifest.json");
  await mkdir(outDir, { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
  return path;
}
