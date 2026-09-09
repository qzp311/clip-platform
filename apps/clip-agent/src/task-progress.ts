import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.js";

const PERSIST_MAX_ATTEMPTS = 3;

export type TaskProgressPhaseCode =
  | "idle"
  | "download"
  | "extract"
  | "asr"
  | "analyze"
  | "mix_plan"
  | "render"
  | "upload"
  | "cleaning"
  | "done"
  | "failed";

export interface TaskProgressState {
  active: boolean;
  taskId?: string;
  jobId?: string;
  title?: string;
  kind?: string;
  phaseCode: TaskProgressPhaseCode;
  /** 当前阶段说明，如「识别第 2/10 集」 */
  phase: string;
  stepCurrent?: number;
  stepTotal?: number;
  downloadBytes?: number;
  downloadTotalBytes?: number;
  /** 0–100；总长未知时为 null */
  downloadPercent?: number | null;
  error?: string;
  updatedAt: string;
}

const IDLE: TaskProgressState = {
  active: false,
  phaseCode: "idle",
  phase: "空闲",
  updatedAt: new Date(0).toISOString(),
};

function progressPath(): string {
  return join(dataRoot(), "task-progress.json");
}

let writeChain: Promise<void> = Promise.resolve();
let lastDownloadWriteAt = 0;

export async function readTaskProgress(): Promise<TaskProgressState> {
  try {
    const raw = await readFile(progressPath(), "utf-8");
    return JSON.parse(raw) as TaskProgressState;
  } catch {
    return { ...IDLE, updatedAt: new Date().toISOString() };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
}

/** 单次原子落盘；Windows 上目标文件被占用时先删再 rename */
async function persistOnce(state: TaskProgressState): Promise<void> {
  const dir = dataRoot();
  await mkdir(dir, { recursive: true });
  const path = progressPath();
  const tmp = join(dir, `task-progress.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2));
  try {
    await rename(tmp, path);
  } catch (err) {
    if (!isRetryableFsError(err)) throw err;
    try {
      await unlink(path);
    } catch {
      // 目标不存在或暂不可删时，交给外层重试
    }
    await rename(tmp, path);
  }
}

/**
 * 进度落盘：失败最多重试 3 次；仍失败则跳过本次，不抛错，保证后续写与业务继续。
 */
async function persist(state: TaskProgressState): Promise<void> {
  const tmp = join(dataRoot(), `task-progress.${process.pid}.tmp`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt++) {
    try {
      await persistOnce(state);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < PERSIST_MAX_ATTEMPTS) {
        await sleep(40 * attempt);
      }
    }
  }
  try {
    await unlink(tmp);
  } catch {
    // ignore stale tmp
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(
    `[task-progress] persist failed after ${PERSIST_MAX_ATTEMPTS} attempts, skip this write: ${detail}`,
  );
}

/** 串行写队列：单次失败不打断链条，下一次写入继续执行 */
function enqueueWrite(work: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      await work();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[task-progress] write skipped: ${detail}`);
    }
  });
  return writeChain;
}

function isTerminalState(state: TaskProgressState): boolean {
  return !state.active && (state.phaseCode === "done" || state.phaseCode === "failed");
}

function wouldReactivate(patch: Partial<Omit<TaskProgressState, "updatedAt">>): boolean {
  if (patch.active === true) return true;
  if (
    patch.phaseCode &&
    patch.phaseCode !== "done" &&
    patch.phaseCode !== "failed" &&
    patch.phaseCode !== "idle"
  ) {
    return true;
  }
  return false;
}

export async function updateTaskProgress(
  patch: Partial<Omit<TaskProgressState, "updatedAt">>,
): Promise<void> {
  return enqueueWrite(async () => {
    const current = await readTaskProgress();
    // 显式 active:true 表示新阶段开始；仅 startTaskProgress 能恢复时，update 带 active:true 也应生效
    if (isTerminalState(current) && wouldReactivate(patch) && patch.active !== true) {
      return;
    }
    const next: TaskProgressState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await persist(next);
  });
}

/** 下载进度写入节流，避免磁盘刷写过频 */
export async function updateDownloadProgress(input: {
  downloadedBytes: number;
  totalBytes: number;
  title?: string;
  taskId?: string;
}): Promise<void> {
  const now = Date.now();
  const percent =
    input.totalBytes > 0
      ? Math.min(100, Math.round((input.downloadedBytes / input.totalBytes) * 100))
      : null;
  if (now - lastDownloadWriteAt < 300 && percent != null && percent < 100) return;
  lastDownloadWriteAt = now;
  await updateTaskProgress({
    active: true,
    phaseCode: "download",
    phase: percent != null ? `下载压缩包 ${percent}%` : "下载压缩包…",
    downloadBytes: input.downloadedBytes,
    downloadTotalBytes: input.totalBytes > 0 ? input.totalBytes : undefined,
    downloadPercent: percent,
    title: input.title,
    taskId: input.taskId,
    kind: "drama_package",
  });
}

export async function startTaskProgress(input: {
  taskId?: string;
  jobId?: string;
  title?: string;
  kind?: string;
  phaseCode?: TaskProgressPhaseCode;
  phase: string;
  stepCurrent?: number;
  stepTotal?: number;
}): Promise<void> {
  lastDownloadWriteAt = 0;
  return enqueueWrite(async () => {
    const next: TaskProgressState = {
      active: true,
      taskId: input.taskId,
      jobId: input.jobId,
      title: input.title,
      kind: input.kind,
      phaseCode: input.phaseCode ?? "asr",
      phase: input.phase,
      stepCurrent: input.stepCurrent,
      stepTotal: input.stepTotal,
      updatedAt: new Date().toISOString(),
    };
    await persist(next);
  });
}

export async function finishTaskProgress(input?: {
  phase?: string;
  error?: string;
}): Promise<void> {
  lastDownloadWriteAt = 0;
  return enqueueWrite(async () => {
    const current = await readTaskProgress();
    const next: TaskProgressState = {
      ...current,
      active: false,
      phaseCode: input?.error ? "failed" : "done",
      phase: input?.phase ?? (input?.error ? "处理失败" : "已完成"),
      error: input?.error,
      downloadBytes: undefined,
      downloadTotalBytes: undefined,
      downloadPercent: undefined,
      stepCurrent: undefined,
      stepTotal: undefined,
      updatedAt: new Date().toISOString(),
    };
    await persist(next);
  });
}

export async function clearTaskProgress(): Promise<void> {
  lastDownloadWriteAt = 0;
  return enqueueWrite(async () => {
    await persist({ ...IDLE, updatedAt: new Date().toISOString() });
  });
}
