import { unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./config.js";

const LOCK_FILE = join(dataRoot(), "agent.lock");

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireAgentLock(): Promise<() => Promise<void>> {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const tryCreate = async (): Promise<void> => {
    await writeFile(LOCK_FILE, payload, { encoding: "utf-8", flag: "wx" });
  };

  try {
    await tryCreate();
  } catch {
    if (!existsSync(LOCK_FILE)) throw new Error("failed to acquire agent lock");
    let stale = true;
    try {
      const raw = await readFile(LOCK_FILE, "utf-8");
      const existing = JSON.parse(raw) as { pid?: number };
      stale = !isProcessAlive(existing.pid ?? 0);
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new Error("another clip-agent is already running");
    }
    await unlink(LOCK_FILE);
    await tryCreate();
  }

  const release = async (): Promise<void> => {
    await unlink(LOCK_FILE).catch(() => {});
  };

  const cleanup = (): void => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // ignore
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return release;
}
