#!/usr/bin/env node
/**
 * 构建 Agent 热更新 zip（仅 JS/dist，不含 FFmpeg/FunASR/模型）。
 * 支持增量更新：对比上一版本文件 sha256，只打包变更文件。
 * 用法: node scripts/publish-agent-hotfix.mjs [version]
 * 输出: dist/clip-agent-hotfix-{version}.zip (全量) + clip-agent-hotfix-{version}-incremental.zip (增量) + sha256
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STAGING_PAIRS = [
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

async function readDefaultVersion() {
  const text = await readFile(join(root, "packages/sdk/src/constants.ts"), "utf-8");
  const m = text.match(/CLIP_AGENT_VERSION\s*=\s*"([^"]+)"/);
  const current = m?.[1] ?? "0.3.0";
  // 自动递增 patch 版本号（0.3.0 → 0.3.1）
  const parts = current.split(".").map(Number);
  if (parts.length === 3) {
    parts[2] += 1;
    return parts.join(".");
  }
  return current;
}

async function copyPath(srcRel, destRel, staging) {
  const src = join(root, srcRel);
  if (!existsSync(src)) return;
  const dest = join(staging, destRel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

async function materializeClipRuntime(staging) {
  const pairs = [
    ["packages/agent-core", "node_modules/@clip/agent-core"],
    ["packages/sdk", "node_modules/@clip/sdk"],
  ];
  for (const [from, to] of pairs) {
    const src = join(staging, from);
    if (!existsSync(src)) continue;
    const dest = join(staging, to);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true, force: true });
  }
}

async function zipDir(sourceDir, zipPath) {
  await mkdir(dirname(zipPath), { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
    return;
  }
  execSync(`cd "${sourceDir}" && zip -r -q "${zipPath}" .`, { stdio: "inherit" });
}

async function sha256File(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** 递归遍历目录，生成文件清单 { relativePath: sha256 } */
async function buildFileManifest(dir) {
  const manifest = {};
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dir, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const sha256 = await sha256File(fullPath);
        manifest[relPath] = sha256;
      }
    }
  }
  await walk(dir);
  return manifest;
}

/** 对比两个清单，返回变更的文件列表 */
async function diffManifest(currentManifest, prevManifest) {
  const changed = [];
  const deleted = [];
  const prevKeys = new Set(Object.keys(prevManifest || {}));

  for (const [path, sha256] of Object.entries(currentManifest)) {
    prevKeys.delete(path);
    if (!prevManifest || prevManifest[path] !== sha256) {
      changed.push(path);
    }
  }

  for (const path of prevKeys) {
    deleted.push(path);
  }

  return { changed, deleted };
}

/** 只复制变更的文件到增量目录，并写增量清单（基准版本 + 删除列表） */
async function copyIncrementalFiles(staging, incDir, changedFiles, deletedFiles, baseVersion, targetVersion) {
  await rm(incDir, { recursive: true, force: true });
  for (const relPath of changedFiles) {
    const src = join(staging, relPath);
    const dest = join(incDir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: false, force: true });
  }
  await writeFile(
    join(incDir, "INCREMENTAL_MANIFEST.json"),
    JSON.stringify(
      {
        baseVersion,
        targetVersion,
        files: changedFiles,
        deleted: deletedFiles,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function main() {
  const version = process.argv[2] || (await readDefaultVersion());
  console.log(`[hotfix] building agent packages for v${version}…`);
  execSync(
    "npm run build -w @clip/clip-schema -w @clip/sdk -w @clip/agent-core -w @clip/ffmpeg-templates -w @clip/clip-agent",
    { cwd: root, stdio: "inherit" },
  );

  const staging = join(root, "dist/agent-hotfix-staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const [srcRel, destRel] of STAGING_PAIRS) {
    await copyPath(srcRel, destRel, staging);
  }
  await materializeClipRuntime(staging);
  const hotfixVersionPath = join(staging, "clip-agent/HOTFIX_VERSION.json");
  await mkdir(dirname(hotfixVersionPath), { recursive: true });
  await writeFile(
    hotfixVersionPath,
    JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  // 生成当前版本文件清单
  const currentManifest = await buildFileManifest(staging);
  const manifestPath = join(root, "dist", `agent-file-manifest-v${version}.json`);
  await writeFile(manifestPath, JSON.stringify(currentManifest, null, 2), "utf-8");
  console.log(`[hotfix] file manifest saved to ${manifestPath}`);

  // 对比上一版本，生成增量包
  let incrementalZipPath = null;
  let incrementalSha256 = null;
  let incrementalSizeBytes = 0;

  const distDir = join(root, "dist");
  // 上一版 manifest：按版本号取最大的（不能按文件名排序，v0.3.9 > v0.3.14 是字符串陷阱）
  const prevManifestFiles = (await readdir(distDir))
    .filter((f) => /^agent-file-manifest-v[\d.]+\.json$/.test(f))
    .map((f) => f.match(/^agent-file-manifest-v([\d.]+)\.json$/)[1])
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });
  const prevVersion = prevManifestFiles.find((v) => v !== version);

  if (prevVersion) {
    const prevManifestFile = `agent-file-manifest-v${prevVersion}.json`;
    console.log(`[hotfix] comparing with ${prevManifestFile}…`);
    const prevManifestPath = join(distDir, prevManifestFile);
    const prevManifestText = await readFile(prevManifestPath, "utf-8");
    const prevManifest = JSON.parse(prevManifestText);
    const { changed, deleted } = await diffManifest(currentManifest, prevManifest);

    console.log(`[hotfix] changed files: ${changed.length}, deleted: ${deleted.length}`);

    if (changed.length > 0 || deleted.length > 0) {
      // 增量 staging 放在 staging 外，避免被打进全量包
      const incDir = join(distDir, `.inc-staging-${version}`);
      await copyIncrementalFiles(staging, incDir, changed, deleted, prevVersion, version);
      incrementalZipPath = join(distDir, `clip-agent-hotfix-${version}-incremental.zip`);
      await rm(incrementalZipPath, { force: true });
      await zipDir(incDir, incrementalZipPath);
      const incInfo = await stat(incrementalZipPath);
      incrementalSha256 = await sha256File(incrementalZipPath);
      incrementalSizeBytes = incInfo.size;
      await rm(incDir, { recursive: true, force: true });
      console.log(`[hotfix] incremental zip: ${incInfo.size} bytes, sha256=${incrementalSha256.slice(0, 12)}…`);
    } else {
      console.log("[hotfix] no changes detected, skipping incremental zip");
    }
  } else {
    console.log("[hotfix] no previous version found, skipping incremental zip");
  }

  // 生成全量包
  const zipPath = join(distDir, `clip-agent-hotfix-${version}.zip`);
  await rm(zipPath, { force: true });
  await zipDir(staging, zipPath);
  const info = await stat(zipPath);
  const sha256 = await sha256File(zipPath);

  console.log("\n[hotfix] done");
  console.log(JSON.stringify({ version, zipPath, sizeBytes: info.size, sha256 }, null, 2));
  if (incrementalZipPath) {
    console.log(
      JSON.stringify(
        {
          incremental: {
            zipPath: incrementalZipPath,
            sizeBytes: incrementalSizeBytes,
            sha256: incrementalSha256,
          },
        },
        null,
        2,
      ),
    );
  }
  console.log("\n下一步: 在 Admin「系统配置 → Agent 热更新」上传 zip，或:");
  console.log(`  curl -F version=${version} -F file=@${zipPath} http://<api>/admin/agent-releases/upload`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
