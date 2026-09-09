import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ClipTask, DramaEpisodeRecord, EffectiveConfig, VideoBasicInfo } from "@clip/sdk";
import { probeVideoDurationMs } from "@clip/agent-core";
import type { ClipApiClient } from "./pipeline.js";
import { resolveSourceVideo } from "./source-resolver.js";
import { uploadOutputVideoAndDelete } from "./oss-client.js";
import { startTaskProgress, updateTaskProgress, finishTaskProgress } from "./task-progress.js";
import { analyzeRemixReplica, renderRemixReplica } from "./remix-replica/python-bridge.js";
import type { RemixAnalysisResult } from "./remix-replica/types.js";
import { listDramaEpisodes } from "./material-submit.js";
import { getDramaEpisodeSources } from "./local-source-registry.js";
import { resolvePackageCacheDir } from "./package-cleaner.js";
import { scanEpisodeVideos } from "./package-scanner.js";
import { removeTaskWorkspace } from "./workspace-cleaner.js";
import {
  downloadRemixFeatureCacheFromTos,
  uploadRemixFeatureCacheToTos,
} from "./tos-client.js";
import { runMaterialFission } from "./material-fission-runner.js";

export interface RunRemixReplicaInput {
  task: ClipTask;
  client: ClipApiClient;
  deviceId: string;
  workspaceDir: string;
  outputDir: string;
  config: EffectiveConfig;
  workspaceRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  pythonPath?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 为单个原片生成稳定指纹：文件名 + 大小；不存在则回退 URL 哈希。与 matcher.py 保持一致。 */
function sourceFingerprint(path: string): string {
  try {
    const s = statSync(path);
    return `${basename(path)}:${s.size}`;
  } catch {
    return createHash("sha256").update(path).digest("hex").slice(0, 16);
  }
}

/** 为原片集合生成缓存指纹，与 matcher.py _source_cache_dir 的 digest 一致。 */
function sourceCacheFingerprint(sourcePaths: string[]): string {
  const fingerprints = sourcePaths.map(sourceFingerprint).sort();
  return createHash("sha256").update(fingerprints.join("|")).digest("hex").slice(0, 12);
}

function buildFeatureCachePath(workspaceRoot: string, dramaId: string, fingerprint: string): string {
  return join(workspaceRoot, "remix-cache", dramaId, `${fingerprint}.npz`);
}

async function probeOutputVideoInfo(
  videoPath: string,
  ffprobePath?: string,
): Promise<VideoBasicInfo> {
  const executable = ffprobePath ?? "ffprobe";
  const [size, durationMs, dimensions] = await Promise.allSettled([
    stat(videoPath).then((s) => s.size).catch(() => undefined),
    probeVideoDurationMs(videoPath, executable),
    new Promise<{ width: number; height: number }>((resolve, reject) => {
      const child = spawn(executable, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0:s=x",
        videoPath,
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe 无法读取视频尺寸: ${videoPath}`));
          return;
        }
        const match = stdout.trim().match(/(\d+)x(\d+)/);
        if (!match) {
          reject(new Error(`ffprobe 未返回有效尺寸: ${stdout.trim()}`));
          return;
        }
        resolve({ width: Number(match[1]), height: Number(match[2]) });
      });
    }),
  ]);
  return {
    width: dimensions.status === "fulfilled" ? dimensions.value.width : undefined,
    height: dimensions.status === "fulfilled" ? dimensions.value.height : undefined,
    durationSec: durationMs.status === "fulfilled" ? Math.round(durationMs.value / 1000) : undefined,
    fileSizeBytes: size.status === "fulfilled" ? size.value : undefined,
  };
}

/** 获取原片分集地址：优先本地已缓存路径，否则回退 sourceUrl */
async function resolveEpisodeSources(
  task: ClipTask,
  workspaceRoot: string,
  client: ClipApiClient,
): Promise<{ episodeUrls: string[]; localSourcePaths: string[] }> {
  const meta = task.dramaMeta ?? {};
  let episodeUrls = Array.isArray(meta.remixEpisodeUrls)
    ? (meta.remixEpisodeUrls.filter((u: unknown) => typeof u === "string" && u.trim()) as string[])
    : [];

  // 若前端未传分集 URL，按 dramaId 从服务端拉已入库分集
  if (episodeUrls.length === 0 && task.dramaId) {
    const episodes = await listDramaEpisodes(client.apiBase, client.authHeaders(), task.dramaId);
    episodeUrls = episodes.map((ep) => ep.sourceUrl).filter(Boolean);
  }

  // 若前端已传分集顺序，优先按该顺序下载，保证用户选择顺序；仅当没有 URL 时才回退本地缓存
  if (episodeUrls.length > 0) {
    return { episodeUrls, localSourcePaths: [] };
  }

  // 没有 URL 时，回退到本地缓存目录或来源注册表
  const localSources: string[] = [];
  if (task.parentPackageTaskId && task.dramaId) {
    const parent = await client.getTask(task.parentPackageTaskId).catch(() => null);
    if (parent?.dramaPackage) {
      const packageKey = parent.dramaPackage.packageObjectKey ?? parent.dramaPackage.packageName;
      const cacheDir = resolvePackageCacheDir(workspaceRoot, task.dramaId, packageKey);
      const extractDir = join(cacheDir, "extracted");
      if (await fileExists(extractDir)) {
        const videos = await scanEpisodeVideos(extractDir);
        if (videos.length > 0) {
          localSources.push(...videos.map((v) => v.path));
          return { episodeUrls, localSourcePaths: localSources };
        }
      }
    }
  }

  // 已有剧目：尝试本地来源注册表
  if (task.dramaId) {
    const registered = await getDramaEpisodeSources(task.dramaId);
    const values = Object.values(registered);
    if (values.length > 0) {
      localSources.push(...values);
      return { episodeUrls, localSourcePaths: localSources };
    }
  }

  return { episodeUrls, localSourcePaths: [] };
}

/** 下载复刻任务所需视频：案例视频（可多条）+ 各集原片 */
async function downloadSources(
  task: ClipTask,
  workspace: string,
  workspaceRoot: string,
  client: ClipApiClient,
  onProgress: (phase: string, value: number) => void,
): Promise<{ referencePaths: string[]; sourcePaths: string[] }> {
  const meta = task.dramaMeta ?? {};
  const caseUrls = Array.isArray(meta.remixCaseVideoUrls)
    ? (meta.remixCaseVideoUrls.filter((u: unknown) => typeof u === "string" && u.trim()) as string[])
    : [];
  const singleCaseUrl = String(meta.remixCaseVideoUrl ?? task.sourceUrl ?? "").trim();
  const allCaseUrls = caseUrls.length > 0 ? caseUrls : singleCaseUrl ? [singleCaseUrl] : [];
  if (allCaseUrls.length === 0) throw new Error("任务缺少案例视频 URL");

  const { episodeUrls, localSourcePaths } = await resolveEpisodeSources(task, workspaceRoot, client);
  if (episodeUrls.length === 0 && localSourcePaths.length === 0) {
    throw new Error("未找到原片分集，请确认短剧已入库或剧包已解压");
  }

  await startTaskProgress({
    taskId: task.taskId,
    kind: "remix_replica",
    phaseCode: "download",
    phase: `下载 ${allCaseUrls.length} 条案例视频和 ${Math.max(episodeUrls.length, localSourcePaths.length)} 集原片`,
  });

  const referencePaths: string[] = [];
  for (let i = 0; i < allCaseUrls.length; i += 1) {
    const caseWorkspace = join(workspace, `case-${i}`);
    await mkdir(caseWorkspace, { recursive: true });
    referencePaths.push(await resolveSourceVideo(allCaseUrls[i]!, caseWorkspace));
  }
  onProgress("download", 0.3);

  const sourcePaths: string[] = [];
  const total = Math.max(episodeUrls.length, localSourcePaths.length);
  // 优先用本地缓存
  if (localSourcePaths.length > 0) {
    for (let i = 0; i < localSourcePaths.length; i++) {
      sourcePaths.push(localSourcePaths[i]!);
      onProgress("download", 0.3 + 0.7 * ((i + 1) / total));
    }
  } else {
    for (let i = 0; i < episodeUrls.length; i++) {
      const epWorkspace = join(workspace, `episode-${i}`);
      await mkdir(epWorkspace, { recursive: true });
      const path = await resolveSourceVideo(episodeUrls[i]!, epWorkspace);
      sourcePaths.push(path);
      onProgress("download", 0.3 + 0.7 * ((i + 1) / total));
    }
  }

  return { referencePaths, sourcePaths };
}

/** 分析阶段：视觉指纹匹配（支持多条案例 reference） */
async function analyze(
  task: ClipTask,
  referencePaths: string[],
  sourcePaths: string[],
  analyzeDir: string,
  featureCachePath: string | undefined,
  pythonPath?: string,
): Promise<RemixAnalysisResult> {
  await updateTaskProgress({
    taskId: task.taskId,
    kind: "remix_replica",
    phaseCode: "analyze",
    phase: "视觉指纹匹配中…",
    active: true,
  });

  const result = await analyzeRemixReplica(referencePaths, sourcePaths, analyzeDir, {
    sampleFps: 4,
    pythonExecutable: pythonPath,
    featureCachePath,
    onLog: (line) => console.log(`[remix-replica][analyze] ${line}`),
    onProgress: (value) => {
      void updateTaskProgress({
        taskId: task.taskId,
        kind: "remix_replica",
        phaseCode: "analyze",
        phase: `视觉指纹匹配 ${Math.round(value * 100)}%`,
        active: true,
      });
    },
  });

  return result;
}

/** 渲染阶段：按时间线生成复刻视频 */
async function render(
  task: ClipTask,
  analysis: RemixAnalysisResult,
  analyzeDir: string,
  outputVideoPath: string,
  pythonPath?: string,
): Promise<void> {
  await updateTaskProgress({
    taskId: task.taskId,
    kind: "remix_replica",
    phaseCode: "render",
    phase: "按时间线渲染成片…",
    active: true,
  });

  const timelinePath = join(analyzeDir, "匹配时间线.json");
  await writeFile(timelinePath, JSON.stringify(analysis, null, 2), "utf-8");

  await renderRemixReplica(timelinePath, outputVideoPath, {
    sourceOnly: true,
    sourceAudio: true,
    pythonExecutable: pythonPath,
    onLog: (line) => console.log(`[remix-replica][render] ${line}`),
    onProgress: (value) => {
      void updateTaskProgress({
        taskId: task.taskId,
        kind: "remix_replica",
        phaseCode: "render",
        phase: `渲染成片 ${Math.round(value * 100)}%`,
        active: true,
      });
    },
  });
}

/**
 * 尝试从服务端复用复刻原片特征缓存。
 * 返回本地缓存路径（无论是否命中都需要作为 matcher.py 的保存目标）以及是否命中服务端缓存。
 */
async function prepareFeatureCache(
  task: ClipTask,
  sourcePaths: string[],
  workspaceRoot: string,
  client: ClipApiClient,
  config: EffectiveConfig,
): Promise<{ featureCachePath: string | undefined; fingerprint: string; cacheHit: boolean }> {
  const dramaId = task.dramaId;
  const fingerprint = sourceCacheFingerprint(sourcePaths);
  if (!dramaId) {
    return { featureCachePath: undefined, fingerprint, cacheHit: false };
  }
  const cachePath = buildFeatureCachePath(workspaceRoot, dramaId, fingerprint);

  try {
    const cache = await client.getRemixFeatureCache(dramaId);
    if (cache.cached && cache.fingerprint === fingerprint) {
      await mkdir(dirname(cachePath), { recursive: true });
      if (!(await fileExists(cachePath))) {
        await downloadRemixFeatureCacheFromTos(config, cache.objectKey, cachePath);
      } else {
        console.log(`[remix-replica] 本地已存在特征缓存: ${cachePath}`);
      }
      return { featureCachePath: cachePath, fingerprint, cacheHit: true };
    }
    if (cache.cached) {
      console.log(
        `[remix-replica] 服务端特征缓存指纹不匹配，将重新提取: server=${cache.fingerprint}, local=${fingerprint}`,
      );
    } else {
      console.log(`[remix-replica] 无服务端特征缓存，将提取并登记: ${dramaId}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[remix-replica] 查询特征缓存失败，降级为本地提取: ${msg.slice(0, 200)}`);
  }

  return { featureCachePath: cachePath, fingerprint, cacheHit: false };
}

/**
 * 分析完成后，如有新生成的特征缓存则上传 TOS 并在 clip_drama 登记。
 */
async function publishFeatureCache(
  task: ClipTask,
  fingerprint: string,
  featureCachePath: string | undefined,
  cacheHit: boolean,
  sourcePaths: string[],
  client: ClipApiClient,
  config: EffectiveConfig,
): Promise<void> {
  const dramaId = task.dramaId;
  if (!dramaId || !featureCachePath || cacheHit) return;

  if (!(await fileExists(featureCachePath))) return;

  try {
    const fileStat = await stat(featureCachePath);
    const objectKey = await uploadRemixFeatureCacheToTos(config, dramaId, fingerprint, featureCachePath);
    await client.setRemixFeatureCache(dramaId, {
      objectKey,
      fingerprint,
      sizeBytes: fileStat.size,
      frameCount: 0, // matcher.py 当前未输出帧数，后续可扩展
      sourceCount: sourcePaths.length,
    });
    console.log(`[remix-replica] 特征缓存已登记: ${objectKey}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[remix-replica] 上传/登记特征缓存失败: ${msg.slice(0, 200)}`);
  }
}

/** 上传阶段：成片直传 TOS */
function buildReplicaFilename(dramaTitle: string, index = 1): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const YYYY = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const DD = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  const seq = index.toString().padStart(3, "0");
  return `${dramaTitle}-${YYYY}${MM}${DD}${hh}${mm}${ss}${ms}-autocapy-${seq}.mp4`;
}

function buildFissionFilename(dramaTitle: string, index = 1): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const YYYY = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const DD = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  const seq = index.toString().padStart(3, "0");
  return `${dramaTitle}_${YYYY}${MM}${DD}${hh}${mm}${ss}${ms}_autocp_lb_${seq}.mp4`;
}

async function upload(
  task: ClipTask,
  outputVideoPath: string,
  config: EffectiveConfig,
  headers: Record<string, string>,
  apiBase: string,
  ffmpegPath?: string,
  ffprobePath?: string,
  outputIndex = 1,
): Promise<string> {
  await updateTaskProgress({
    taskId: task.taskId,
    kind: "remix_replica",
    phaseCode: "upload",
    phase: "上传成片到 TOS…",
    active: true,
  });

  const dramaTitle = typeof task.dramaMeta?.title === "string" ? task.dramaMeta.title : task.dramaId ?? "remix";
  const filename = buildReplicaFilename(dramaTitle, outputIndex);
  const uploaded = await uploadOutputVideoAndDelete({
    apiBase,
    headers,
    taskId: task.taskId,
    outputPath: outputVideoPath,
    filename,
    config,
    folderSegment: dramaTitle,
    ffmpegPath,
    ffprobePath,
  });

  return uploaded.url;
}

/** 上传单个裂变素材到 TOS，使用裂变专用命名规则 */
async function uploadFissionVideo(
  task: ClipTask,
  outputVideoPath: string,
  config: EffectiveConfig,
  headers: Record<string, string>,
  apiBase: string,
  index: number,
  ffmpegPath?: string,
  ffprobePath?: string,
): Promise<string> {
  const dramaTitle = typeof task.dramaMeta?.title === "string" ? task.dramaMeta.title : task.dramaId ?? "remix";
  const filename = buildFissionFilename(dramaTitle, index);

  const uploaded = await uploadOutputVideoAndDelete({
    apiBase,
    headers,
    taskId: task.taskId,
    outputPath: outputVideoPath,
    filename,
    config,
    folderSegment: dramaTitle,
    ffmpegPath,
    ffprobePath,
  });

  return uploaded.url;
}

/** 执行一条 remix_replica 任务 */
export async function runRemixReplica(input: RunRemixReplicaInput): Promise<{ outputUrl: string; fissionUrls: string[] }> {
  const { task, client, deviceId, workspaceDir, outputDir, config, workspaceRoot } = input;
  const analyzeDir = join(workspaceDir, "analyze");
  await mkdir(analyzeDir, { recursive: true });

  const startAt = new Date().toISOString();
  let outputUrl = "";

  try {
    // 新短剧复刻：先等待父剧包入库完成；未完成则释放任务并恢复 pending，等待下次领取
    if (task.parentPackageTaskId) {
      const parent = await client.getTask(task.parentPackageTaskId).catch(() => null);
      if (!parent || parent.status !== "completed") {
        console.log(
          `[remix-replica] 父剧包 ${task.parentPackageTaskId} 尚未完成，本任务暂不处理，等待后续 claim`,
        );
        await client.releaseRemixReplicaClaim(task.taskId);
        throw new Error("父剧包尚未完成，任务已恢复 pending 等待下次领取");
      }
      console.log(`[remix-replica] 父剧包 ${task.parentPackageTaskId} 已完成，继续复刻`);
    }

    await client.claimRemixReplica(task.taskId, deviceId);

    const { referencePaths, sourcePaths } = await downloadSources(task, workspaceDir, workspaceRoot, client, (phase, value) => {
      void updateTaskProgress({
        taskId: task.taskId,
        kind: "remix_replica",
        phaseCode: phase as "download",
        phase: `下载中 ${Math.round(value * 100)}%`,
        active: true,
      });
    });

    // 注意：sourcePaths 保持用户/前端传入顺序，不再排序；缓存 key 由 sourceCacheFingerprint 内部排序保证稳定
    const { featureCachePath, fingerprint, cacheHit } = await prepareFeatureCache(
      task,
      sourcePaths,
      workspaceRoot,
      client,
      config,
    );

    const analysis = await analyze(task, referencePaths, sourcePaths, analyzeDir, featureCachePath, input.pythonPath);
    console.log(
      `[remix-replica] 匹配完成：matched=${analysis.matched_seconds.toFixed(1)}s, unmatched=${analysis.unmatched_seconds.toFixed(1)}s`,
    );

    // 异步上传/登记本次生成的特征缓存，不阻塞渲染上传主流程
    void publishFeatureCache(task, fingerprint, featureCachePath, cacheHit, sourcePaths, client, config);

    const outputVideoPath = join(outputDir, `remix-replica-${task.taskId}.mp4`);
    await render(task, analysis, analyzeDir, outputVideoPath, input.pythonPath);

    const videoInfo = await probeOutputVideoInfo(outputVideoPath, input.ffprobePath);

    // 裂变：若任务启用裂变，先对主成片生成变体并上传（主成片先不上传，避免本地文件被删除）
    const fissionUrls: string[] = [];
    let fissionOutDir: string | undefined;
    const fissionEnabled = task.dramaMeta?.remixFissionEnabled === true;
    const fissionCount = Number(task.dramaMeta?.remixFissionCount ?? 0);
    if (fissionEnabled && fissionCount > 0) {
      const fissionOps = task.dramaMeta?.remixFissionOps as string[] | undefined;
      try {
        await updateTaskProgress({
          taskId: task.taskId,
          kind: "remix_replica",
          phaseCode: "render",
          phase: "正在裂变主成片…",
          active: true,
        });
        const fissionResult = await runMaterialFission({
          sources: [outputVideoPath],
          variantsPerSource: fissionCount,
          allowedOps: fissionOps as ("sharpen" | "color" | "zoom" | "speed" | "drop_frames" | "trim_ends" | "mirror")[] | undefined,
          ffmpegPath: input.ffmpegPath || "ffmpeg",
          ffprobePath: input.ffprobePath || "ffprobe",
          config,
        });
        fissionOutDir = fissionResult.outDir;
        console.log(
          `[remix-replica] 裂变完成：total=${fissionResult.total} ok=${fissionResult.ok} fail=${fissionResult.fail}`,
        );

        await updateTaskProgress({
          taskId: task.taskId,
          kind: "remix_replica",
          phaseCode: "upload",
          phase: "正在上传裂变素材…",
          active: true,
        });

        let uploadIndex = 0;
        for (const item of fissionResult.items) {
          if (!item.outputPath) continue;
          uploadIndex += 1;
          try {
            const url = await uploadFissionVideo(
              task,
              item.outputPath,
              config,
              client.authHeaders(),
              client.apiBase,
              uploadIndex,
              input.ffmpegPath,
              input.ffprobePath,
            );
            fissionUrls.push(url);
            console.log(`[remix-replica] 裂变素材上传完成 ${uploadIndex}/${fissionResult.ok}: ${url}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[remix-replica] 裂变素材上传失败 ${uploadIndex}: ${msg.slice(0, 200)}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[remix-replica] 裂变阶段失败，不影响主成片: ${msg.slice(0, 200)}`);
      }
    }

    // 主成片最后上传，上传后本地文件会被删除
    outputUrl = await upload(
      task,
      outputVideoPath,
      config,
      client.authHeaders(),
      client.apiBase,
      input.ffmpegPath,
      input.ffprobePath,
      1,
    );

    const totalWallTimeSec = Math.round((Date.now() - new Date(startAt).getTime()) / 1000);
    await client.completeTask(task.taskId, outputUrl, {
      processingStartedAt: startAt,
      totalWallTimeSec,
      fissionUrls,
    }, videoInfo);
    await client.updateRemixReplicaStatus(task.taskId, "completed", { timeline: analysis as unknown as Record<string, unknown> });

    await finishTaskProgress({ phase: "复刻完成" });
    await removeTaskWorkspace(workspaceDir);
    if (fissionOutDir) {
      try {
        await rm(fissionOutDir, { recursive: true, force: true });
        console.log(`[remix-replica] 裂变目录已清理: ${fissionOutDir}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[remix-replica] 裂变目录清理失败: ${msg.slice(0, 200)}`);
      }
    }
    return { outputUrl, fissionUrls };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[remix-replica] 任务失败 ${task.taskId}: ${message}`);
    await client.updateRemixReplicaStatus(task.taskId, "failed", { errorMessage: message }).catch(() => undefined);
    await finishTaskProgress({ error: message });
    throw err;
  }
}
