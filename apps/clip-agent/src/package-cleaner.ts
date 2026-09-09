import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { removeTaskWorkspace } from "./workspace-cleaner.js";

export function resolvePackageBatchDir(workspaceRoot: string, packageTaskId: string): string {
  return join(workspaceRoot, "packages", packageTaskId);
}

/** 跨任务复用的剧包缓存目录：同一剧目和包对象只下载/解压一次。 */
export function resolvePackageCacheDir(
  workspaceRoot: string,
  dramaId: string,
  packageKey: string,
): string {
  const key = createHash("sha256").update(`${dramaId}\n${packageKey}`).digest("hex").slice(0, 24);
  return join(workspaceRoot, "packages", "cache", key);
}

/** 删除剧级批次目录（zip + extracted + manifest） */
export async function removePackageBatch(batchDir: string): Promise<void> {
  await rm(batchDir, { recursive: true, force: true });
}

/** 清理批次内各集 ASR 产生的独立 task 工作区 */
export async function cleanupEpisodeTaskWorkspaces(
  workspaceRoot: string,
  episodeTaskIds: string[],
): Promise<void> {
  for (const taskId of episodeTaskIds) {
    await removeTaskWorkspace(join(workspaceRoot, taskId));
  }
}
