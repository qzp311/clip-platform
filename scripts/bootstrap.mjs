#!/usr/bin/env node
import { copyFile, mkdir, access, chmod, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enginesDir = join(root, "engines");
const ffmpegDir = join(enginesDir, "ffmpeg");
const funasrDir = join(enginesDir, "funasr");
const ossDir = join(root, "data", "oss", "sources");
const demoSource = join(root, "fixtures", "test-source.mp4");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureFfmpeg() {
  if (process.platform === "win32") {
    const { ensureWindowsFfmpeg } = await import("./ensure-ffmpeg-windows.mjs");
    const { ffmpegPath } = await ensureWindowsFfmpeg({ installDir: root });
    return ffmpegPath;
  }

  await mkdir(ffmpegDir, { recursive: true });
  const target = join(ffmpegDir, "ffmpeg");
  if (await exists(target)) {
    console.log(`[bootstrap] ffmpeg ready: ${target}`);
    return target;
  }

  try {
    const systemFfmpeg = execSync("which ffmpeg", { encoding: "utf-8" }).trim();
    if (systemFfmpeg) {
      console.log(`[bootstrap] using system ffmpeg: ${systemFfmpeg}`);
      await writeFile(join(ffmpegDir, "PATH.txt"), systemFfmpeg, "utf-8");
      return systemFfmpeg;
    }
  } catch {
    // continue
  }

  if (process.platform === "darwin") {
    console.log("[bootstrap] macOS detected — install ffmpeg via `brew install ffmpeg` if missing");
  }

  return "ffmpeg";
}

async function ensureFunasrServer() {
  await mkdir(funasrDir, { recursive: true });
  const entry = join(root, "apps", "funasr-server", "dist", "index.js");
  const launcher = join(funasrDir, process.platform === "win32" ? "funasr-server.cmd" : "funasr-server.sh");

  const script =
    process.platform === "win32"
      ? `@echo off\r\nnode "%~dp0..\\..\\apps\\funasr-server\\dist\\index.js" %*\r\n`
      : `#!/usr/bin/env bash\nexec node "$(cd "$(dirname "$0")/../.." && pwd)/apps/funasr-server/dist/index.js" "$@"\n`;

  await writeFile(launcher, script, "utf-8");
  if (process.platform !== "win32") {
    await chmod(launcher, 0o755);
  }

  const manifest = {
    type: "node-bundle",
    entry,
    backend: process.env.CLIP_ASR_BACKEND ?? (process.platform === "win32" ? "funasr-gpu" : "vad"),
    note: "Built-in ASR sidecar. Set CLIP_ASR_BACKEND=whisper for real speech recognition.",
  };
  await writeFile(join(funasrDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[bootstrap] funasr-server launcher: ${launcher}`);
  return { launcher, entry };
}

async function ensureDemoAssets() {
  await mkdir(ossDir, { recursive: true });
  const target = join(ossDir, "demo.mp4");
  if (!(await exists(target)) && (await exists(demoSource))) {
    await copyFile(demoSource, target);
    console.log(`[bootstrap] demo source seeded: ${target}`);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
}

async function ensureModelCdn() {
  execSync("node scripts/download-asr-models.mjs", { cwd: root, stdio: "inherit" });
}

async function main() {
  console.log("[bootstrap] clip-platform zero-setup");
  await ensureFfmpeg();
  await ensureFunasrServer();
  await ensureModelCdn();
  await ensureDemoAssets();
  console.log("[bootstrap] done. Run `npm run demo` to process a full task.");
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err);
  process.exit(1);
});
