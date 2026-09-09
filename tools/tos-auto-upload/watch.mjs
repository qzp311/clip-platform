#!/usr/bin/env node
/**
 * Auto-watch folder: any .zip that finishes writing -> upload TOS -> activate mix task.
 *
 * Usage:
 *   npm install
 *   node watch.mjs
 *   start.cmd
 */
import { watch } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  CONFIG_PATH,
  createTosClient,
  formatUploadError,
  loadConfig,
  loadTosSettings,
  uploadLocalFileToTos,
} from "./common.mjs";
import { activateDramaPackage, parseDramaZipFilename } from "./activate.mjs";

const TAG = "tos-watch";

function parseArgs(argv) {
  const args = { dir: "", intervalSec: 0, stableSec: 0, concurrency: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(`Usage:
  node watch.mjs [--dir D:\\inbox] [--interval 3] [--stable 5] [--concurrency 4]

Config: config.json`);
      process.exit(0);
    }
    if (a === "--dir") {
      args.dir = resolve(String(argv[++i] ?? "").trim());
      continue;
    }
    if (a === "--interval") {
      args.intervalSec = Number(argv[++i] ?? 0);
      continue;
    }
    if (a === "--stable") {
      args.stableSec = Number(argv[++i] ?? 0);
      continue;
    }
    if (a === "--concurrency") {
      args.concurrency = Number(argv[++i] ?? 0);
      continue;
    }
    if (a.startsWith("-")) throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isZipCandidate(name) {
  const lower = String(name ?? "").toLowerCase();
  if (!lower.endsWith(".zip")) return false;
  if (lower.endsWith(".tmp.zip") || lower.endsWith(".partial.zip")) return false;
  if (name.startsWith(".") || name.startsWith("~$") || name.startsWith("._")) return false;
  if (lower.includes(".download") || lower.includes(".crdownload") || lower.endsWith(".part")) {
    return false;
  }
  return true;
}

function shouldSkipDir(name) {
  return name === "_failed" || name === "node_modules" || name.startsWith(".");
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function assertWatchDir(watchDir) {
  let st;
  try {
    st = await stat(watchDir);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      await ensureDir(watchDir);
      return;
    }
    throw err;
  }
  if (st.isFile()) {
    throw new Error(
      `watchDir points to a FILE, must be a FOLDER:\n  ${watchDir}\n` +
        `Example: "watchDir": "D:\\\\changdudownload"`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`watchDir is not a directory: ${watchDir}`);
  }
}

/** Recursively collect zip files under root (skip _failed) */
async function listZipFiles(rootDir) {
  /** @type {string[]} */
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[${TAG}] readdir failed: ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        await walk(full);
        continue;
      }
      if (ent.isFile() && isZipCandidate(name)) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  out.sort();
  return out;
}

