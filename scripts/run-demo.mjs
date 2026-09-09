#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.CLIP_DEMO_PORT ?? "18080";
const apiBase = process.env.CLIP_API_BASE ?? `http://127.0.0.1:${apiPort}`;
const credPath = join(root, "data", "demo-credentials.json");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runNode(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code}`));
    });
  });
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function ensureRegistered() {
  await mkdir(join(root, "data"), { recursive: true });
  process.env.CLIP_AGENT_CREDENTIALS = credPath;
  await runNode(join(root, "apps/clip-agent/dist/cli.js"), [
    "register",
    "--api-base",
    apiBase,
    "--machine-id",
    "demo-4060",
  ], { CLIP_AGENT_CREDENTIALS: credPath });
}

async function main() {
  console.log("[demo] building...");
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("build failed"))));
  });

  console.log("[demo] bootstrapping engines...");
  await runNode(join(root, "scripts/bootstrap.mjs"));

  const api = spawn(process.execPath, [join(root, "apps/api-server/dist/index.js")], {
    cwd: join(root, "apps/api-server"),
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: apiPort,
      CLIP_API_BASE: apiBase,
      CLIP_OSS_ROOT: join(root, "data", "oss"),
    },
  });

  const shutdown = () => {
    api.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await waitFor(`${apiBase}/health`);

  await ensureRegistered();

  const sourceUrl = `${apiBase}/oss/sources/demo.mp4`;
  await fetch(`${apiBase}/admin/tasks/reset-demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl }),
  });

  console.log("[demo] running one task end-to-end...");
  await runNode(join(root, "apps/clip-agent/dist/cli.js"), [
    "run-once",
    "--api-base",
    apiBase,
    "--install-dir",
    join(root, "engines"),
  ], { CLIP_AGENT_CREDENTIALS: credPath });

  console.log("[demo] completed successfully");
  shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("[demo] failed:", err);
  process.exit(1);
});
