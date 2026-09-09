import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function loadJson<T>(relativePath: string): T {
  const path = join(root, "..", relativePath);
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export const DEFAULT_PROFILE_ID = "gpu_4060_standard";
export const DEFAULT_RULE_SET_ID = "drama-default-v1";
