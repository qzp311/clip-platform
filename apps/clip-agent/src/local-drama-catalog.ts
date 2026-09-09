import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.js";

export type LocalDramaSourceKind = "inbox" | "package_cache";

export interface LocalDramaEpisodeRef {
  path: string;
  episodeNo: number;
  name: string;
}

export interface LocalDramaEntry {
  dramaId: string;
  title: string;
  /** 题材标签（导入页选题材） */
  genre?: string;
  /** 作品简介 */
  synopsis?: string;
  /** 运营清单类型 short/comic/... */
  dramaType?: string;
  source: LocalDramaSourceKind;
  episodes: LocalDramaEpisodeRef[];
  /** package 缓存目录名（若有） */
  packageCacheKey?: string;
  updatedAt: string;
}

interface LocalDramaCatalog {
  dramas: Record<string, LocalDramaEntry>;
}

function catalogPath(): string {
  return join(dataRoot(), "local-dramas.json");
}

async function loadCatalog(): Promise<LocalDramaCatalog> {
  try {
    const raw = await readFile(catalogPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalDramaCatalog>;
    return { dramas: parsed.dramas && typeof parsed.dramas === "object" ? parsed.dramas : {} };
  } catch {
    return { dramas: {} };
  }
}

async function saveCatalog(state: LocalDramaCatalog): Promise<void> {
  await mkdir(dataRoot(), { recursive: true });
  await writeFile(catalogPath(), JSON.stringify(state, null, 2));
}

/** 按剧名回查已有 dramaId，便于重复导入归到同一部剧 */
export async function findDramaIdByTitle(title: string): Promise<string | null> {
  const t = title.trim();
  if (!t) return null;
  const cat = await loadCatalog();
  for (const row of Object.values(cat.dramas)) {
    if (row.title.trim() === t) return row.dramaId;
  }
  return null;
}

export async function resolveLocalDramaId(input: {
  dramaId?: string;
  title?: string;
}): Promise<string> {
  if (input.dramaId?.trim()) return input.dramaId.trim();
  const title = input.title?.trim();
  if (title) {
    const existing = await findDramaIdByTitle(title);
    if (existing) return existing;
  }
  return `drama-${Date.now()}`;
}

export async function upsertLocalDrama(entry: {
  dramaId: string;
  title: string;
  source: LocalDramaSourceKind;
  episodes: LocalDramaEpisodeRef[];
  packageCacheKey?: string;
  genre?: string;
  synopsis?: string;
  dramaType?: string;
}): Promise<LocalDramaEntry> {
  const cat = await loadCatalog();
  const prev = cat.dramas[entry.dramaId];
  const genre = entry.genre?.trim() || prev?.genre;
  const synopsis =
    entry.synopsis !== undefined ? entry.synopsis.trim() || undefined : prev?.synopsis;
  const dramaType = entry.dramaType?.trim() || prev?.dramaType;
  const row: LocalDramaEntry = {
    dramaId: entry.dramaId,
    title: entry.title.trim() || entry.dramaId,
    source: entry.source,
    episodes: [...entry.episodes].sort((a, b) => a.episodeNo - b.episodeNo),
    packageCacheKey: entry.packageCacheKey,
    updatedAt: new Date().toISOString(),
  };
  if (genre) row.genre = genre;
  if (synopsis) row.synopsis = synopsis;
  if (dramaType) row.dramaType = dramaType;
  cat.dramas[entry.dramaId] = row;
  await saveCatalog(cat);
  return row;
}

export async function getLocalDrama(dramaId: string): Promise<LocalDramaEntry | null> {
  const cat = await loadCatalog();
  return cat.dramas[dramaId] ?? null;
}

export async function listLocalDramas(): Promise<LocalDramaEntry[]> {
  const cat = await loadCatalog();
  return Object.values(cat.dramas).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateLocalDramaMeta(
  dramaId: string,
  patch: { title: string; genre?: string; synopsis?: string },
): Promise<LocalDramaEntry> {
  const id = dramaId.trim();
  const nextTitle = patch.title.trim();
  if (!id) throw new Error("dramaId 不能为空");
  if (!nextTitle) throw new Error("剧名不能为空");
  const cat = await loadCatalog();
  const row = cat.dramas[id];
  if (!row) throw new Error(`未找到短剧 ${id}`);
  row.title = nextTitle;
  const genre = patch.genre?.trim();
  if (genre) row.genre = genre;
  else delete row.genre;
  const synopsis = patch.synopsis?.trim() ?? "";
  if (synopsis) row.synopsis = synopsis;
  else delete row.synopsis;
  row.updatedAt = new Date().toISOString();
  cat.dramas[id] = row;
  await saveCatalog(cat);
  return row;
}

/** @deprecated 使用 updateLocalDramaMeta */
export async function updateLocalDramaTitle(dramaId: string, title: string): Promise<LocalDramaEntry> {
  return updateLocalDramaMeta(dramaId, { title });
}

/** 从本地混剪目录移除（不删视频文件） */
export async function removeLocalDrama(dramaId: string): Promise<void> {
  const id = dramaId.trim();
  if (!id) throw new Error("dramaId 不能为空");
  const cat = await loadCatalog();
  delete cat.dramas[id];
  await saveCatalog(cat);
}
