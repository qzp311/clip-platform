#!/usr/bin/env node
import { Command } from "commander";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { initAgentLogger } from "./logger.js";
import { setPaused } from "./control.js";
import { AgentDaemon } from "./agent-daemon.js";
import { assertGpu4060 } from "./gpu-check.js";
import { startMockFunasrServer } from "./mock-funasr-server.js";
import { resolveAgentPaths, resolveFunasrLaunch, findRepoRoot } from "./paths.js";
import { FunasrSidecar } from "./funasr-sidecar.js";
import { AgentPipeline, ClipApiClient } from "./pipeline.js";
import { credentialsPath, resolveApiBase } from "./config.js";
import { ensureRegistered } from "./auto-register.js";
import {
  createMaterialJob,
  saveMaterialJob,
  updateMaterialJob,
  listMaterialJobs,
} from "./material-jobs.js";
import {
  finishTaskProgress,
  startTaskProgress,
  updateTaskProgress,
} from "./task-progress.js";
import { submitMaterialFile, submitEpisodeFile, createDramaMixTask, registerMaterialFile, registerEpisodeFile, registerOutputFile, uploadRemixReplicaSource } from "./material-submit.js";
import { saveEpisodeLocalSource, saveTaskLocalSource } from "./local-source-registry.js";
import { saveOutputAsrIndex } from "./output-asr-index.js";
import { assertHasAudioStream, assertVideoFile } from "./media.js";
import { runDramaMix } from "./run-drama-mix.js";
import { listLocalDramas, resolveLocalDramaId, getLocalDrama } from "./local-drama-catalog.js";
import { ensureFfmpegCapabilitiesProbed } from "./startup-env.js";
import { getTosStorageConfig } from "@clip/sdk";
import { uploadOutputVideoToTos } from "./tos-client.js";
import { runMaterialFission } from "./material-fission-runner.js";
import { FISSION_OP_KINDS, type FissionOpKind } from "@clip/agent-core";
import { runRemixReplicaLocal } from "./run-remix-replica-local.js";

const program = new Command();

async function validateSourceVideo(source: string, ffprobePath?: string): Promise<void> {
  assertVideoFile(source);
  await assertHasAudioStream(source, ffprobePath ?? "ffprobe");
}

interface MaterialProcessOpts {
  source: string;
  mockAsr?: string;
  installDir?: string;
  ffmpeg?: string;
}

async function processMaterialSource(
  client: ClipApiClient,
  pipeline: AgentPipeline,
  apiBase: string,
  headers: Record<string, string>,
  opts: MaterialProcessOpts,
): Promise<{ jobId: string; taskId: string; outputUrl?: string }> {
  const submitted = await registerMaterialFile(apiBase, headers, opts.source);
  const job = createMaterialJob({
    localPath: opts.source,
    taskId: submitted.taskId,
    sourceUrl: submitted.sourceUrl,
  });
  await saveMaterialJob(job);
  await saveTaskLocalSource(submitted.taskId, opts.source);
  console.log(`material registered taskId=${submitted.taskId} jobId=${job.jobId} (local only, no upload)`);

  await updateMaterialJob(job.jobId, { status: "processing" });

  try {
    // register 本地素材后任务已经由当前 CLI 明确接管，不再走 daemon 的 pending claim。
    // claim 竞争会在任务已被服务端重置/领取时返回 null，导致本地处理无意义失败。
    const registeredTask = await client.getTask(submitted.taskId);
    const taskConfig = await client.fetchConfig(registeredTask.asrRuleSetId);
    await pipeline.processClaimedTask(registeredTask, taskConfig, {
      sourceVideo: opts.source,
      mockAsrFile: opts.mockAsr,
      progressJobId: job.jobId,
    });
    const task = await client.getTask(submitted.taskId);
    await updateMaterialJob(job.jobId, {
      status: "completed",
      outputUrl: task.outputUrl,
      subtitleUrl: task.subtitleUrl,
      totalWallTimeSec: task.totalWallTimeSec,
    });
    return { jobId: job.jobId, taskId: submitted.taskId, outputUrl: task.outputUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateMaterialJob(job.jobId, {
      status: "failed",
      error: message,
    });
    throw err;
  }
}

async function startFunasrSidecar(
  pipeline: AgentPipeline,
  paths: ReturnType<typeof resolveAgentPaths>,
): Promise<FunasrSidecar> {
  const launch = resolveFunasrLaunch(paths);
  const sidecar = new FunasrSidecar({ launch });
  console.log(`starting funasr-server: ${launch.command} ${launch.args.join(" ")}`);
  await sidecar.start();
  pipeline.setSidecar(sidecar);
  return sidecar;
}

function buildClientOpts(
  opts: { apiBase?: string; ffmpeg?: string; installDir?: string },
  creds: { deviceId: string; deviceToken: string },
) {
  const repoRoot = findRepoRoot();
  const paths = resolveAgentPaths({
    installDir: opts.installDir,
    ffmpegPath: opts.ffmpeg,
  });
  return {
    apiBase: resolveApiBase(repoRoot, opts.apiBase),
    credentials: creds,
    ffmpegPath: paths.ffmpegPath,
    ffprobePath: paths.ffprobePath,
    workspaceDir: paths.workspaceDir,
    fontsDir: paths.fontsDir,
    stickersDir: paths.stickersDir,
  };
}

program.name("clip-agent").description("drama-clip · 短剧 AI 智能剪辑平台 — Windows Agent");

program
  .command("register")
  .option("--api-base <url>", "API base URL")
  .option("--machine-id <id>", "machine id")
  .action(async (opts) => {
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);
  });

