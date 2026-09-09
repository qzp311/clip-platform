/** 解析 semver 前缀 x.y.z（忽略后缀如 -beta） */
export function parseAgentVersion(version: string): [number, number, number] | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a < b → 负数；a === b → 0；a > b → 正数 */
export function compareAgentVersion(a: string, b: string): number {
  const pa = parseAgentVersion(a);
  const pb = parseAgentVersion(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const diff = pa[i]! - pb[i]!;
      if (diff !== 0) return diff;
    }
    return 0;
  }
  return a.trim().localeCompare(b.trim());
}

export function isAgentVersionNewer(candidate: string, current: string): boolean {
  return compareAgentVersion(candidate, current) > 0;
}

export const AGENT_HOTFIX_VERSION_FILE = "clip-agent/HOTFIX_VERSION.json";

export interface AgentHotfixVersionFile {
  version: string;
  sha256?: string;
  builtAt?: string;
  appliedAt?: string;
}

/** 热更新 zip 内路径（相对安装根目录） */
export const AGENT_HOTFIX_INSTALL_PATHS = [
  "clip-agent/dist",
  "clip-agent/HOTFIX_VERSION.json",
  "packages/agent-core/dist",
  "packages/agent-core/package.json",
  "packages/sdk/dist",
  "packages/sdk/package.json",
  "packages/clip-schema",
  "packages/ffmpeg-templates/dist",
  "packages/ffmpeg-templates/package.json",
  "node_modules/@clip/agent-core/dist",
  "node_modules/@clip/agent-core/package.json",
  "node_modules/@clip/sdk/dist",
  "node_modules/@clip/sdk/package.json",
] as const;

/** 开发机构建路径 → 安装目录路径 */
export const AGENT_HOTFIX_STAGING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["apps/clip-agent/dist", "clip-agent/dist"],
  ["packages/agent-core/dist", "packages/agent-core/dist"],
  ["packages/agent-core/package.json", "packages/agent-core/package.json"],
  ["packages/sdk/dist", "packages/sdk/dist"],
  ["packages/sdk/package.json", "packages/sdk/package.json"],
  ["packages/clip-schema", "packages/clip-schema"],
  ["packages/ffmpeg-templates/dist", "packages/ffmpeg-templates/dist"],
  ["packages/ffmpeg-templates/package.json", "packages/ffmpeg-templates/package.json"],
  ["node_modules/@clip/agent-core/dist", "node_modules/@clip/agent-core/dist"],
  ["node_modules/@clip/agent-core/package.json", "node_modules/@clip/agent-core/package.json"],
  ["node_modules/@clip/sdk/dist", "node_modules/@clip/sdk/dist"],
  ["node_modules/@clip/sdk/package.json", "node_modules/@clip/sdk/package.json"],
];

export const AGENT_HOTFIX_MIN_ZIP_BYTES = 50 * 1024;

/** 增量包根部的清单文件名：记录基准版本与删除文件列表 */
export const AGENT_INCREMENTAL_MANIFEST_FILE = "INCREMENTAL_MANIFEST.json";

export interface AgentIncrementalManifest {
  /** 应用本增量包要求客户端已有的版本（sha256 diff 的基准） */
  baseVersion: string;
  /** 目标版本 */
  targetVersion: string;
  /** 本包内含的变更文件（相对安装根目录，用于完整性自检） */
  files: string[];
  /** 需要从安装目录删除的文件（上一版有、本版无） */
  deleted: string[];
  builtAt?: string;
}

/**
 * 增量包应用方式：文件级合并。
 * 全量包仍走整目录替换（applyHotfixPaths 的 rm+cp 语义）。
 */
export const AGENT_HOTFIX_APPLY_MODES = ["replace", "merge"] as const;
export type AgentHotfixApplyMode = (typeof AGENT_HOTFIX_APPLY_MODES)[number];

/** 判断热修 zip 根部是否带增量清单（决定 merge / replace 应用方式） */
export function detectHotfixApplyMode(
  stagingDirFiles: string[],
): AgentHotfixApplyMode {
  return stagingDirFiles.includes(AGENT_INCREMENTAL_MANIFEST_FILE) ? "merge" : "replace";
}
