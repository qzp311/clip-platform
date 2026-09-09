import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CLIP_DEFAULT_API_BASE } from "@clip/sdk";
import { normalizeApiBase } from "./api-connectivity.js";

export interface AgentInstallConfig {
  apiBase: string;
  asrBackend?: string;
  modelsDir?: string;
}

export function dataRoot(): string {
  if (process.env.CLIP_DATA_ROOT?.trim()) {
    return process.env.CLIP_DATA_ROOT.trim();
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ClipAgent");
  }
  return join(homedir(), ".clip-agent");
}

export function credentialsPath(): string {
  return process.env.CLIP_AGENT_CREDENTIALS ?? join(dataRoot(), "credentials.json");
}

export function loadInstallConfig(repoRoot: string): AgentInstallConfig {
  const candidates = [
    join(dataRoot(), "config.json"),
    join(repoRoot, "config.json"),
    join(repoRoot, "assets", "config.json"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentInstallConfig>;
      if (raw.apiBase) return { ...raw, apiBase: normalizeApiBase(raw.apiBase) };
    } catch {
      // try next
    }
  }

  return {
    apiBase: normalizeApiBase(process.env.CLIP_API_BASE ?? CLIP_DEFAULT_API_BASE),
    asrBackend: process.env.CLIP_ASR_BACKEND ?? (process.platform === "win32" ? "funasr-gpu" : "vad"),
  };
}

export function resolveApiBase(repoRoot: string, override?: string): string {
  if (override) return normalizeApiBase(override);
  return loadInstallConfig(repoRoot).apiBase;
}
