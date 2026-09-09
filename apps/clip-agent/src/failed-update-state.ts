import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataRoot } from "./config.js";

const FAILED_UPDATE_FILE = join(dataRoot(), "updates", "failed-update.json");
const BACKOFF_MS = 6 * 60 * 60 * 1000;

interface FailedUpdateRecord {
  version: string;
  failedAt: string;
}

export async function shouldSkipUpdateAttempt(version: string, mandatory?: boolean): Promise<boolean> {
  if (mandatory) return false;
  try {
    const raw = await readFile(FAILED_UPDATE_FILE, "utf-8");
    const data = JSON.parse(raw) as FailedUpdateRecord;
    if (data.version !== version) return false;
    const elapsed = Date.now() - new Date(data.failedAt).getTime();
    return elapsed >= 0 && elapsed < BACKOFF_MS;
  } catch {
    return false;
  }
}

export async function recordFailedUpdate(version: string): Promise<void> {
  await mkdir(dirname(FAILED_UPDATE_FILE), { recursive: true });
  const record: FailedUpdateRecord = { version, failedAt: new Date().toISOString() };
  await writeFile(FAILED_UPDATE_FILE, JSON.stringify(record), "utf-8");
}

export async function clearFailedUpdate(): Promise<void> {
  await rm(FAILED_UPDATE_FILE, { force: true });
}
