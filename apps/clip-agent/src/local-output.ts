import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveConfig } from "@clip/sdk";
import { dataRoot } from "./config.js";

const WINDOWS_DEFAULT_ROOT = "D:\\ClipOutput";

/** 未上传时成片根目录（优先配置 → 环境变量 → Windows D 盘 → 用户目录/outputs） */
export function resolveLocalOutputRoot(config: EffectiveConfig): string {
  const configured = config.render?.limits?.localOutputDir?.trim();
  if (configured) return configured;

  const fromEnv = process.env.CLIP_LOCAL_OUTPUT_DIR?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === "win32") {
    try {
      if (existsSync("D:\\")) return WINDOWS_DEFAULT_ROOT;
    } catch {
      // ignore
    }
  }

  return join(dataRoot(), "outputs");
}

export function resolveTaskLocalOutputDir(config: EffectiveConfig, taskId: string): string {
  return join(resolveLocalOutputRoot(config), taskId);
}

export async function ensureTaskLocalOutputDir(
  config: EffectiveConfig,
  taskId: string,
): Promise<string> {
  const dir = resolveTaskLocalOutputDir(config, taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}