async function moveToFailed(filePath, failedDir, reason) {
  await ensureDir(failedDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = basename(filePath);
  const dest = join(failedDir, `${stamp}_${base}`);
  try {
    await rename(filePath, dest);
    console.error(`[${TAG}] moved to failed: ${dest}`);
  } catch (err) {
    console.error(`[${TAG}] move failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await writeFile(join(failedDir, "errors.log"), `${new Date().toISOString()} ${base} => ${reason}\n`, {
    flag: "a",
  }).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(CONFIG_PATH);
  const settings = loadTosSettings(cfg);

  const watchDir = resolve(args.dir || process.env.TOS_WATCH_DIR || cfg.watchDir || "");
  if (!watchDir) {
    throw new Error('Missing watchDir. Set in config.json or pass --dir D:\\inbox');
  }

  const intervalSec = Math.max(
    2,
    Number(args.intervalSec || process.env.TOS_WATCH_INTERVAL || cfg.intervalSec || 3) || 3,
  );
  // Allow 0 for "upload when size unchanged between two polls"
  const stableSec = Math.max(
    0,
    Number(args.stableSec ?? process.env.TOS_WATCH_STABLE ?? cfg.stableSec ?? 5) || 5,
  );
  const concurrency = Math.max(
    1,
    Math.min(
      16,
      Number(args.concurrency || process.env.TOS_WATCH_CONCURRENCY || cfg.concurrency || 4) || 4,
    ),
  );
  const failedDir = join(watchDir, "_failed");
  const uploadedLog = join(watchDir, "_uploaded.log");
  const apiBaseUrl = String(
    process.env.CLIP_API_BASE || cfg.apiBaseUrl || cfg.apiBase || "",
  ).trim();
  const asrRuleSetId = String(cfg.asrRuleSetId || "drama-default-v1").trim();
  const activateAfterUpload = cfg.activateAfterUpload !== false;

  await assertWatchDir(watchDir);
  await ensureDir(failedDir);

  console.log(`[${TAG}] config: ${CONFIG_PATH}`);
  console.log(`[${TAG}] AUTO-WATCH dir: ${watchDir}`);
  console.log(`[${TAG}] interval=${intervalSec}s stable=${stableSec}s concurrency=${concurrency}`);
  console.log(`[${TAG}] bucket=${settings.bucket} prefix=${settings.prefix}`);
  console.log(`[${TAG}] failedDir: ${failedDir}`);
  console.log(
    `[${TAG}] activateAfterUpload=${activateAfterUpload} apiBaseUrl=${apiBaseUrl || "(not set)"}`,
  );
  console.log(`[${TAG}] Drop .zip into the folder (or subfolders) -> auto upload. Ctrl+C to quit.`);

  // 启动时快速探测 api-server 是否可达，避免上传完才暴露配置错误
  if (activateAfterUpload && apiBaseUrl) {
    const healthUrl = `${apiBaseUrl.replace(/\/+$/, "")}/health`;
    const controller = new AbortController();
    const healthTimer = setTimeout(() => controller.abort(), 10_000);
    try {
      const healthRes = await fetch(healthUrl, { signal: controller.signal });
      console.log(`[${TAG}] api-server health: HTTP ${healthRes.status} ${healthRes.ok ? "ok" : "not ok"}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[${TAG}] api-server unreachable: ${detail}`);
      console.warn(`[${TAG}] uploads will still run, but activate-package will likely fail. Check apiBaseUrl.`);
    } finally {
      clearTimeout(healthTimer);
    }
  }

  const { client, UploadEventType } = createTosClient(settings);

  /** @type {Map<string, { size: number, mtimeMs: number, since: number, hits: number }>} */
  const stableMap = new Map();
  /** @type {Set<string>} */
  const inflight = new Set();
  let scanning = false;
  let scanQueued = false;
  let lastScanReason = "";
  /** @type {ReturnType<typeof setTimeout> | null} */
  let stableTimer = null;

  function requestScan(reason) {
    lastScanReason = reason;
    if (scanning) {
      scanQueued = true;
      return;
    }
    void runScanLoop(reason);
  }

  function scheduleStableRecheck() {
    let soonest = Infinity;
    const now = Date.now();
    for (const [, v] of stableMap) {
      const readyAt = v.since + stableSec * 1000;
      if (readyAt < soonest) soonest = readyAt;
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(300, soonest - now + 100);
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      requestScan("stable-timer");
    }, delay);
  }

  async function runScanLoop(reason) {
    if (scanning) {
      scanQueued = true;
      return;
    }
    scanning = true;
    try {
      do {
        scanQueued = false;
        await doScan(lastScanReason || reason);
      } while (scanQueued);
    } finally {
      scanning = false;
    }
  }

  async function uploadOne(fullPath) {
    const name = basename(fullPath);
    inflight.add(fullPath);
    console.log(`[${TAG}] upload start (${inflight.size}/${concurrency}): ${name}`);
    try {
      const result = await uploadLocalFileToTos(client, UploadEventType, settings, fullPath, {
        tag: `${TAG}:${name}`,
      });

      if (activateAfterUpload) {
        const parsed = parseDramaZipFilename(name);
        if (!parsed) {
          throw new Error(`filename must be 短剧名称_短剧ID.zip, got: ${name}`);
        }
        if (!apiBaseUrl) {
          throw new Error("apiBaseUrl missing in config.json (needed to activate mix task)");
        }
        console.log(
          `[${TAG}] activate package: title=${parsed.title} id=${parsed.externalDramaId}`,
        );
        const activated = await activateDramaPackage(apiBaseUrl, {
          externalDramaId: parsed.externalDramaId,
          title: parsed.title,
          sourceUrl: result.publicUrl,
          packageObjectKey: result.objectKey,
          packageName: name,
          asrRuleSetId,
        });
        console.log(
          `[${TAG}] activated: taskId=${activated.taskId} dramaId=${activated.dramaId} intakeFound=${activated.intakeFound}`,
        );
        await writeFile(
          uploadedLog,
          `${new Date().toISOString()}\t${fullPath}\t${result.objectKey}\t${result.publicUrl}\t${activated.taskId}\t${activated.dramaId ?? ""}\n`,
          { flag: "a" },
        );
      } else {
        await writeFile(
          uploadedLog,
          `${new Date().toISOString()}\t${fullPath}\t${result.objectKey}\t${result.publicUrl}\n`,
          { flag: "a" },
        );
      }

      await unlink(fullPath);
      console.log(`[${TAG}] deleted local: ${fullPath}`);
    } catch (err) {
      const { message, hints } = formatUploadError(err);
      console.error(`[${TAG}] upload/activate failed: ${name}: ${message}`);
      for (const h of hints) console.error(`[${TAG}] tip: ${h}`);
      await moveToFailed(fullPath, failedDir, message);
    } finally {
      inflight.delete(fullPath);
      stableMap.delete(fullPath);
      console.log(`[${TAG}] slot free (${inflight.size}/${concurrency})`);
      requestScan("slot-free");
    }
  }

  async function doScan(reason) {
    const zipPaths = await listZipFiles(watchDir);
    /** @type {string[]} */
    const ready = [];
    let waiting = 0;
    const now = Date.now();

    if (reason === "startup" || reason === "poll" || reason === "stable-timer" || reason === "fs-event") {
      console.log(
        `[${TAG}] scan(${reason}): found ${zipPaths.length} zip(s), uploading ${inflight.size}/${concurrency}`,
      );
      if (reason === "startup" && zipPaths.length) {
        for (const p of zipPaths) console.log(`[${TAG}]   - ${p}`);
      }
    }

    for (const fullPath of zipPaths) {
      if (inflight.has(fullPath)) continue;

      let st;
      try {
        st = await stat(fullPath);
      } catch {
        stableMap.delete(fullPath);
        continue;
      }
      if (!st.isFile() || st.size <= 0) {
        stableMap.delete(fullPath);
        continue;
      }

      const mtimeMs = st.mtimeMs || 0;
      const prev = stableMap.get(fullPath);

      // size or mtime changed => still writing
      if (!prev || prev.size !== st.size || prev.mtimeMs !== mtimeMs) {
        stableMap.set(fullPath, {
          size: st.size,
          mtimeMs,
          since: now,
          hits: 1,
        });
        console.log(
          `[${TAG}] detected/writing: ${basename(fullPath)} (${Math.round(st.size / 1024 / 1024)}MB), wait stable ${stableSec}s…`,
        );
        waiting += 1;
        continue;
      }

      const unchangedHits = (prev.hits || 1) + 1;
      prev.hits = unchangedHits;
      stableMap.set(fullPath, prev);

      const elapsed = now - prev.since;
      // Ready when: unchanged for stableSec, OR at least 2 consecutive unchanged polls when stableSec is short
      const readyByTime = elapsed >= stableSec * 1000;
      const readyByHits = unchangedHits >= 2 && elapsed >= Math.min(stableSec, 3) * 1000;
      if (!readyByTime && !readyByHits) {
        waiting += 1;
        continue;
      }

      ready.push(fullPath);
    }

    // cleanup disappeared
    const zipSet = new Set(zipPaths);
    for (const key of [...stableMap.keys()]) {
      if (!zipSet.has(key)) stableMap.delete(key);
    }

    if (waiting > 0) scheduleStableRecheck();

    const slots = concurrency - inflight.size;
    if (slots <= 0) {
      console.log(`[${TAG}] all slots busy (${inflight.size}/${concurrency}), waiting…`);
      return;
    }
    if (ready.length === 0) {
      if (zipPaths.length === 0 && (reason === "startup" || reason === "poll")) {
        console.log(`[${TAG}] no .zip in ${watchDir} (and subfolders)`);
      } else if (waiting > 0) {
        console.log(`[${TAG}] ${waiting} zip(s) waiting to become stable…`);
      }
      return;
    }

    const batch = ready.slice(0, slots);
    console.log(`[${TAG}] starting ${batch.length} upload(s)`);
    for (const fullPath of batch) {
      stableMap.delete(fullPath);
      void uploadOne(fullPath);
    }
  }

  // Folder events (best-effort on Windows)
  try {
    const watcher = watch(watchDir, { recursive: true, persistent: true }, (eventType, filename) => {
      const name = filename ? String(filename) : "";
      if (name && shouldSkipDir(name.split(/[\\/]/)[0] ?? "")) return;
      if (name && !name.toLowerCase().includes("zip") && name.length > 0) {
        // still scan — rename to .zip may arrive as non-matching intermediate name
      }
      console.log(`[${TAG}] folder event: ${eventType}${name ? ` ${name}` : ""}`);
      requestScan("fs-event");
    });
    watcher.on("error", (err) => {
      console.error(`[${TAG}] fs.watch error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[${TAG}] continue with polling only`);
    });
    console.log(`[${TAG}] fs.watch enabled (recursive)`);
  } catch (err) {
    console.warn(
      `[${TAG}] fs.watch unavailable (${err instanceof Error ? err.message : String(err)}), polling only`,
    );
  }

  // Initial scan for existing files
  await runScanLoop("startup");

  // Reliable backup poll (always on)
  while (true) {
    await sleep(intervalSec * 1000);
    requestScan("poll");
    // give requestScan a tick to run when queue is empty
    await sleep(50);
  }
}

main().catch((err) => {
  console.error(`[${TAG}] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
