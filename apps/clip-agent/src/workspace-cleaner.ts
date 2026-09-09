import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 剪辑成片文件名：{剧名}-{批次}-{剪辑数量}-{年月日时分秒}-autoclip.mp4（含旧版 output-r01-p01.mp4） */
import { AUTOCLIP_OUTPUT_FILE_RE } from "@clip/sdk";

/**
 * 任务完成后清理工作区中间文件，仅保留成片 mp4。
 * 删除：meta.json、audio.wav、source.mp4、ffmpeg/、各集素材目录等。
 */
export async function cleanupTaskArtifacts(
  workspaceDir: string,
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];

  let names: string[];
  try {
    names = await readdir(workspaceDir);
  } catch {
    return { removed, kept };
  }

  for (const name of names) {
    const path = join(workspaceDir, name);
    const info = await stat(path);
    if (info.isFile() && AUTOCLIP_OUTPUT_FILE_RE.test(name)) {
      kept.push(name);
      continue;
    }
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }

  return { removed, kept };
}

/** 任务完成后删除整个本地工作区目录（成片已上传 OSS 后调用） */
export async function removeTaskWorkspace(
  workspaceDir: string,
): Promise<{ removed: boolean }> {
  try {
    await rm(workspaceDir, { recursive: true, force: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

export async function cleanupWorkspace(
  workspaceRoot: string,
  maxGb: number,
): Promise<{ removed: number; freedBytes: number }> {
  const maxBytes = maxGb * 1024 * 1024 * 1024;
  let totalBytes = 0;
  const entries: Array<{ path: string; mtime: number; size: number }> = [];

  try {
    const dirs = await readdir(workspaceRoot);
    for (const dir of dirs) {
      const path = join(workspaceRoot, dir);
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      const size = await dirSize(path);
      entries.push({ path, mtime: info.mtimeMs, size });
      totalBytes += size;
    }
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  if (totalBytes <= maxBytes) return { removed: 0, freedBytes: 0 };

  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    await rm(entry.path, { recursive: true, force: true });
    totalBytes -= entry.size;
    freedBytes += entry.size;
    removed += 1;
  }

  return { removed, freedBytes };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) total += await dirSize(path);
    else total += (await stat(path)).size;
  }
  return total;
}
