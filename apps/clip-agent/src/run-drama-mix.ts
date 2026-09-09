import { basename, resolve } from "node:path";
import { access } from "node:fs/promises";
import { parseEpisodeNoFromMediaPath } from "@clip/sdk";
import type { AgentPipeline, ClipApiClient } from "./pipeline.js";
import {
  createDramaMixTask,
  ensureDramaEpisodesForMix,
  listDramaEpisodes,
} from "./material-submit.js";
import { saveEpisodeLocalSource } from "./local-source-registry.js";
import {
  upsertLocalDrama,
  type LocalDramaSourceKind,
} from "./local-drama-catalog.js";
import { upsertDramaEpisodeAsrIndex } from "./drama-asr-index.js";
import {
  finishTaskProgress,
  startTaskProgress,
  updateTaskProgress,
} from "./task-progress.js";

export interface RunDramaMixInput {
  apiBase: string;
  headers: Record<string, string>;
  client: ClipApiClient;
  pipeline: AgentPipeline;
  dramaId: string;
  title: string;
  /** 题材标签（写入本地 catalog + 云端 drama.meta.genreTags） */
  genre?: string;
  /** 作品简介（写入本地 catalog + 云端 drama.meta.synopsis） */
  synopsis?: string;
  /** 本机分集视频绝对路径（按集号排序后处理） */
  sources: string[];
  sourceKind?: LocalDramaSourceKind;
  packageCacheKey?: string;
  mockAsrFile?: string;
  /** 仅 ASR，不创建混剪任务 */
  asrOnly?: boolean;
  /** 强制重新识别，忽略库中已有 ASR */
  forceAsr?: boolean;
}

export interface RunDramaMixResult {
  dramaId: string;
  title: string;
  episodeCount: number;
  mixTaskId: string;
  outputUrl?: string;
  asrSkipped: number;
  asrRan: number;
  dbEpisodeCount: number;
  localEpisodeCount: number;
}

function sortSourcesByEpisodeNo(sources: string[]): Array<{ path: string; episodeNo: number; name: string }> {
  const rows = sources.map((raw, index) => {
    const path = resolve(raw);
    const name = basename(path);
    const parsed = parseEpisodeNoFromMediaPath(name) ?? parseEpisodeNoFromMediaPath(path);
    return {
      path,
      name,
      episodeNo: parsed ?? index + 1,
    };
  });
  rows.sort((a, b) => a.episodeNo - b.episodeNo || a.name.localeCompare(b.name));
  // 若多集解析到同一集号，按出现顺序重编号，避免 register 冲突
  const seen = new Set<number>();
  let auto = 1;
  for (const row of rows) {
    if (seen.has(row.episodeNo)) {
      while (seen.has(auto)) auto += 1;
      row.episodeNo = auto;
    }
    seen.add(row.episodeNo);
    auto = Math.max(auto, row.episodeNo + 1);
  }
  return rows;
}

async function assertReadable(path: string): Promise<void> {
  await access(path);
}

/**
 * 按短剧自动混剪：
 * - 批量向服务端 ensure-episodes：查 MySQL ASR，已有识别则回填分集并跳过
 * - 仅对 asrReady=false 的集补识别
 * - 然后 create-mix-task → drama_mix
 */
