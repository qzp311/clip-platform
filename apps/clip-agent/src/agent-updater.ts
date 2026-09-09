import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AgentUpdateInfo } from "@clip/sdk";
import {
  AGENT_HOTFIX_INSTALL_PATHS,
  AGENT_HOTFIX_VERSION_FILE,
  AGENT_INCREMENTAL_MANIFEST_FILE,
  compareAgentVersion,
  isAgentVersionNewer,
  type AgentIncrementalManifest,
} from "@clip/sdk";
import { dataRoot } from "./config.js";
import { readEffectiveAgentVersion } from "./effective-version.js";
import { resolveAgentPaths } from "./paths.js";

export function isAutoUpdateEnabled(): boolean {
  return process.env.CLIP_AUTO_UPDATE !== "false";
}

export async function maybeApplyAgentUpdate(input: {
  update: AgentUpdateInfo;
  installDir?: string;
  apiBase: string;
  authHeaders: Record<string, string>;
}): Promise<boolean> {
  if (!isAutoUpdateEnabled()) return false;
  if (!input.update.available || !input.update.downloadUrl || !input.update.version) return false;
  if (process.platform !== "win32") {
    console.log("[clip-agent] auto-update skipped (Windows only for hotfix zip)");
    return false;
  }

  const currentVersion = await readEffectiveAgentVersion(input.installDir);
  if (!isAgentVersionNewer(input.update.version, currentVersion)) return false;

  console.log(
    `[clip-agent] 开始热更新 v${input.update.version}（当前 ${currentVersion}）…`,
  );

  const paths = resolveAgentPaths({ installDir: input.installDir });
  const installRoot = paths.installDir;
  const workDir = join(dataRoot(), "updates");
  const zipPath = join(workDir, `clip-agent-${input.update.version}.zip`);
  const stagingDir = join(workDir, `staging-${input.update.version}`);

  await mkdir(workDir, { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  // 优先尝试增量包
  const updateUrl = input.update.incrementalUrl ?? input.update.downloadUrl;
  const updateSha256 = input.update.incrementalSha256 ?? input.update.sha256;
  const isIncremental = !!input.update.incrementalUrl;

  await downloadFile(updateUrl, zipPath, input.authHeaders);
  if (updateSha256) {
    const actual = await sha256File(zipPath);
    if (actual.toLowerCase() !== updateSha256.toLowerCase()) {
      if (isIncremental) {
        console.warn(`[clip-agent] 增量包 sha256 不匹配，回退全量包`);
        await rm(zipPath, { force: true });
        // 回退到全量包
        await downloadFile(input.update.downloadUrl, zipPath, input.authHeaders);
        const actualFull = await sha256File(zipPath);
        if (input.update.sha256 && actualFull.toLowerCase() !== input.update.sha256.toLowerCase()) {
          throw new Error(`全量包 sha256 也不匹配: expected ${input.update.sha256}, got ${actualFull}`);
        }
      } else {
        throw new Error(`update sha256 mismatch: expected ${updateSha256}, got ${actual}`);
      }
    }
  }

  await extractZipWindows(zipPath, stagingDir);

  if (isIncremental) {
    // 增量包：校验基准版本 → 文件级合并 → 删除清单
    const applied = await applyIncremental(stagingDir, installRoot, currentVersion, input.update.version);
    if (!applied) {
      // 基准版本不匹配：清 staging 回退全量包
      console.warn(`[clip-agent] 增量包基准版本不匹配，回退全量包`);
      await rm(zipPath, { force: true });
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      await downloadFile(input.update.downloadUrl, zipPath, input.authHeaders);
      const actualFull = await sha256File(zipPath);
      if (input.update.sha256 && actualFull.toLowerCase() !== input.update.sha256.toLowerCase()) {
        throw new Error(`全量包 sha256 不匹配: expected ${input.update.sha256}, got ${actualFull}`);
      }
      await extractZipWindows(zipPath, stagingDir);
      await applyHotfixPaths(stagingDir, installRoot);
    }
  } else {
    await applyHotfixPaths(stagingDir, installRoot);
  }
  await writeHotfixVersionMarker(installRoot, input.update.version, input.update.sha256);

  const launcher = resolveLauncherCmd(installRoot, paths);
  if (process.env.CLIP_DESKTOP_MANAGED === "1") {
    console.log(
      `[clip-agent] update v${input.update.version} applied; exiting for desktop restart`,
    );
    setTimeout(() => process.exit(0), 500);
    return true;
  }
  await spawnApplyAndRestart(installRoot, launcher, input.update.version);
  return true;
}

async function downloadFile(
  url: string,
  dest: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`download update failed: ${res.status} (${url})`);
  }
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
  const info = await stat(dest);
  console.log(`[clip-agent] downloaded update ${(info.size / 1024 / 1024).toFixed(2)}MB -> ${dest}`);
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function extractZipWindows(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await execPowerShell(
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  );
}

async function applyHotfixPaths(stagingDir: string, installRoot: string): Promise<void> {
  for (const rel of AGENT_HOTFIX_INSTALL_PATHS) {
    const src = join(stagingDir, rel);
    if (!existsSync(src)) continue;
    const dest = join(installRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true, force: true });
    console.log(`[clip-agent] updated ${rel}`);
  }
}

