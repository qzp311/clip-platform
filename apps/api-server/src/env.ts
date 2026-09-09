import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Load KEY=VALUE pairs from .env without overwriting existing process.env. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** CLIP_ENV=test|production → deploy/.env.<CLIP_ENV>；未显式设置时 production 环境默认 production */
export function resolveClipEnvName(): string | undefined {
  const explicit = process.env.CLIP_ENV?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") return "production";
  return undefined;
}

export function resolveEnvFilePath(repoRoot: string): string | null {
  const envName = resolveClipEnvName();
  if (!envName) return null;
  return join(repoRoot, "deploy", `.env.${envName}`);
}

export function bootstrapEnv(repoRoot: string): string[] {
  const path = resolveEnvFilePath(repoRoot);
  if (!path) return [];
  loadEnvFile(path);
  return existsSync(path) ? [path] : [];
}
