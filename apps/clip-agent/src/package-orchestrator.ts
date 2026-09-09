import { access, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipTask, EffectiveConfig } from "@clip/sdk";
import { downloadPackage } from "./package-downloader.js";
import { extractZipArchive } from "./package-extractor.js";
import { assertScanMatchesExpected, scanEpisodeVideos } from "./package-scanner.js";
import {
  cleanupEpisodeTaskWorkspaces,
  resolvePackageBatchDir,
  resolvePackageCacheDir,
  removePackageBatch,
} from "./package-cleaner.js";
import { registerEpisodeFile, createDramaMixTask } from "./material-submit.js";
import { saveEpisodeLocalSource } from "./local-source-registry.js";
import { upsertLocalDrama } from "./local-drama-catalog.js";
import type { AgentPipeline, ClipApiClient } from "./pipeline.js";
import {
  finishTaskProgress,
  startTaskProgress,
  updateDownloadProgress,
  updateTaskProgress,
} from "./task-progress.js";

interface EpisodeAsrIndex {
  dramaId: string;
  packageTaskId: string;
  mixTaskId?: string;
  episodes: Record<
    string,
    { taskId: string; episodeId: string; sourcePath: string; episodeNo: number }
  >;
}

async function upsertEpisodeAsrIndex(
  batchDir: string,
  patch: {
    dramaId: string;
    packageTaskId: string;
    mixTaskId?: string;
    episode?: { taskId: string; episodeId: string; sourcePath: string; episodeNo: number };
  },
): Promise<void> {
  const path = join(batchDir, "episode-asr-index.json");
  let data: EpisodeAsrIndex = {
    dramaId: patch.dramaId,
    packageTaskId: patch.packageTaskId,
    episodes: {},
  };
  try {
    const prev = JSON.parse(await readFile(path, "utf8")) as EpisodeAsrIndex;
    data = {
      dramaId: prev.dramaId || patch.dramaId,
      packageTaskId: prev.packageTaskId || patch.packageTaskId,
      mixTaskId: prev.mixTaskId,
      episodes: prev.episodes ?? {},
    };
  } catch {
    /* 首次写入 */
  }
  if (patch.mixTaskId) data.mixTaskId = patch.mixTaskId;
  if (patch.episode) {
    data.episodes[String(patch.episode.episodeNo)] = patch.episode;
  }
  data.dramaId = patch.dramaId;
  data.packageTaskId = patch.packageTaskId;
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}
export interface PackageOrchestratorContext {
  client: ClipApiClient;
  pipeline: AgentPipeline;
  apiBase: string;
  headers: Record<string, string>;
  workspaceRoot: string;
  deviceId: string;
  mockAsrFile?: string;
}

async function isUsableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function hasExtractedVideos(path: string): Promise<boolean> {
  try {
    await access(path);
    const videos = await scanEpisodeVideos(path);
    return videos.length > 0;
  } catch {
    return false;
  }
}

