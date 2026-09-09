import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataRoot } from "./config.js";

interface LocalSourcesState {
  /** dramaId -> episodeId -> absolute local path */
  episodes: Record<string, Record<string, string>>;
  /** taskId -> absolute local path (single-video jobs) */
  tasks: Record<string, string>;
}

function storePath(): string {
  return join(dataRoot(), "local-sources.json");
}

async function loadState(): Promise<LocalSourcesState> {
  try {
    const raw = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalSourcesState>;
    return {
      episodes: parsed.episodes ?? {},
      tasks: parsed.tasks ?? {},
    };
  } catch {
    return { episodes: {}, tasks: {} };
  }
}

async function saveState(state: LocalSourcesState): Promise<void> {
  await mkdir(dataRoot(), { recursive: true });
  await writeFile(storePath(), JSON.stringify(state, null, 2));
}

export async function saveEpisodeLocalSource(
  dramaId: string,
  episodeId: string,
  localPath: string,
): Promise<void> {
  const abs = resolve(localPath);
  await access(abs);
  const state = await loadState();
  if (!state.episodes[dramaId]) state.episodes[dramaId] = {};
  state.episodes[dramaId]![episodeId] = abs;
  await saveState(state);
}

export async function getEpisodeLocalSource(
  dramaId: string,
  episodeId: string,
): Promise<string | undefined> {
  const state = await loadState();
  return state.episodes[dramaId]?.[episodeId];
}

export async function getDramaEpisodeSources(
  dramaId: string,
): Promise<Record<string, string>> {
  const state = await loadState();
  return { ...(state.episodes[dramaId] ?? {}) };
}

/** 混剪批次清理后移除已失效的本地集源路径，避免后续重试继续命中已删除文件。 */
export async function removeEpisodeLocalSources(
  dramaId: string,
  episodeIds: string[],
): Promise<void> {
  if (!episodeIds.length) return;
  const state = await loadState();
  const drama = state.episodes[dramaId];
  if (!drama) return;
  for (const episodeId of episodeIds) delete drama[episodeId];
  if (Object.keys(drama).length === 0) delete state.episodes[dramaId];
  await saveState(state);
}

export async function saveTaskLocalSource(taskId: string, localPath: string): Promise<void> {
  const abs = resolve(localPath);
  await access(abs);
  const state = await loadState();
  state.tasks[taskId] = abs;
  await saveState(state);
}

export async function getTaskLocalSource(taskId: string): Promise<string | undefined> {
  const state = await loadState();
  return state.tasks[taskId];
}
