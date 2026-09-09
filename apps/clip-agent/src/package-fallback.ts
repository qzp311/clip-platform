import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ClipTask } from "@clip/sdk";
import { resolvePackageCacheDir } from "./package-cleaner.js";
import { downloadPackage } from "./package-downloader.js";
import { extractZipArchive } from "./package-extractor.js";
import { scanEpisodeVideos } from "./package-scanner.js";
import { saveEpisodeLocalSource } from "./local-source-registry.js";
import type { ClipApiClient } from "./pipeline.js";

export interface PackageFallbackContext {
  client: ClipApiClient;
  workspaceRoot: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function dirHasVideos(path: string): Promise<boolean> {
  try {
    await access(path);
    const videos = await scanEpisodeVideos(path);
    return videos.length > 0;
  } catch {
    return false;
  }
}

/**
 * 当 episode_asr 任务的 clip-local 路径在当前机器不存在时，
 * 根据 parentPackageTaskId 找到父 drama_package 任务，重新下载 zip 并解压，
 * 返回对应集号的本地视频路径。
 */
export async function resolveEpisodeFromPackageFallback(
  ctx: PackageFallbackContext,
  task: ClipTask,
): Promise<string> {
  if (task.taskKind !== "episode_asr") {
    throw new Error(`不支持的任务类型回退: ${task.taskKind}`);
  }
  if (!task.parentPackageTaskId) {
    throw new Error("episode_asr 任务缺少 parentPackageTaskId，无法回退下载");
  }
  if (task.episodeNo == null) {
    throw new Error("episode_asr 任务缺少 episodeNo，无法从剧包定位分集");
  }

  console.log(
    `[episode-fallback] 查询父任务 taskId=${task.parentPackageTaskId}，准备回退下载剧包`,
  );
  const parentTask = await ctx.client.getTask(task.parentPackageTaskId);
  if (!parentTask) {
    throw new Error(`父任务不存在: ${task.parentPackageTaskId}`);
  }
  if (parentTask.taskKind !== "drama_package") {
    throw new Error(
      `父任务不是 drama_package，无法回退: taskId=${parentTask.taskId} kind=${parentTask.taskKind}`,
    );
  }
  if (!parentTask.dramaPackage) {
    throw new Error(`父任务缺少 dramaPackage 元数据: ${parentTask.taskId}`);
  }

  const packageUrl = parentTask.sourceUrl;
  if (!/^https?:\/\//i.test(packageUrl)) {
    throw new Error(
      `父任务 sourceUrl 不是有效 HTTP(S) 下载链接，无法回退: ${packageUrl}`,
    );
  }

  const dramaId = parentTask.dramaId ?? task.dramaId;
  if (!dramaId) {
    throw new Error("父任务与当前任务均缺少 dramaId，无法定位缓存目录");
  }

  const packageKey =
    parentTask.dramaPackage.packageObjectKey || parentTask.dramaPackage.packageName;
  const batchDir = resolvePackageCacheDir(ctx.workspaceRoot, dramaId, packageKey);
  const zipPath = join(batchDir, parentTask.dramaPackage.packageName);
  const extractDir = join(batchDir, "extracted");

  console.log(
    `[episode-fallback] cacheDir=${batchDir} packageName=${parentTask.dramaPackage.packageName} episodeNo=${task.episodeNo}`,
  );

  if (!(await fileExists(zipPath)) && !(await dirHasVideos(extractDir))) {
    await mkdir(batchDir, { recursive: true });
    console.log(`[episode-fallback] 下载剧包: ${packageUrl}`);
    await downloadPackage(packageUrl, zipPath);
  } else {
    console.log(`[episode-fallback] 剧包本地缓存已存在 zip=${await fileExists(zipPath)} extracted=${await dirHasVideos(extractDir)}`);
  }

  if (!(await dirHasVideos(extractDir))) {
    console.log(`[episode-fallback] 解压剧包到: ${extractDir}`);
    await extractZipArchive(zipPath, extractDir);
  }

  const videos = await scanEpisodeVideos(extractDir);
  if (!videos.length) {
    throw new Error(`剧包解压后未找到视频文件: ${extractDir}`);
  }

  const matched = videos.find((v) => v.episodeNo === task.episodeNo);
  if (!matched) {
    const available = videos.map((v) => `${v.episodeNo}=${v.filename}`).join(", ");
    throw new Error(
      `剧包中未找到第 ${task.episodeNo} 集，可用集号: ${available}`,
    );
  }

  console.log(
    `[episode-fallback] 命中第 ${task.episodeNo} 集: ${matched.path}`,
  );

  // 缓存到本地集源注册表，便于后续任务直接复用
  if (task.dramaId && task.episodeId) {
    await saveEpisodeLocalSource(task.dramaId, task.episodeId, matched.path).catch(
      (err: unknown) =>
        console.warn(
          `[episode-fallback] 本地缓存注册失败（不影响本次执行）: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  }

  return matched.path;
}
