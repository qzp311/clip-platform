import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataRoot } from "./config.js";

export interface OutputAsrIndexEntry {
  taskId: string;
  parentTaskId?: string;
  updatedAt: string;
}

type OutputAsrIndex = Record<string, OutputAsrIndexEntry>;

function indexPath(): string {
  return join(dataRoot(), "output-asr-index.json");
}

function normalizePathKey(localPath: string): string {
  return resolve(localPath).replace(/\//g, "\\").toLowerCase();
}

function fileNameOf(localPath: string): string {
  return resolve(localPath).replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
}

function fileNameKey(localPath: string): string {
  const base = fileNameOf(localPath);
  return base ? `name:${base}` : "";
}

function parentNameKey(parentTaskId: string | undefined, localPath: string): string | null {
  if (!parentTaskId?.trim()) return null;
  const base = fileNameOf(localPath);
  if (!base) return null;
  return `parent:${parentTaskId.trim()}:${base}`;
}

/** 成片文件名中的稳定后缀，如 01-3-20260720174046-autoclip.mp4（不受中文剧名 sanitize 影响） */
export function distinctiveOutputTail(fileName: string): string | null {
  const base = String(fileName || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .split(/[?#]/)[0]
    .trim();
  if (!base) return null;
  const m = base.match(/(\d{1,3}-\d+-\d{10,}-autoclip\.mp4)$/i);
  if (m?.[1]) return m[1].toLowerCase();
  // 退化：足够长的 autoclip 全名
  if (/autoclip\.mp4$/i.test(base) && base.length >= 20) return base;
  return null;
}

function tailKey(localPath: string): string | null {
  const tail = distinctiveOutputTail(fileNameOf(localPath));
  return tail ? `tail:${tail}` : null;
}

function parentTailKey(parentTaskId: string | undefined, localPath: string): string | null {
  if (!parentTaskId?.trim()) return null;
  const tail = distinctiveOutputTail(fileNameOf(localPath));
  return tail ? `parent-tail:${parentTaskId.trim()}:${tail}` : null;
}

async function loadIndex(): Promise<OutputAsrIndex> {
  try {
    const raw = await readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(raw) as OutputAsrIndex;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveIndex(state: OutputAsrIndex): Promise<void> {
  await mkdir(dataRoot(), { recursive: true });
  await writeFile(indexPath(), JSON.stringify(state, null, 2));
}

export async function saveOutputAsrIndex(
  localPath: string,
  entry: { taskId: string; parentTaskId?: string },
): Promise<void> {
  const key = normalizePathKey(localPath);
  const state = await loadIndex();
  const row: OutputAsrIndexEntry = {
    taskId: entry.taskId,
    parentTaskId: entry.parentTaskId,
    updatedAt: new Date().toISOString(),
  };
  // 多键：绝对路径 / 父任务+文件名 / 稳定后缀（禁止只靠易冲突的短 name）
  state[key] = row;
  const pk = parentNameKey(entry.parentTaskId, localPath);
  if (pk) state[pk] = row;
  const ptk = parentTailKey(entry.parentTaskId, localPath);
  if (ptk) state[ptk] = row;
  const tk = tailKey(localPath);
  if (tk) state[tk] = row;
  const nk = fileNameKey(localPath);
  // 仅当文件名含稳定后缀时才写 name: 键，避免 _-xx 互相覆盖
  if (nk && distinctiveOutputTail(fileNameOf(localPath))) state[nk] = row;
  await saveIndex(state);
}

export async function getOutputAsrIndex(
  localPath: string,
  parentTaskId?: string,
): Promise<OutputAsrIndexEntry | null> {
  const state = await loadIndex();
  const pathKey = normalizePathKey(localPath);
  if (state[pathKey]) return state[pathKey]!;

  const parent = parentTaskId?.trim();
  if (parent) {
    const pk = parentNameKey(parent, localPath);
    if (pk && state[pk]) return state[pk]!;
    const ptk = parentTailKey(parent, localPath);
    if (ptk && state[ptk]) return state[ptk]!;
  }

  const wantTail = distinctiveOutputTail(fileNameOf(localPath));
  if (wantTail) {
    // 有父任务时只在同父任务键下找；无父任务时仅精确 path（上面已查），不再用裸 tail 跨剧命中
    if (parent) {
      for (const [k, v] of Object.entries(state)) {
        if (!k.startsWith(`parent:${parent}:`) && !k.startsWith(`parent-tail:${parent}:`)) continue;
        const base = k.startsWith("parent-tail:")
          ? k.slice(`parent-tail:${parent}:`.length)
          : k.slice(`parent:${parent}:`.length);
        if (base === wantTail || distinctiveOutputTail(base) === wantTail || fileNameOf(base) === fileNameOf(localPath)) {
          return v;
        }
      }
    }
  }

  return null;
}
