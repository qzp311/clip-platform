import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.js";

/** 与 TOS 剧包 episode-asr-index 同结构，供drama-clip resolve_episode_asr_task 回落 */
export interface DramaEpisodeAsrIndexEntry {
  taskId: string;
  episodeId: string;
  sourcePath: string;
  episodeNo: number;
}

export interface DramaEpisodeAsrIndex {
  dramaId: string;
  /** 客户端导入无 packageTaskId，用 dramaId 占位 */
  packageTaskId: string;
  mixTaskId?: string;
  episodes: Record<string, DramaEpisodeAsrIndexEntry>;
}

export function dramaAsrIndexDir(dramaId: string): string {
  return join(dataRoot(), "drama-asr", dramaId);
}

export function dramaAsrIndexPath(dramaId: string): string {
  return join(dramaAsrIndexDir(dramaId), "episode-asr-index.json");
}

export async function upsertDramaEpisodeAsrIndex(patch: {
  dramaId: string;
  packageTaskId?: string;
  mixTaskId?: string;
  episode?: DramaEpisodeAsrIndexEntry;
}): Promise<void> {
  const dramaId = patch.dramaId.trim();
  if (!dramaId) return;
  const path = dramaAsrIndexPath(dramaId);
  let data: DramaEpisodeAsrIndex = {
    dramaId,
    packageTaskId: patch.packageTaskId?.trim() || dramaId,
    episodes: {},
  };
  try {
    const prev = JSON.parse(await readFile(path, "utf8")) as DramaEpisodeAsrIndex;
    data = {
      dramaId: prev.dramaId || dramaId,
      packageTaskId: prev.packageTaskId || patch.packageTaskId?.trim() || dramaId,
      mixTaskId: prev.mixTaskId,
      episodes: prev.episodes ?? {},
    };
  } catch {
    /* 首次 */
  }
  if (patch.mixTaskId) data.mixTaskId = patch.mixTaskId;
  if (patch.packageTaskId?.trim()) data.packageTaskId = patch.packageTaskId.trim();
  if (patch.episode) {
    data.episodes[String(patch.episode.episodeNo)] = patch.episode;
  }
  data.dramaId = dramaId;
  await mkdir(dramaAsrIndexDir(dramaId), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}
