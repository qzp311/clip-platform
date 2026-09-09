import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./config.js";

export interface ControlState {
  paused: boolean;
}

function controlPath(): string {
  return join(dataRoot(), "control.json");
}

export async function readControl(): Promise<ControlState> {
  try {
    const raw = await readFile(controlPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ControlState>;
    return { paused: Boolean(parsed.paused) };
  } catch {
    return { paused: false };
  }
}

export async function setPaused(paused: boolean): Promise<void> {
  await mkdir(dataRoot(), { recursive: true });
  await writeFile(controlPath(), JSON.stringify({ paused }, null, 2), "utf-8");
}

export async function isPaused(): Promise<boolean> {
  return (await readControl()).paused;
}
