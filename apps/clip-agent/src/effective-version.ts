import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_HOTFIX_VERSION_FILE,
  CLIP_AGENT_VERSION,
  type AgentHotfixVersionFile,
} from "@clip/sdk";
import { resolveAgentPaths } from "./paths.js";

export async function readEffectiveAgentVersion(installDir?: string): Promise<string> {
  const paths = resolveAgentPaths({ installDir });
  const hotfixPath = join(paths.installDir, AGENT_HOTFIX_VERSION_FILE);
  try {
    const raw = await readFile(hotfixPath, "utf-8");
    const data = JSON.parse(raw) as AgentHotfixVersionFile;
    const version = data.version?.trim();
    if (version) return version;
  } catch {
    // no hotfix marker yet
  }
  return CLIP_AGENT_VERSION;
}
