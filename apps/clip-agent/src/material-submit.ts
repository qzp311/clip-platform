import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { toClipLocalSourceUrl } from "@clip/sdk";
import type { ClipTask, DramaEpisodeRecord } from "@clip/sdk";

export interface SubmitMaterialResult {
  taskId: string;
  sourceUrl: string;
  task: ClipTask;
}

export interface SubmitEpisodeResult {
  episodeId: string;
  episodeNo: number;
  taskId: string;
  sourceUrl: string;
  episode: DramaEpisodeRecord;
  task: ClipTask;
}

export interface CreateMixTaskResult {
  taskId: string;
  task: ClipTask;
}

export interface RegisterOutputResult {
  taskId: string;
  sourceUrl: string;
  task: ClipTask;
}

/** 上传复刻输入素材但不创建普通剪辑任务，返回服务端可下载地址。 */
export async function uploadRemixReplicaSource(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
): Promise<{ sourceUrl: string; objectKey: string }> {
  const contentBase64 = (await readFile(localPath)).toString("base64");
  const res = await fetch(new URL("/agent/remix/replica/upload-source", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ filename: basename(localPath), contentBase64 }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!res.ok) {
    throw new Error(`upload remix source failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ sourceUrl: string; objectKey: string }>;
}

/** @deprecated 会上传原片到服务端 OSS，请改用 registerMaterialFile */
export async function submitMaterialFile(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
  dramaId = "drama-demo",
): Promise<SubmitMaterialResult & { objectKey: string }> {
  const contentBase64 = (await readFile(localPath)).toString("base64");
  const res = await fetch(new URL("/agent/materials/submit", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: basename(localPath),
      contentBase64,
      dramaId,
    }),
  });
  if (!res.ok) {
    throw new Error(`submit material failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SubmitMaterialResult & { objectKey: string }>;
}

/** @deprecated 会上传原片到服务端 OSS，请改用 registerEpisodeFile */
export async function submitEpisodeFile(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
  dramaId: string,
  episodeNo?: number,
): Promise<SubmitEpisodeResult & { objectKey: string }> {
  const contentBase64 = (await readFile(localPath)).toString("base64");
  const res = await fetch(new URL("/agent/materials/submit-episode", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: basename(localPath),
      contentBase64,
      dramaId,
      episodeNo,
      title: episodeNo ? `第${episodeNo}集` : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`submit episode failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SubmitEpisodeResult & { objectKey: string }>;
}

/** 仅登记本地路径，不上传原片 */
export async function registerMaterialFile(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
  dramaId = "drama-demo",
): Promise<SubmitMaterialResult> {
  const absPath = resolve(localPath);
  const res = await fetch(new URL("/agent/materials/register", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      localPath: absPath,
      filename: basename(absPath),
      dramaId,
    }),
  });
  if (!res.ok) {
    throw new Error(`register material failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SubmitMaterialResult>;
}

/** 仅登记本地路径，不上传原片 */
export async function registerEpisodeFile(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
  dramaId: string,
  episodeNo?: number,
  packageTaskId?: string,
  dramaMeta?: Record<string, unknown>,
): Promise<SubmitEpisodeResult> {
  const absPath = resolve(localPath);
  const res = await fetch(new URL("/agent/materials/register-episode", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      localPath: absPath,
      filename: basename(absPath),
      dramaId,
      episodeNo,
      title: episodeNo ? `第${episodeNo}集` : undefined,
      packageTaskId,
      dramaMeta,
    }),
  });
  if (!res.ok) {
    throw new Error(`register episode failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SubmitEpisodeResult>;
}

/** 登记本地成片路径，仅跑 ASR（不上传、不混剪） */
export async function registerOutputFile(
  apiBase: string,
  headers: Record<string, string>,
  localPath: string,
  options: {
    dramaId?: string;
    parentTaskId?: string;
    dramaMeta?: Record<string, unknown>;
  } = {},
): Promise<RegisterOutputResult> {
  const absPath = resolve(localPath);
  const res = await fetch(new URL("/agent/materials/register-output", apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      localPath: absPath,
      filename: basename(absPath),
      dramaId: options.dramaId,
      parentTaskId: options.parentTaskId,
      dramaMeta: options.dramaMeta,
    }),
  });
  if (!res.ok) {
    throw new Error(`register output failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<RegisterOutputResult>;
}

export { toClipLocalSourceUrl };

export async function createDramaMixTask(
  apiBase: string,
  headers: Record<string, string>,
  dramaId: string,
  episodeIds?: string[],
  packageTaskId?: string,
): Promise<CreateMixTaskResult> {
  const res = await fetch(new URL(`/agent/dramas/${encodeURIComponent(dramaId)}/create-mix-task`, apiBase), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ episodeIds, packageTaskId }),
  });
  if (!res.ok) {
    throw new Error(`create mix task failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<CreateMixTaskResult>;
}

export async function listDramaEpisodes(
  apiBase: string,
  headers: Record<string, string>,
  dramaId: string,
): Promise<DramaEpisodeRecord[]> {
  const url = new URL(`/agent/dramas/${encodeURIComponent(dramaId)}/episodes`, apiBase);
  const maxAttempts = 3;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        // 简单列表接口给 30s；服务端忙时允许排队，但 Agent 侧不重试会失败
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { episodes: DramaEpisodeRecord[] };
        return data.episodes;
      }
      const text = await res.text();
      lastErr = new Error(`list episodes failed: ${res.status} ${text.slice(0, 300)}`);
      // 5xx / 429 才重试；业务 4xx 直接失败
      if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts) {
        const delay = 1000 * 2 ** (attempt - 1);
        console.warn(`[list-episodes] 第 ${attempt}/${maxAttempts} 次失败，${delay}ms 后重试: ${res.status}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      lastErr = new Error(`list episodes failed: ${detail}`);
      if (attempt < maxAttempts) {
        const delay = 1000 * 2 ** (attempt - 1);
        console.warn(`[list-episodes] 第 ${attempt}/${maxAttempts} 次异常，${delay}ms 后重试: ${detail}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("list episodes failed");
}

export interface EnsureEpisodeForMixResult {
  episode: DramaEpisodeRecord;
  asrReady: boolean;
  reusedAsr: boolean;
}

/** 批量对齐分集：库中已有 ASR 则回填 asr_done，无需再识别 */
export async function ensureDramaEpisodesForMix(
  apiBase: string,
  headers: Record<string, string>,
  dramaId: string,
  episodes: Array<{ episodeNo: number; localPath: string; title?: string }>,
  dramaMeta?: Record<string, unknown>,
): Promise<{
  episodes: EnsureEpisodeForMixResult[];
  asrReadyCount: number;
  needAsrCount: number;
}> {
  const res = await fetch(
    new URL(`/agent/dramas/${encodeURIComponent(dramaId)}/ensure-episodes`, apiBase),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        dramaMeta,
        episodes: episodes.map((ep) => ({
          episodeNo: ep.episodeNo,
          localPath: ep.localPath,
          title: ep.title,
          filename: basename(ep.localPath),
        })),
      }),
      // ensure-episodes 可能批量处理多集并查库，给足够时间避免 Headers Timeout
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) {
    throw new Error(`ensure episodes failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{
    episodes: EnsureEpisodeForMixResult[];
    asrReadyCount: number;
    needAsrCount: number;
  }>;
}