export async function processDramaPackageTask(
  task: ClipTask,
  config: EffectiveConfig,
  ctx: PackageOrchestratorContext,
): Promise<void> {
  if (!task.dramaPackage) {
    throw new Error("drama_package 任务缺少 dramaPackage 元数据");
  }
  if (!task.dramaId) {
    throw new Error("drama_package 任务缺少 dramaId");
  }

  const legacyBatchDir = resolvePackageBatchDir(ctx.workspaceRoot, task.taskId);
  const batchDir = resolvePackageCacheDir(
    ctx.workspaceRoot,
    task.dramaId,
    task.dramaPackage.packageObjectKey ?? task.dramaPackage.packageName,
  );
  const zipPath = join(batchDir, task.dramaPackage.packageName);
  const extractDir = join(batchDir, "extracted");
  const pipelineStartedAt = Date.now();
  const episodeTaskIds: string[] = [];
  let progressFinished = false;

  try {
    await mkdir(batchDir, { recursive: true });
    // 兼容旧版本按 taskId 保存的剧包缓存，迁移到稳定缓存目录。
    const legacyZipPath = join(legacyBatchDir, task.dramaPackage.packageName);
    const legacyExtractDir = join(legacyBatchDir, "extracted");
    if (!(await isUsableFile(zipPath)) && (await isUsableFile(legacyZipPath))) {
      await copyFile(legacyZipPath, zipPath);
    }
    if (!(await hasExtractedVideos(extractDir)) && (await hasExtractedVideos(legacyExtractDir))) {
      await cp(legacyExtractDir, extractDir, { recursive: true, force: true });
    }
    const packageUrl = task.sourceUrl;
    if (!/^https?:\/\//i.test(packageUrl)) {
      throw new Error(`drama_package 任务 sourceUrl 必须是完整 HTTP(S) 下载链接，当前: ${packageUrl}`);
    }

    console.log(`[package] taskId=${task.taskId} packageName=${task.dramaPackage.packageName}`);
    console.log(`[package] downloadUrl=${packageUrl}`);
    if (task.packageUrl && task.packageUrl !== packageUrl) {
      console.log(`[package] packageUrl=${task.packageUrl} (ignored, use sourceUrl)`);
    }
    if (task.dramaPackage.packageObjectKey) {
      console.log(`[package] packageObjectKey=${task.dramaPackage.packageObjectKey}`);
    }

    await writeFile(
      join(batchDir, "manifest.json"),
      JSON.stringify(
        {
          taskId: task.taskId,
          dramaId: task.dramaId,
          packageName: task.dramaPackage.packageName,
          title: task.dramaPackage.title,
          downloadUrl: packageUrl,
          phase: "downloading",
        },
        null,
        2,
      ),
    );

    const dramaTitle = task.dramaPackage.title;
    const cachedZip = await isUsableFile(zipPath);
    const cachedExtract = await hasExtractedVideos(extractDir);
    await ctx.pipeline.reportPackageCache({
      cacheKey: batchDir.split(/[\\/]/).pop(), dramaId: task.dramaId,
      packageTaskId: task.taskId, packageObjectKey: task.dramaPackage.packageObjectKey,
      packageName: task.dramaPackage.packageName, zipPath, extractPath: extractDir,
      zipExists: cachedZip, extracted: cachedExtract,
      status: cachedZip || cachedExtract ? "ready" : "downloading",
      lastUsedAt: new Date().toISOString(),
    }).catch((err: unknown) => console.warn(`[package] cache metadata report skipped: ${err instanceof Error ? err.message : String(err)}`));
    if (cachedZip || cachedExtract) {
      console.log(
        `[package] local cache hit zip=${cachedZip ? "yes" : "no"} extracted=${cachedExtract ? "yes" : "no"}`,
      );
    }
    if (!cachedZip && !cachedExtract) {
      await ctx.client.updatePackagePhase(task.taskId, "downloading");
      await startTaskProgress({
        taskId: task.taskId,
        title: dramaTitle,
        kind: "drama_package",
        phaseCode: "download",
        phase: "下载剧包到本地缓存…",
      });
      console.log(`[package] downloading ${task.dramaPackage.packageName} …`);
      await downloadPackage(packageUrl, zipPath, (p) => {
        void updateDownloadProgress({
          taskId: task.taskId,
          title: dramaTitle,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
        });
      });
    }

    if (!cachedExtract) {
      if (!(await isUsableFile(zipPath))) {
        throw new Error("本地剧包缓存不存在且无法重新下载");
      }
      console.log(`[package] extracting to ${extractDir}`);
      await ctx.client.updatePackagePhase(task.taskId, "extracting");
      await updateTaskProgress({
        active: true,
        taskId: task.taskId,
        title: dramaTitle,
        kind: "drama_package",
        phaseCode: "extract",
        phase: cachedZip ? "使用本地 ZIP 缓存并解压…" : "解压压缩包…",
        downloadPercent: undefined,
      });
      await extractZipArchive(zipPath, extractDir);
    } else {
      await updateTaskProgress({
        active: true,
        taskId: task.taskId,
        title: dramaTitle,
        kind: "drama_package",
        phaseCode: "extract",
        phase: "使用本地解压缓存…",
        downloadPercent: undefined,
      });
    }

    const videos = await scanEpisodeVideos(extractDir);
    await assertScanMatchesExpected(videos, task.dramaPackage.expectedEpisodeCount);
    await ctx.pipeline.reportPackageCache({
      cacheKey: batchDir.split(/[\\/]/).pop(), dramaId: task.dramaId,
      packageTaskId: task.taskId, packageObjectKey: task.dramaPackage.packageObjectKey,
      packageName: task.dramaPackage.packageName, zipPath, extractPath: extractDir,
      zipExists: true, extracted: true, episodeCount: videos.length,
      status: "ready", lastUsedAt: new Date().toISOString(),
    }).catch(() => undefined);
    console.log(`[package] found ${videos.length} episode videos`);

    await ctx.client.updatePackagePhase(task.taskId, "asr_episodes", {
      episodeCount: videos.length,
    });

    const episodeSources: Record<string, string> = {};
    const episodeIds: string[] = [];

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]!;
      const label = `[package ASR ${i + 1}/${videos.length}]`;
      await updateTaskProgress({
        active: true,
        taskId: task.taskId,
        title: dramaTitle,
        kind: "drama_package",
        phaseCode: "asr",
        phase: `语音识别 第 ${i + 1}/${videos.length} 集`,
        stepCurrent: i + 1,
        stepTotal: videos.length,
      });
      console.log(`${label} ${video.path}`);
      const submitted = await registerEpisodeFile(
        ctx.apiBase,
        ctx.headers,
        video.path,
        task.dramaId,
        video.episodeNo,
        task.taskId,
      );
      episodeSources[submitted.episodeId] = video.path;
      episodeIds.push(submitted.episodeId);
      episodeTaskIds.push(submitted.taskId);
      await saveEpisodeLocalSource(task.dramaId, submitted.episodeId, video.path);

      await ctx.pipeline.processEpisodeAsr(submitted.task, config, {
        sourceVideo: video.path,
        mockAsrFile: ctx.mockAsrFile,
        progress: {
          taskId: task.taskId,
          title: dramaTitle,
          kind: "drama_package",
          stepCurrent: i + 1,
          stepTotal: videos.length,
        },
      });
      await upsertEpisodeAsrIndex(batchDir, {
        dramaId: task.dramaId,
        packageTaskId: task.taskId,
        episode: {
          taskId: submitted.taskId,
          episodeId: submitted.episodeId,
          sourcePath: video.path,
          episodeNo: video.episodeNo,
        },
      });
      console.log(`${label} episode ${submitted.episodeId} ASR done`);
    }

    console.log(`[package] creating drama mix for ${task.dramaId} (${episodeIds.length} episodes)`);
    await ctx.client.updatePackagePhase(task.taskId, "mixing");
    await updateTaskProgress({
      active: true,
      taskId: task.taskId,
      title: dramaTitle,
      kind: "drama_package",
      phaseCode: "mix_plan",
      phase: "跨集混剪选段…",
    });
    const mix = await createDramaMixTask(
      ctx.apiBase,
      ctx.headers,
      task.dramaId,
      episodeIds,
      task.taskId,
    );
    await upsertEpisodeAsrIndex(batchDir, {
      dramaId: task.dramaId,
      packageTaskId: task.taskId,
      mixTaskId: mix.taskId,
    });

    await ctx.pipeline.processDramaMixTask(mix.task, config, {
      episodeSources,
      dramaPackage: task.dramaPackage,
      packageTaskId: task.taskId,
    });

    // 写入本机短剧目录，供桌面端「按短剧再混剪」复用解压分集
    const pkgMeta = (task.dramaMeta || {}) as Record<string, unknown>;
    const pkgGenre =
      (Array.isArray(pkgMeta.genreTags) &&
        pkgMeta.genreTags.map(String).find((t) => t.trim())) ||
      (typeof pkgMeta.genre === "string" ? pkgMeta.genre : undefined);
    const pkgSynopsis =
      typeof pkgMeta.synopsis === "string" ? pkgMeta.synopsis.trim() : undefined;
    const pkgDramaType =
      typeof pkgMeta.dramaType === "string" ? pkgMeta.dramaType.trim() : undefined;
    await upsertLocalDrama({
      dramaId: task.dramaId,
      title: dramaTitle || task.dramaId,
      genre: pkgGenre?.trim() || undefined,
      synopsis: pkgSynopsis || undefined,
      dramaType: pkgDramaType || undefined,
      source: "package_cache",
      packageCacheKey: batchDir.split(/[\\/]/).pop(),
      episodes: videos.map((v) => ({
        path: v.path,
        episodeNo: v.episodeNo,
        name: v.filename || `ep${v.episodeNo}`,
      })),
    });

    const timing = {
      processingStartedAt: new Date(pipelineStartedAt).toISOString(),
      totalWallTimeSec: Math.round((Date.now() - pipelineStartedAt) / 1000),
    };
    await ctx.client.updatePackagePhase(task.taskId, "cleaning");
    await updateTaskProgress({
      active: true,
      taskId: task.taskId,
      title: dramaTitle,
      kind: "drama_package",
      phaseCode: "cleaning",
      phase: "清理临时文件…",
    });
    await cleanupEpisodeTaskWorkspaces(ctx.workspaceRoot, episodeTaskIds);
    await removePackageBatch(batchDir);
    console.log(`[package] batch cache removed: ${batchDir}`);
    await ctx.client.completePackageTask(task.taskId, mix.taskId, timing);
    await finishTaskProgress({ phase: "批次任务已完成" });
    progressFinished = true;
    console.log(`[package] processing workspace cleaned; package cache preserved: ${batchDir}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[package] failed taskId=${task.taskId} downloadUrl=${task.sourceUrl} error=${message}`);
    await finishTaskProgress({ phase: "批次任务失败", error: message });
    progressFinished = true;
    await ctx.client.failTask(task.taskId, message);
    throw err;
  } finally {
    if (!progressFinished) {
      await finishTaskProgress({ phase: "批次任务已结束" });
    }
  }
}
