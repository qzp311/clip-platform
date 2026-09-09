import { mkdir, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { analyzeRemixReplica, renderRemixReplica } from "./remix-replica/python-bridge.js";
import type { RemixAnalysisResult } from "./remix-replica/types.js";
import { runMaterialFission } from "./material-fission-runner.js";

export interface RunRemixReplicaLocalInput {
  /** 案例视频本地路径（可多条） */
  casePaths: string[];
  /** 原片本地路径（可多条） */
  sourcePaths: string[];
  /** 工作目录（临时文件、分析结果） */
  /** 原片特征缓存目录；不传则用 workDir/source-cache（每次新建 workDir 不跨次复用） */
  cacheDir?: string;
  workDir: string;
  /** 输出目录（成片 mp4 放这里） */
  outputDir: string;
  /** 输出文件名（不含路径），默认自动生成 */
  outputFileName?: string;
  /** 短剧名称（用于文件名） */
  title?: string;
  /** 启用裂变 */
  fissionEnabled?: boolean;
  /** 每条裂变数量 */
  fissionCount?: number;
  /** 裂变操作维度 */
  fissionOps?: string[];
  /** ffmpeg 路径 */
  ffmpegPath?: string;
  /** ffprobe 路径 */
  ffprobePath?: string;
  /** python 可执行文件路径 */
  pythonPath?: string;
  /** 进度回调 */
  onProgress?: (phase: string, value: number) => void;
  /** 日志回调 */
  onLog?: (line: string) => void;
}

export interface RunRemixReplicaLocalResult {
  /** 输出成片本地绝对路径 */
  outputPath: string;
  /** 分析结果 */
  analysis: RemixAnalysisResult;
  /** 裂变输出路径列表 */
  fissionOutputPaths?: string[];
}

export async function runRemixReplicaLocal(
  input: RunRemixReplicaLocalInput,
): Promise<RunRemixReplicaLocalResult> {
  const { casePaths, sourcePaths, workDir, outputDir, onProgress, onLog } = input;

  if (casePaths.length === 0) throw new Error("请至少选择一条案例视频");
  if (sourcePaths.length === 0) throw new Error("请至少选择一个原片");

  const analyzeDir = join(workDir, "analyze");
  await mkdir(analyzeDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const log = (msg: string) => {
    console.log(`[remix-local] ${msg}`);
    onLog?.(msg);
  };
  const progress = (phase: string, value: number) => onProgress?.(phase, value);

  // ---- 分析 ----
  log(`开始分析：${casePaths.length} 条案例 × ${sourcePaths.length} 个原片`);
  progress("analyze", 0);

  // 原片特征缓存目录：按原片集合指纹自动建子目录，相同原片跨次复刻也复用缓存
  // 不指定时默认在 workDir/source-cache（每次新建 workDir 则不跨次复用，需跨次复用请显式传入）
  const cacheDir = input.cacheDir || join(workDir, "source-cache");
  const analysis = await analyzeRemixReplica(casePaths, sourcePaths, analyzeDir, {
    sampleFps: 4,
    pythonExecutable: input.pythonPath,
    cacheDir,
    onLog: (line) => log(`[analyze] ${line}`),
    onProgress: (value) => progress("analyze", value),
  });

  log(
    `匹配完成：matched=${analysis.matched_seconds.toFixed(1)}s, unmatched=${analysis.unmatched_seconds.toFixed(1)}s`,
  );

  // ---- 渲染 ----
  const timelinePath = join(analyzeDir, "匹配时间线.json");
  await writeFile(timelinePath, JSON.stringify(analysis, null, 2), "utf-8");

  const pad = (n: number) => n.toString().padStart(2, "0");
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const DD = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  const dramaTitle = input.title || "remix";
  const outputFileName = input.outputFileName || `${dramaTitle}-${YYYY}${MM}${DD}${hh}${mm}${ss}${ms}-autocapy-001.mp4`;
  const outputPath = join(outputDir, outputFileName);

  log("开始渲染成片…");
  progress("render", 0);

  await renderRemixReplica(timelinePath, outputPath, {
    sourceOnly: true,
    sourceAudio: true,
    pythonExecutable: input.pythonPath,
    onLog: (line) => log(`[render] ${line}`),
    onProgress: (value) => progress("render", value),
  });

  log(`复刻完成：${outputPath}`);

  // 裂变文件重命名辅助：短剧名称-时间戳-autocapy-lb-序号
  function fissionName(sourcePath: string, idx: number): string {
    return `${dramaTitle}-${YYYY}${MM}${DD}${hh}${mm}${ss}${ms}-autocapy-lb-${String(idx).padStart(3, "0")}.mp4`;
  }

  // ---- 裂变 ----
  const fissionOutputPaths: string[] = [];
  if (input.fissionEnabled && (input.fissionCount ?? 0) > 0) {
    log(`开始裂变：${input.fissionCount} 条变体…`);
    progress("fission", 0);
    try {
      const fissionResult = await runMaterialFission({
        sources: [outputPath],
        variantsPerSource: input.fissionCount!,
        allowedOps: input.fissionOps as ("sharpen" | "color" | "zoom" | "speed" | "drop_frames" | "trim_ends" | "mirror")[] | undefined,
        ffmpegPath: input.ffmpegPath || "ffmpeg",
        ffprobePath: input.ffprobePath || "ffprobe",
      });
      for (const item of fissionResult.items) {
        if (item.outputPath) {
          const renamed = join(outputDir, fissionName(item.outputPath, fissionOutputPaths.length + 1));
          renameSync(item.outputPath, renamed);
          fissionOutputPaths.push(renamed);
        }
      }
      log(`裂变完成：ok=${fissionResult.ok} fail=${fissionResult.fail}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`裂变失败，主成片不受影响: ${msg.slice(0, 200)}`);
    }
  }

  progress("done", 1);
  return { outputPath, analysis, fissionOutputPaths };
}