/**
 * 应用增量包：文件级合并（不整目录替换）。
 * 返回 false 表示基准版本不匹配，调用方应回退全量包。
 */
async function applyIncremental(
  stagingDir: string,
  installRoot: string,
  currentVersion: string,
  targetVersion: string,
): Promise<boolean> {
  // 读取包内清单
  let manifest: AgentIncrementalManifest;
  try {
    const raw = await readFile(join(stagingDir, AGENT_INCREMENTAL_MANIFEST_FILE), "utf-8");
    manifest = JSON.parse(raw) as AgentIncrementalManifest;
  } catch {
    console.warn(`[clip-agent] 增量包缺少 ${AGENT_INCREMENTAL_MANIFEST_FILE}，回退全量包`);
    return false;
  }

  // 基准版本校验：本地版本必须等于 diff 基准，否则 diff 语义不成立
  if (compareAgentVersion(currentVersion, manifest.baseVersion) !== 0) {
    console.warn(
      `[clip-agent] 增量包基准 v${manifest.baseVersion} 与本地 v${currentVersion} 不符，回退全量包`,
    );
    return false;
  }
  if (manifest.targetVersion !== targetVersion) {
    console.warn(
      `[clip-agent] 增量包目标版本 ${manifest.targetVersion} 与服务端 ${targetVersion} 不符，回退全量包`,
    );
    return false;
  }

  // 完整性自检：清单里的每个变更文件都必须在包内
  const missing = manifest.files.filter((rel) => !existsSync(join(stagingDir, rel)));
  if (missing.length) {
    console.warn(`[clip-agent] 增量包缺文件（${missing.slice(0, 3).join(", ")}…），回退全量包`);
    return false;
  }

  // 删除上一版多余的文件（先删后拷，避免旧文件残留）
  for (const rel of manifest.deleted) {
    const dest = join(installRoot, rel);
    await rm(dest, { recursive: true, force: true });
    console.log(`[clip-agent] removed ${rel}`);
  }

  // 逐文件覆盖（不存在则创建，不动未变更文件）
  for (const rel of manifest.files) {
    const src = join(stagingDir, rel);
    const dest = join(installRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await cp(src, dest, { force: true });
  }
  console.log(`[clip-agent] 增量合并完成：${manifest.files.length} 个文件，删除 ${manifest.deleted.length} 个`);
  return true;
}

async function writeHotfixVersionMarker(
  installRoot: string,
  version: string,
  sha256?: string,
): Promise<void> {
  const markerPath = join(installRoot, AGENT_HOTFIX_VERSION_FILE);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify({ version, sha256, appliedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

function resolveLauncherCmd(installRoot: string, paths: ReturnType<typeof resolveAgentPaths>): string {
  const cmd = join(installRoot, "clip-agent.cmd");
  if (existsSync(cmd)) return cmd;
  const node = paths.nodePath;
  const cli = join(installRoot, "clip-agent", "dist", "cli.js");
  if (existsSync(cli)) return `"${node}" "${cli}" run`;
  throw new Error(`cannot find launcher under ${installRoot}`);
}

async function spawnApplyAndRestart(
  installRoot: string,
  launcher: string,
  version: string,
): Promise<void> {
  const scriptPath = join(dataRoot(), "updates", "restart-after-update.cmd");
  const lines = [
    "@echo off",
    "timeout /t 3 /nobreak >nul",
    `cd /d "${installRoot}"`,
    launcher.includes(".cmd")
      ? `start "" "${launcher}" run`
      : `start "" ${launcher}`,
    "exit",
    "",
  ];
  await writeFile(scriptPath, lines.join("\r\n"), "utf-8");
  console.log(`[clip-agent] update v${version} applied; restarting via ${scriptPath}`);
  spawn("cmd.exe", ["/c", scriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  setTimeout(() => process.exit(0), 500);
}

function execPowerShell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { stdio: "inherit", windowsHide: true },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exit ${code}`));
    });
  });
}