export async function runDramaMix(input: RunDramaMixInput): Promise<RunDramaMixResult> {
  const sources = [...new Set(input.sources.filter(Boolean).map((s) => resolve(s)))];
  if (sources.length === 0) {
    throw new Error("至少需要一集本地视频才能混剪");
  }
  for (const p of sources) await assertReadable(p);

  const sorted = sortSourcesByEpisodeNo(sources);
  const dramaId = input.dramaId.trim();
  const title = input.title.trim() || dramaId;
  const genre = input.genre?.trim() || undefined;
  const synopsis = input.synopsis?.trim() || undefined;
  const dramaMeta: Record<string, unknown> = { title };
  if (synopsis) {
    dramaMeta.synopsis = synopsis;
    dramaMeta.synopsisSource = "manual";
  }
  if (genre) {
    dramaMeta.genreTags = [genre];
  }

  const existingBefore = await listDramaEpisodes(input.apiBase, input.headers, dramaId);
  const dbEpisodeCount = existingBefore.length;
  const localEpisodeCount = sorted.length;

  console.log(
    `[run-drama-mix] dramaId=${dramaId} 本地=${localEpisodeCount}集 库中分集=${dbEpisodeCount}集，开始按集号查 ASR…`,
  );

  await startTaskProgress({
    title,
    kind: "drama_mix",
    phaseCode: "asr",
    phase: `短剧混剪：对齐 ${localEpisodeCount} 集（查库识别结果）`,
    stepCurrent: 0,
    stepTotal: sorted.length + 1,
  });

  try {
    const ensured = await ensureDramaEpisodesForMix(
      input.apiBase,
      input.headers,
      dramaId,
      sorted.map((row) => ({
        episodeNo: row.episodeNo,
        localPath: row.path,
        title: `第${row.episodeNo}集`,
      })),
      dramaMeta,
    );

    console.log(
      `[run-drama-mix] ensure 完成：可复用识别 ${ensured.asrReadyCount} 集，需补识别 ${ensured.needAsrCount} 集`,
    );

    const episodeSources: Record<string, string> = {};
    const episodeIds: string[] = [];
    let asrSkipped = 0;
    let asrRan = 0;

    for (let i = 0; i < ensured.episodes.length; i++) {
      const row = sorted[i]!;
      const { episode, asrReady, reusedAsr } = ensured.episodes[i]!;

      await updateTaskProgress({
        active: true,
        title: row.name,
        kind: "drama_mix",
        phaseCode: "asr",
        phase: asrReady
          ? `跳过识别 第 ${i + 1}/${sorted.length} 集（库中已有）`
          : `补识别 第 ${i + 1}/${sorted.length} 集（ep${row.episodeNo}）`,
        stepCurrent: i + 1,
        stepTotal: sorted.length + 1,
      });

      episodeIds.push(episode.episodeId);
      episodeSources[episode.episodeId] = row.path;
      await saveEpisodeLocalSource(dramaId, episode.episodeId, row.path);

      if (asrReady && !input.forceAsr) {
        asrSkipped += 1;
        console.log(
          `[run-drama-mix] 跳过 ASR ep=${episode.episodeNo} (${row.name})：` +
            (reusedAsr ? "MySQL 已有识别数据" : "分集已是 asr_done"),
        );
      } else {
        if (!episode.taskId) {
          throw new Error(`集 ${episode.episodeNo} 缺少 taskId，无法补 ASR`);
        }

        console.log(
          `[run-drama-mix] 补 ASR ep=${episode.episodeNo} status=${episode.status} (${row.name})`,
        );

        let claim = await input.client.claimTask(episode.taskId);
        if (!claim.task) {
          await input.client.retryTask(episode.taskId);
          claim = await input.client.claimTask(episode.taskId);
        }
        if (!claim.task) {
          const task = await input.client.getTask(episode.taskId);
          const config = await input.client.fetchConfig(task.asrRuleSetId);
          await input.pipeline.processEpisodeAsr(task, config, {
            sourceVideo: row.path,
            mockAsrFile: input.mockAsrFile,
          });
        } else {
          const config =
            claim.effectiveConfig ?? (await input.client.fetchConfig(claim.task.asrRuleSetId));
          await input.pipeline.processEpisodeAsr(claim.task, config, {
            sourceVideo: row.path,
            mockAsrFile: input.mockAsrFile,
          });
        }
        asrRan += 1;
        episode.status = "asr_done";
        console.log(`[run-drama-mix] ASR done ep=${episode.episodeNo} (${row.name})`);
      }

      // 与 TOS 剧包一致：本地索引 + MySQL ASR，供drama-clip按路径回落查库
      if (episode.taskId) {
        await upsertDramaEpisodeAsrIndex({
          dramaId,
          packageTaskId: input.packageCacheKey || dramaId,
          episode: {
            taskId: episode.taskId,
            episodeId: episode.episodeId,
            sourcePath: row.path,
            episodeNo: episode.episodeNo,
          },
        });
      }
    }

    await upsertLocalDrama({
      dramaId,
      title,
      genre,
      synopsis,
      source: input.sourceKind ?? "inbox",
      packageCacheKey: input.packageCacheKey,
      episodes: sorted.map((s) => ({
        path: s.path,
        episodeNo: s.episodeNo,
        name: s.name,
      })),
    });

    if (episodeIds.length < 2 || input.asrOnly) {
      await finishTaskProgress({
        phase: input.asrOnly
          ? `分集识别完成（${title}）跳过 ${asrSkipped} · 新识别 ${asrRan}`
          : `导入识别完成（${title}）跳过 ${asrSkipped} · 新识别 ${asrRan}；单集暂不混剪`,
      });
      console.log(
        `[run-drama-mix] ${input.asrOnly ? "asrOnly 模式" : `仅 ${episodeIds.length} 集`}，跳过混剪；剧目/分集/ASR 已入库 dramaId=${dramaId}`,
      );
      return {
        dramaId,
        title,
        episodeCount: episodeIds.length,
        mixTaskId: "",
        asrSkipped,
        asrRan,
        dbEpisodeCount,
        localEpisodeCount,
      };
    }

    await updateTaskProgress({
      active: true,
      title,
      kind: "drama_mix",
      phaseCode: "mix_plan",
      phase: `创建混剪（跳过识别 ${asrSkipped} 集 · 新识别 ${asrRan} 集）…`,
      stepCurrent: sorted.length + 1,
      stepTotal: sorted.length + 1,
    });

    console.log(
      `[run-drama-mix] create mix dramaId=${dramaId} episodes=${episodeIds.length} skipped=${asrSkipped} ran=${asrRan}`,
    );
    const mix = await createDramaMixTask(input.apiBase, input.headers, dramaId, episodeIds);

    let mixClaim = await input.client.claimTask(mix.taskId);
    if (!mixClaim.task) {
      mixClaim = await input.client.claimTask(mix.taskId);
    }
    let mixTask = mixClaim.task;
    if (!mixTask) {
      mixTask = await input.client.getTask(mix.taskId);
    }
    const mixConfig =
      mixClaim.effectiveConfig ?? (await input.client.fetchConfig(mixTask.asrRuleSetId));

    await input.pipeline.processDramaMixTask(mixTask, mixConfig, { episodeSources });

    await upsertDramaEpisodeAsrIndex({
      dramaId,
      packageTaskId: input.packageCacheKey || dramaId,
      mixTaskId: mix.taskId,
    });

    const done = await input.client.getTask(mix.taskId);
    await finishTaskProgress({
      phase: `混剪完成（${title}）跳过识别 ${asrSkipped} · 新识别 ${asrRan}`,
    });

    return {
      dramaId,
      title,
      episodeCount: episodeIds.length,
      mixTaskId: mix.taskId,
      outputUrl: done.outputUrl,
      asrSkipped,
      asrRan,
      dbEpisodeCount,
      localEpisodeCount,
    };
  } catch (err) {
    await finishTaskProgress({
      phase: "混剪失败",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
