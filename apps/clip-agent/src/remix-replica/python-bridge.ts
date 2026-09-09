import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemixAnalysisResult, RunPythonOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 兼容 monorepo 开发结构（apps/clip-agent/dist/remix-replica -> ../../../vendor）
// 与安装包结构（clip-agent/dist/remix-replica -> ../../vendor）
const VENDOR_DIR = (() => {
  const dev = resolve(__dirname, "../../../vendor/remix-replica");
  const packaged = resolve(__dirname, "../../vendor/remix-replica");
  return existsSync(resolve(packaged, "cli.py")) ? packaged : dev;
})();
const CLI_SCRIPT = resolve(VENDOR_DIR, "cli.py");

interface AnalyzeProgress {
  phase: string;
  value: number;
}

function parseProgress(line: string): AnalyzeProgress | null {
  if (line.startsWith("PROGRESS:")) {
    const value = Number(line.slice("PROGRESS:".length));
    if (Number.isFinite(value)) return { phase: "analyze", value };
  }
  return null;
}

function runPythonCli(
  args: string[],
  options: RunPythonOptions,
): Promise<{ code: number; stdout: string; stderr: string; resultLine?: string }> {
    const python = options.pythonExecutable ?? "python";
    return new Promise((resolve, reject) => {
      const proc = spawn(python, [CLI_SCRIPT, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: VENDOR_DIR,
        env: {
          ...process.env,
          // Windows 嵌入版 Python 的 .pth 不会自动把 cwd 加入 sys.path，
          // 必须显式注入脚本目录，否则同级 matcher.py 无法 import
          PYTHONPATH: VENDOR_DIR,
          // matcher.py 用 CLIP_FFMPEG_PATH 定位 ffmpeg，确保继承 Node 侧的路径
          CLIP_FFMPEG_PATH: process.env.CLIP_FFMPEG_PATH || "",
          // 强制 Python stdout/stderr 使用 UTF-8，避免 Windows 中文乱码
          PYTHONIOENCODING: "utf-8",
        },
      });
    let stdout = "";
    let stderr = "";
    let resultLine: string | undefined;
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const progress = parseProgress(trimmed);
        if (progress) {
          options.onProgress?.(progress.value);
        } else if (trimmed.startsWith("RESULT:")) {
          resultLine = trimmed;
        } else {
          options.onLog?.(trimmed);
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) options.onLog?.(trimmed);
      }
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr, resultLine });
    });
  });
}

/** 调用 Python 复刻器分析案例视频（可多条）与原片 */
export async function analyzeRemixReplica(
  referencePaths: string[],
  sourcePaths: string[],
  outputDir: string,
  options: RunPythonOptions = {},
): Promise<RemixAnalysisResult> {
  await mkdir(outputDir, { recursive: true });
  if (referencePaths.length === 0) {
    throw new Error("请至少提供一条案例视频");
  }
  const args = [
    "analyze",
    ...referencePaths.flatMap((p) => ["--reference", p]),
    ...sourcePaths.flatMap((p) => ["--source", p]),
    "--output",
    outputDir,
    "--sample-fps",
    String(options.sampleFps ?? 4),
  ];
  if (options.featureCachePath) {
    args.push("--feature-cache", options.featureCachePath);
  } else if (options.cacheDir) {
    args.push("--cache-dir", options.cacheDir);
  }
  const { code, stderr, stdout } = await runPythonCli(args, options);
  if (code !== 0) {
    throw new Error(`复刻器分析失败: ${stderr || stdout || "unknown error"}`);
  }
  const jsonPath = `${outputDir}/匹配时间线.json`;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(jsonPath, "utf-8");
  return JSON.parse(raw) as RemixAnalysisResult;
}

/** 调用 Python 复刻器按时间线渲染成片 */
export async function renderRemixReplica(
  analysisJsonPath: string,
  outputVideoPath: string,
  options: RunPythonOptions & { sourceOnly?: boolean; sourceAudio?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(outputVideoPath), { recursive: true });
  const args = [
    "render",
    "--timeline",
    analysisJsonPath,
    "--output-video",
    outputVideoPath,
  ];
  if (options.sourceOnly) args.push("--source-only");
  if (options.sourceAudio) args.push("--source-audio");
  const { code, stderr, stdout } = await runPythonCli(args, options);
  if (code !== 0) {
    throw new Error(`复刻器渲染失败: ${stderr || stdout || "unknown error"}`);
  }
}

export function getVendorDir(): string {
  return VENDOR_DIR;
}