program
  .command("run")
  .description("daemon: start ASR sidecar and poll for tasks")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--funasr-server <path>", "funasr-server binary or entry script")
  .option("--funasr-models <path>", "ASR models directory")
  .option("--mock-asr <path>", "use mock ASR json instead of funasr-server")
  .option("--poll-interval <ms>", "task poll interval", "5000")
  .action(async (opts) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);
    const daemon = new AgentDaemon(client, pipeline, {
      ...clientOpts,
      installDir: opts.installDir,
      funasrServerPath: opts.funasrServer,
      funasrModelsDir: opts.funasrModels,
      mockAsrFile: opts.mockAsr,
      pollIntervalMs: Number(opts.pollInterval),
    });

    const shutdown = async () => {
      console.log("shutting down...");
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await daemon.start();
  });

program
  .command("run-once")
  .option("--api-base <url>", "API base URL")
  .option("--source <path>", "source video path (overrides task sourceUrl)")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .option("--ffmpeg <path>", "ffmpeg binary")
  .option("--funasr-server <path>", "funasr-server binary or entry script")
  .option("--funasr-models <path>", "ASR models directory")
  .option("--install-dir <path>", "engines/install directory")
  .action(async (opts) => {
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    if (opts.source) {
      if (!opts.mockAsr) {
        const paths = resolveAgentPaths({
          installDir: opts.installDir,
          ffmpegPath: opts.ffmpeg,
        });
        await validateSourceVideo(opts.source, paths.ffprobePath);
      } else {
        assertVideoFile(opts.source);
      }
    }
    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);

    let sidecar: FunasrSidecar | null = null;
    if (!opts.mockAsr) {
      const paths = resolveAgentPaths({
        installDir: opts.installDir,
        ffmpegPath: opts.ffmpeg,
        funasrServerPath: opts.funasrServer,
        funasrModelsDir: opts.funasrModels,
      });
      await ensureFfmpegCapabilitiesProbed(paths);
      const launch = resolveFunasrLaunch(paths);
      sidecar = new FunasrSidecar({ launch });
      console.log(`starting funasr-server: ${launch.command} ${launch.args.join(" ")}`);
      await sidecar.start();
      pipeline.setSidecar(sidecar);
    } else {
      const paths = resolveAgentPaths({
        installDir: opts.installDir,
        ffmpegPath: opts.ffmpeg,
      });
      await ensureFfmpegCapabilitiesProbed(paths);
    }

    try {
      await pipeline.runOnce({
        sourceVideo: opts.source,
        mockAsrFile: opts.mockAsr,
      });
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("config")
  .option("--api-base <url>", "API base URL")
  .action(async (opts) => {
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);
    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };
    const client = new ClipApiClient({ apiBase, credentials: creds });
    const config = await client.fetchConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("pause")
  .description("pause task polling (heartbeat continues)")
  .action(async () => {
    await setPaused(true);
    console.log("agent paused");
  });

program
  .command("resume")
  .description("resume task polling")
  .action(async () => {
    await setPaused(false);
    console.log("agent resumed");
  });

program
  .command("upload")
  .description("copy a local video into the inbox folder")
  .requiredOption("--source <path>", "source video path")
  .action(async (opts: { source: string }) => {
    const paths = resolveAgentPaths({});
    await mkdir(paths.inboxDir, { recursive: true });
    const name = `${Date.now()}_${basename(opts.source)}`;
    const dest = join(paths.inboxDir, name);
    await copyFile(opts.source, dest);
    console.log(`uploaded to inbox: ${dest}`);
  });

program
  .command("upload-and-process")
  .description("upload local video to API, create task, then run ASR + clip")
  .requiredOption("--source <path>", "source video path")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .action(async (opts) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    if (!opts.mockAsr) {
      const paths = resolveAgentPaths({
        installDir: opts.installDir,
        ffmpegPath: opts.ffmpeg,
      });
      await validateSourceVideo(opts.source, paths.ffprobePath);
    } else {
      assertVideoFile(opts.source);
    }

    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);
    let sidecar: FunasrSidecar | null = null;
    try {
      if (!opts.mockAsr) {
        const paths = resolveAgentPaths({
          installDir: opts.installDir,
          ffmpegPath: opts.ffmpeg,
        });
        sidecar = await startFunasrSidecar(pipeline, paths);
      }

      const result = await processMaterialSource(
        client,
        pipeline,
        apiBase,
        client.jsonHeaders(),
        opts,
      );
      console.log(JSON.stringify(result));
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("batch-upload-and-process")
  .description("register local episodes (no upload), ASR each episode, then cross-episode mix")
  .requiredOption("--source <path>", "source video path", (value, previous: string[] = []) => [...previous, value])
  .option("--api-base <url>", "API base URL")
  .option("--drama-id <id>", "drama id for all episodes")
  .option("--drama-title <title>", "short drama display title")
  .option("--drama-genre <genre>", "题材标签")
  .option("--drama-synopsis <text>", "作品简介")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .action(async (opts: MaterialProcessOpts & {
    source: string[];
    apiBase?: string;
    dramaId?: string;
    dramaTitle?: string;
    dramaGenre?: string;
    dramaSynopsis?: string;
  }) => {
    const sources = [...new Set(opts.source.filter(Boolean))];
    if (sources.length === 0) {
      throw new Error("至少需要一个视频文件");
    }

    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    const paths = resolveAgentPaths({
      installDir: opts.installDir,
      ffmpegPath: opts.ffmpeg,
    });
    await ensureFfmpegCapabilitiesProbed(paths);

    if (!opts.mockAsr) {
      for (const source of sources) {
        await validateSourceVideo(source, paths.ffprobePath);
      }
    } else {
      for (const source of sources) {
        assertVideoFile(source);
      }
    }

    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);
    let sidecar: FunasrSidecar | null = null;
    const title = (opts.dramaTitle || "").trim() || basename(sources[0]!);
    const dramaId = await resolveLocalDramaId({ dramaId: opts.dramaId, title });

    try {
      if (!opts.mockAsr) {
        sidecar = await startFunasrSidecar(pipeline, paths);
      }
      const result = await runDramaMix({
        apiBase,
        headers: client.jsonHeaders(),
        client,
        pipeline,
        dramaId,
        title,
        genre: (opts.dramaGenre || "").trim() || undefined,
        synopsis: (opts.dramaSynopsis || "").trim() || undefined,
        sources,
        sourceKind: "inbox",
        mockAsrFile: opts.mockAsr,
      });
      console.log(JSON.stringify(result));
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("run-drama-mix")
  .description("按短剧自动混剪：缺 ASR 补识别后跨集混剪（素材需已在本机）")
  .option("--drama-id <id>", "drama id")
  .option("--drama-title <title>", "short drama display title")
  .option("--drama-genre <genre>", "题材标签")
  .option("--drama-synopsis <text>", "作品简介")
  .option("--source <path>", "episode video path", (value, previous: string[] = []) => [...previous, value])
  .option("--source-kind <kind>", "inbox | package_cache", "inbox")
  .option("--package-cache-key <key>", "package cache folder name")
  .option("--api-base <url>", "API base URL")
    .option("--install-dir <path>", "engines/install directory")
    .option("--ffmpeg <path>", "ffmpeg binary path")
    .option("--mock-asr <path>", "mock raw ASR json file")
    .option("--asr-only", "仅 ASR，不创建混剪任务")
    .option("--force-asr", "强制重新识别，忽略库中已有 ASR")
    .action(async (opts: {
      dramaId?: string;
      dramaTitle?: string;
      dramaGenre?: string;
      dramaSynopsis?: string;
      source?: string[];
      sourceKind?: string;
      packageCacheKey?: string;
      apiBase?: string;
      installDir?: string;
      ffmpeg?: string;
      mockAsr?: string;
      asrOnly?: boolean;
      forceAsr?: boolean;
    }) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const title = (opts.dramaTitle || "").trim();
    let dramaId = (opts.dramaId || "").trim();
    let sources = [...new Set((opts.source || []).filter(Boolean))];

    if (!dramaId && !title && sources.length === 0) {
      throw new Error("需要 --drama-id / --drama-title，或提供 --source");
    }

    if (dramaId && sources.length === 0) {
      const local = await getLocalDrama(dramaId);
      if (!local?.episodes?.length) {
        throw new Error(`本机短剧目录中未找到 ${dramaId} 的分集路径，请先导入或指定 --source`);
      }
      sources = local.episodes.map((e) => e.path);
      if (!title) {
        opts.dramaTitle = local.title;
      }
      if (!opts.dramaGenre?.trim() && local.genre) opts.dramaGenre = local.genre;
      if (!opts.dramaSynopsis?.trim() && local.synopsis) opts.dramaSynopsis = local.synopsis;
    }

    dramaId = await resolveLocalDramaId({
      dramaId: dramaId || undefined,
      title: title || basename(sources[0] || "drama"),
    });
    const displayTitle = title || (await getLocalDrama(dramaId))?.title || basename(sources[0]!);
    const localRow = await getLocalDrama(dramaId);
    const genre = (opts.dramaGenre || "").trim() || localRow?.genre || undefined;
    const synopsis = (opts.dramaSynopsis || "").trim() || localRow?.synopsis || undefined;

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };
    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    const paths = resolveAgentPaths({
      installDir: opts.installDir,
      ffmpegPath: opts.ffmpeg,
    });
    await ensureFfmpegCapabilitiesProbed(paths);

    if (!opts.mockAsr) {
      for (const source of sources) {
        await validateSourceVideo(source, paths.ffprobePath);
      }
    } else {
      for (const source of sources) {
        assertVideoFile(source);
      }
    }

    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);
    let sidecar: FunasrSidecar | null = null;
    const sourceKind = opts.sourceKind === "package_cache" ? "package_cache" : "inbox";

    try {
      if (!opts.mockAsr) {
        sidecar = await startFunasrSidecar(pipeline, paths);
      }
      const result = await runDramaMix({
        apiBase,
        headers: client.jsonHeaders(),
        client,
        pipeline,
        dramaId,
        title: displayTitle,
        genre,
        synopsis,
        sources,
        sourceKind,
        packageCacheKey: opts.packageCacheKey,
        mockAsrFile: opts.mockAsr,
        asrOnly: opts.asrOnly,
        forceAsr: opts.forceAsr,
      });
      console.log(JSON.stringify(result));
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("list-local-dramas")
  .description("列出本机已登记的短剧（可供桌面端混剪）")
  .action(async () => {
    const rows = await listLocalDramas();
    console.log(JSON.stringify({ dramas: rows }, null, 2));
  });

program
  .command("submit-material")
  .description("register local video path on server (no upload) and create a pending clip task")
  .requiredOption("--source <path>", "source video path")
  .option("--api-base <url>", "API base URL")
  .option("--upload", "legacy: upload source video to server OSS")
  .action(async (opts: { source: string; apiBase?: string; upload?: boolean }) => {
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);
    assertVideoFile(opts.source);
    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };
    const client = new ClipApiClient({ apiBase, credentials: creds });
    const headers = client.jsonHeaders();
    const submitted = opts.upload
      ? await submitMaterialFile(apiBase, headers, opts.source)
      : await registerMaterialFile(apiBase, headers, opts.source);
    const job = createMaterialJob({
      localPath: opts.source,
      taskId: submitted.taskId,
      sourceUrl: submitted.sourceUrl,
    });
    await saveMaterialJob(job);
    if (!opts.upload) {
      await saveTaskLocalSource(submitted.taskId, opts.source);
    }
    console.log(JSON.stringify({ jobId: job.jobId, taskId: submitted.taskId, sourceUrl: submitted.sourceUrl }));
  });

program
  .command("process-output-asr")
  .description("register local output video and run ASR + highlight scoring only")
  .requiredOption("--source <path>", "local output video path")
  .option("--parent-task-id <id>", "parent mix/package/single task id")
  .option("--drama-id <id>", "drama id")
  .option("--drama-title <title>", "drama title for stub meta")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .action(async (opts: {
    source: string;
    parentTaskId?: string;
    dramaId?: string;
    dramaTitle?: string;
    apiBase?: string;
    installDir?: string;
    ffmpeg?: string;
    mockAsr?: string;
  }) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };
    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    const paths = resolveAgentPaths({
      installDir: opts.installDir,
      ffmpegPath: opts.ffmpeg,
    });
    if (!opts.mockAsr) {
      await validateSourceVideo(opts.source, paths.ffprobePath);
    } else {
      assertVideoFile(opts.source);
    }

    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);
    let sidecar: FunasrSidecar | null = null;
    try {
      if (!opts.mockAsr) {
        sidecar = await startFunasrSidecar(pipeline, paths);
      }

      let dramaId = opts.dramaId?.trim() || undefined;
      if (!dramaId && opts.parentTaskId) {
        try {
          const parent = await client.getTask(opts.parentTaskId);
          dramaId = parent.dramaId || undefined;
          if (dramaId) {
            console.log(`[output-asr] inherit dramaId=${dramaId} from parent ${opts.parentTaskId}`);
          }
        } catch { /* ignore */ }
      }

      const dramaTitle = opts.dramaTitle?.trim() || undefined;

      const submitted = await registerOutputFile(apiBase, client.jsonHeaders(), opts.source, {
        dramaId,
        parentTaskId: opts.parentTaskId,
        dramaMeta: dramaTitle ? { title: dramaTitle } : undefined,
      });
      await saveTaskLocalSource(submitted.taskId, opts.source);
      console.log(`output registered taskId=${submitted.taskId} (ASR only)`);

      const registeredTask = await client.getTask(submitted.taskId);
      const taskConfig = await client.fetchConfig(registeredTask.asrRuleSetId);
      await pipeline.processClaimedTask(registeredTask, taskConfig, {
        sourceVideo: opts.source,
        mockAsrFile: opts.mockAsr,
      });

      await saveOutputAsrIndex(opts.source, {
        taskId: submitted.taskId,
        parentTaskId: opts.parentTaskId,
      });
      console.log(JSON.stringify({
        taskId: submitted.taskId,
        sourceUrl: submitted.sourceUrl,
        parentTaskId: opts.parentTaskId || null,
      }));
    } catch (err) {
      await finishTaskProgress({
        phase: "成片识别失败",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("upload-outputs-tos")
  .description("将本地成片直传 TOS（视频+封面）")
  .option(
    "--source <path>",
    "本地成片路径（可重复传多个；也可用 --manifest）",
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[],
  )
  .option("--manifest <path>", "JSON 清单：{ dramaTitle?, items:[{ path, taskId? }] }")
  .option("--drama-title <title>", "短剧名（用于 TOS 目录归档；缺省从文件名推断）")
  .option("--task-id <id>", "关联任务 ID（单文件或作为缺省 taskId）")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .action(async (opts: {
    source: string[];
    manifest?: string;
    dramaTitle?: string;
    taskId?: string;
    apiBase?: string;
    installDir?: string;
    ffmpeg?: string;
  }) => {
    type UploadItem = { path: string; taskId?: string; dramaTitle?: string };
    const items: UploadItem[] = [];
    if (opts.manifest?.trim()) {
      const raw = JSON.parse(await readFile(opts.manifest.trim(), "utf-8")) as {
        dramaTitle?: string;
        items?: Array<{ path?: string; taskId?: string; dramaTitle?: string }>;
      };
      for (const it of raw.items || []) {
        const p = String(it.path || "").trim();
        if (!p) continue;
        items.push({
          path: p,
          taskId: it.taskId?.trim() || undefined,
          dramaTitle: it.dramaTitle?.trim() || raw.dramaTitle?.trim() || undefined,
        });
      }
      if (!opts.dramaTitle?.trim() && raw.dramaTitle?.trim()) {
        opts.dramaTitle = raw.dramaTitle.trim();
      }
    }
    for (const s of opts.source || []) {
      const p = String(s || "").trim();
      if (!p) continue;
      if (items.some((it) => it.path === p)) continue;
      items.push({ path: p, taskId: opts.taskId?.trim() || undefined });
    }
    if (!items.length) {
      throw new Error("请至少指定一个 --source 或 --manifest 成片路径");
    }

    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };
    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    const paths = resolveAgentPaths({
      installDir: opts.installDir,
      ffmpegPath: opts.ffmpeg,
    });
    const client = new ClipApiClient(clientOpts);
    const config = await client.fetchConfig();
    const tos = getTosStorageConfig(config);
    if (!tos?.enabled) {
      throw new Error("未开启 TOS 上传：请在管理台配置 render.storage.tos 并启用");
    }

    const inferTitle = (filePath: string): string => {
      const base = basename(filePath).replace(/\.mp4$/i, "");
      let stem = base;
      // 去掉 -autoclip
      stem = stem.replace(/-autoclip$/i, "");
      const parts = stem.split("-");
      if (parts.length >= 4) {
        const ts = parts[parts.length - 1] || "";
        const seq = parts[parts.length - 2] || "";
        const batch = parts[parts.length - 3] || "";
        if (/^\d{10,}$/.test(ts) && /^\d+$/.test(seq) && /^\d+$/.test(batch)) {
          const title = parts.slice(0, -3).join("-").trim();
          if (title) return title;
        }
      }
      return opts.dramaTitle?.trim() || "未分类";
    };

    const isPersistableTaskId = (id?: string): id is string => {
      const t = String(id || "").trim();
      if (!t) return false;
      if (t.startsWith("lib-upload-")) return false;
      if (t === "成片" || t === "解压分集" || t === "upload-tos") return false;
      return true;
    };

    const progressTaskId = opts.taskId?.trim() || `lib-upload-${Date.now()}`;
    const total = items.length;
    await startTaskProgress({
      taskId: progressTaskId,
      title: `推送 TOS（${total}）`,
      kind: "upload",
      phaseCode: "upload",
      phase: `准备上传 ${total} 条成片…`,
      stepCurrent: 0,
      stepTotal: total,
    });

    let ok = 0;
    let persisted = 0;
    const errors: string[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const source = item.path;
        assertVideoFile(source);
        const name = basename(source);
        const dramaTitle = item.dramaTitle?.trim() || opts.dramaTitle?.trim() || inferTitle(source);
        const parentTaskId = isPersistableTaskId(item.taskId)
          ? item.taskId!.trim()
          : isPersistableTaskId(opts.taskId)
            ? opts.taskId!.trim()
            : "";
        // 无父任务时用临时 ID 占位（不进 clip_task_output）
        const albumTaskId = parentTaskId || `lib-upload-${Date.now()}-${i + 1}`;

        await updateTaskProgress({
          taskId: progressTaskId,
          title: `推送 TOS（${i + 1}/${total}）`,
          kind: "upload",
          phaseCode: "upload",
          phase: `上传中 ${i + 1}/${total}：${name}`,
          stepCurrent: i,
          stepTotal: total,
        });
        console.log(
          `[upload-tos] ${i + 1}/${total} ${name} drama=${dramaTitle}`
            + (parentTaskId ? ` task=${parentTaskId}` : " task=(none)"),
        );

        try {
          const url = await uploadOutputVideoToTos(config, {
            taskId: albumTaskId,
            outputPath: source,
            filename: name,
            folderSegment: dramaTitle,
            ffmpegPath: paths.ffmpegPath,
          });

          // 手动 push-tos 的源已在 ClipOutput 目录，上传后保留原文件
          console.log(`[upload-tos] 保留本地文件: ${source}`);
          ok += 1;
          console.log(`[upload-tos] ok ${name} -> ${url}`);

          if (parentTaskId) {
            try {
              await client.appendTaskOutput(parentTaskId, {
                outputUrl: url,
                localOutputPath: source,
                filename: name,
              });
              persisted += 1;
              console.log(`[upload-tos] 已回写 clip_task_output task=${parentTaskId}`);
            } catch (persistErr) {
              const pm = persistErr instanceof Error ? persistErr.message : String(persistErr);
              errors.push(`${name}: TOS 已成功但回写任务产出失败: ${pm}`);
              console.error(`[upload-tos] persist fail ${name}: ${pm}`);
            }
          } else {
            try {
              const created = await client.registerUploadedOutput({
                outputUrl: url,
                localOutputPath: source,
                filename: name,
                dramaTitle,
              });
              persisted += 1;
              console.log(
                `[upload-tos] 无父任务，已新建任务并入库 task=${created.taskId}`,
              );
            } catch (persistErr) {
              const pm = persistErr instanceof Error ? persistErr.message : String(persistErr);
              errors.push(`${name}: TOS 已成功但登记产出失败: ${pm}`);
              console.error(`[upload-tos] register fail ${name}: ${pm}`);
            }
          }
        } catch (err) {
          const em = err instanceof Error ? err.message : String(err);
          errors.push(`${name}: ${em}`);
          console.error(`[upload-tos] fail ${name}: ${em}`);
        }

        await updateTaskProgress({
          taskId: progressTaskId,
          title: `推送 TOS（${i + 1}/${total}）`,
          kind: "upload",
          phaseCode: "upload",
          phase: `已处理 ${i + 1}/${total}（成功 ${ok}，已入库 ${persisted}）`,
          stepCurrent: i + 1,
          stepTotal: total,
        });
      }

      if (!ok) {
        throw new Error(`全部上传失败：${errors.slice(0, 3).join("；")}`);
      }
      await finishTaskProgress({
        phase: `TOS 上传完成：成功 ${ok}/${total}，入库 ${persisted}`
          + (errors.length ? `，告警 ${errors.length}` : ""),
      });
      console.log(
        JSON.stringify({
          ok,
          total,
          persisted,
          fail: errors.length,
          errors: errors.slice(0, 8),
        }),
      );
    } catch (err) {
      await finishTaskProgress({
        phase: "TOS 上传失败",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

program
  .command("create-remix-replica")
  .description("本地直跑案例复刻：选好案例和原片后直接在本地完成匹配和渲染")
  .option("--fission-count <n>", "裂变数量", parseInt)
  .option("--fission-op <op>", "裂变操作（可重复）", (value, previous: string[] = []) => [...previous, value])
  .option("--case <path>", "案例视频路径（可重复）", (value, previous: string[] = []) => [
    ...previous,
    value,
  ])
  .requiredOption("--source <path>", "原片路径（可重复）", (value, previous: string[] = []) => [
    ...previous,
    value,
  ])
  .option("--title <title>", "短剧名称（用于输出文件名）")
  .option("--out-dir <dir>", "输出目录")
  .option("--api-base <url>", "API base URL（用于上传成片）")
  .action(async (opts: { case?: string[]; source: string[]; title?: string; outDir?: string; apiBase?: string; fissionCount?: number; fissionOp?: string[] }) => {
    const cases = Array.isArray(opts.case) ? opts.case.filter(Boolean) : [];
    const sources = Array.isArray(opts.source) ? opts.source.filter(Boolean) : [];
    if (!cases.length || !sources.length) throw new Error("案例视频和原片至少各需要一个");
    for (const p of [...cases, ...sources]) assertVideoFile(p);

    const repoRoot = findRepoRoot();
    const paths = resolveAgentPaths();
    const pythonPath = process.env.CLIP_PYTHON || paths.pythonPath;

    const outDir =
      String(opts.outDir || "").trim() || join(repoRoot, "data", "remix-output");
    const workDir = join(repoRoot, "data", "remix-work", `${Date.now()}`);
    // 原片特征缓存用固定目录，同一批原片跨次复刻直接复用
    const cacheDir = join(repoRoot, "data", "remix-cache");

    const title = opts.title?.trim() || "";
    const result = await runRemixReplicaLocal({
      casePaths: cases,
      sourcePaths: sources,
      workDir,
      outputDir: outDir,
      cacheDir,
      title,
      fissionEnabled: (opts.fissionCount ?? 0) > 0,
      fissionCount: opts.fissionCount ?? 0,
      fissionOps: (opts.fissionOp as string[] | undefined),
      ffmpegPath: paths.ffmpegPath,
      ffprobePath: paths.ffprobePath,
      pythonPath,
    });

    // 自动上传成片到服务端
    let outputUrl = "";
    try {
      const apiBase = resolveApiBase(repoRoot, opts.apiBase);
      await ensureRegistered(apiBase);
      const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
        deviceId: string;
        deviceToken: string;
      };
      const config = await (new ClipApiClient({ apiBase, credentials: creds })).fetchConfig();
      const tos = getTosStorageConfig(config);
      if (tos?.enabled) {
        outputUrl = await uploadOutputVideoToTos(config, {
          taskId: `local-remix-${Date.now()}`,
          outputPath: result.outputPath,
          filename: basename(result.outputPath),
          folderSegment: title || "未分类",
          ffmpegPath: paths.ffmpegPath,
          ffprobePath: paths.ffprobePath,
        });
        console.log(`[remix-local] 成片已上传: ${outputUrl}`);
        // 上传裂变素材
        if (result.fissionOutputPaths?.length) {
          for (const fp of result.fissionOutputPaths) {
            try {
              const fUrl = await uploadOutputVideoToTos(config, {
                taskId: 'local-remix-' + Date.now(),
                outputPath: fp,
                filename: basename(fp),
                folderSegment: title || '未分类',
                ffmpegPath: paths.ffmpegPath,
                ffprobePath: paths.ffprobePath,
              });
              console.log('[remix-local] 裂变已上传: ' + fUrl);
              unlinkSync(fp);
            } catch (fe) {
              const fmsg = fe instanceof Error ? fe.message : String(fe);
              console.warn('[remix-local] 裂变上传失败，保留本地: ' + fmsg.slice(0, 200));
            }
          }
        }
        // 上传成功后删本地主成片
        try { unlinkSync(result.outputPath); console.log('[remix-local] 已删除本地成片: ' + result.outputPath); } catch (de) {}
      } else {
        console.log("[remix-local] TOS 未启用，成片仅保留本地");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[remix-local] 上传失败，成片仍保留本地: ${msg.slice(0, 200)}`);
    }

    // 机器可读结果走 stdout
    const out = {
      outputPath: result.outputPath,
      outputUrl: outputUrl || undefined,
      matchedSeconds: Math.round(result.analysis.matched_seconds * 10) / 10,
      unmatchedSeconds: Math.round(result.analysis.unmatched_seconds * 10) / 10,
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    console.log(`案例复刻完成: ${result.outputPath}`);
  });

program
  .command("process-task")
  .description("claim a specific task and run ASR + clip pipeline")
  .requiredOption("--task-id <id>", "cloud task id")
  .requiredOption("--source <path>", "local source video path")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .option("--job-id <id>", "material job id to update status")
  .action(async (opts) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    if (opts.source) {
      if (!opts.mockAsr) {
        const paths = resolveAgentPaths({
          installDir: opts.installDir,
          ffmpegPath: opts.ffmpeg,
        });
        await validateSourceVideo(opts.source, paths.ffprobePath);
      } else {
        assertVideoFile(opts.source);
      }
    }
    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);

    if (opts.jobId) {
      await updateMaterialJob(opts.jobId, { status: "processing" });
    }

    let sidecar: FunasrSidecar | null = null;
    try {
      if (!opts.mockAsr) {
        const paths = resolveAgentPaths({
          installDir: opts.installDir,
          ffmpegPath: opts.ffmpeg,
        });
        const launch = resolveFunasrLaunch(paths);
        sidecar = new FunasrSidecar({ launch });
        console.log(`starting funasr-server: ${launch.command} ${launch.args.join(" ")}`);
        await sidecar.start();
        pipeline.setSidecar(sidecar);
      }

      await pipeline.processTask(opts.taskId, opts.source, opts.mockAsr, opts.jobId);

      if (opts.jobId) {
        const task = await client.getTask(opts.taskId);
        await updateMaterialJob(opts.jobId, {
          status: "completed",
          outputUrl: task.outputUrl,
          subtitleUrl: task.subtitleUrl,
          totalWallTimeSec: task.totalWallTimeSec,
        });
      }
    } catch (err) {
      if (opts.jobId) {
        await updateMaterialJob(opts.jobId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      if (sidecar) await sidecar.stop();
    }
  });

program
  .command("list-jobs")
  .description("list recent material processing jobs")
  .action(async () => {
    const jobs = await listMaterialJobs();
    console.log(JSON.stringify(jobs, null, 2));
  });

program
  .command("process-file")
  .description("process a local video (claims next pending cloud task)")
  .requiredOption("--source <path>", "source video path")
  .option("--api-base <url>", "API base URL")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .option("--mock-asr <path>", "mock raw ASR json file")
  .action(async (opts) => {
    await assertGpu4060();
    const repoRoot = findRepoRoot();
    const apiBase = resolveApiBase(repoRoot, opts.apiBase);
    await ensureRegistered(apiBase);

    const creds = JSON.parse(await readFile(credentialsPath(), "utf-8")) as {
      deviceId: string;
      deviceToken: string;
    };

    const clientOpts = buildClientOpts({ ...opts, apiBase }, creds);
    if (opts.source) {
      if (!opts.mockAsr) {
        const paths = resolveAgentPaths({
          installDir: opts.installDir,
          ffmpegPath: opts.ffmpeg,
        });
        await validateSourceVideo(opts.source, paths.ffprobePath);
      } else {
        assertVideoFile(opts.source);
      }
    }
    const client = new ClipApiClient(clientOpts);
    const pipeline = new AgentPipeline(client, clientOpts);

    if (!opts.mockAsr) {
      const paths = resolveAgentPaths({
        installDir: opts.installDir,
        ffmpegPath: opts.ffmpeg,
      });
      const launch = resolveFunasrLaunch(paths);
      const sidecar = new FunasrSidecar({ launch });
      console.log(`starting funasr-server: ${launch.command} ${launch.args.join(" ")}`);
      await sidecar.start();
      pipeline.setSidecar(sidecar);
      try {
        await pipeline.runOnce({ sourceVideo: opts.source, mockAsrFile: opts.mockAsr });
      } finally {
        await sidecar.stop();
      }
    } else {
      await pipeline.runOnce({ sourceVideo: opts.source, mockAsrFile: opts.mockAsr });
    }
  });

program
  .command("material-fission")
  .description("素材裂变：本地 FFmpeg 随机组合变换，每源产出 M 条变体")
  .requiredOption("--source <path>", "本地视频路径（可重复）", (value, previous: string[] = []) => [
    ...previous,
    value,
  ])
  .option("--variants <n>", "每条源视频裂变条数", "10")
  .option("--concurrency <n>", "FFmpeg 并发数（1～8）", "8")
  .option("--ops <list>", `允许的变换，逗号分隔：${FISSION_OP_KINDS.join(",")}`)
  .option("--out-dir <path>", "输出目录（默认 ClipOutput/fission/<batchId>）")
  .option("--seed <n>", "随机种子（可复现）")
  .option("--api-base <url>", "API base URL（兼容桌面拉起，本命令不依赖云端）")
  .option("--install-dir <path>", "engines/install directory")
  .option("--ffmpeg <path>", "ffmpeg binary path")
  .action(async (opts: {
    source: string[];
    variants?: string;
    concurrency?: string;
    ops?: string;
    outDir?: string;
    seed?: string;
    apiBase?: string;
    installDir?: string;
    ffmpeg?: string;
  }) => {
    const sources = Array.isArray(opts.source) ? opts.source : [];
    if (!sources.length) throw new Error("请至少提供一个 --source");
    const variantsPerSource = Math.max(1, Number(opts.variants) || 10);
    const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 8));
    const allowedOps = opts.ops
      ? (opts.ops.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) as FissionOpKind[])
      : undefined;
    const seed = opts.seed != null && opts.seed !== "" ? Number(opts.seed) : undefined;

    const paths = resolveAgentPaths({
      installDir: opts.installDir,
      ffmpegPath: opts.ffmpeg,
    });
    await ensureFfmpegCapabilitiesProbed(paths);

    const result = await runMaterialFission({
      sources,
      variantsPerSource,
      concurrency,
      allowedOps,
      outDir: opts.outDir,
      ffmpegPath: paths.ffmpegPath,
      ffprobePath: paths.ffprobePath,
      seed: Number.isFinite(seed) ? seed : undefined,
    });

    const summary = {
      batchId: result.batchId,
      outDir: result.outDir,
      total: result.total,
      ok: result.ok,
      fail: result.fail,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    console.log(
      `[material-fission] done ok=${result.ok}/${result.total} fail=${result.fail} out=${result.outDir}`,
    );
    if (result.fail && !result.ok) process.exitCode = 1;
  });

program
  .command("paths")
  .option("--install-dir <path>", "engines/install directory")
  .action((opts) => {
    const paths = resolveAgentPaths({ installDir: opts.installDir });
    console.log(JSON.stringify(paths, null, 2));
  });

program
  .command("mock-funasr")
  .description("dev helper: HTTP mock of funasr-server")
  .requiredOption("--fixture <path>", "raw ASR json fixture")
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--port <port>", "bind port", "17860")
  .action(async (opts) => {
    const stop = await startMockFunasrServer({
      host: opts.host,
      port: Number(opts.port),
      fixturePath: opts.fixture,
    });
    const shutdown = async () => {
      await stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.hook("preAction", async () => {
  await initAgentLogger();
});

program.parse();
