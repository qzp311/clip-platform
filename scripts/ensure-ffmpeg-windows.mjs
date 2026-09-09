#!/usr/bin/env node
/**
 * 下载/校验 Windows 内置 FFmpeg（BtbN gpl 静态构建，含 NVENC/NVDEC）。
 * 静态 gpl 包通常只有 ffmpeg/ffprobe/ffplay 三个 exe，不能用“文件数太少”判断缺 DLL。
 *
 * 钉选 n7.1：master 夜建常带更新的 ffnvcodec（NVENC API 13.1+），
 * 在 Game Ready 572.x（NVENC 13.0）上会冒烟失败并整条回退 libx264 软编。
 * n7.1 与当前消费级驱动更匹配；驱动升到支持 13.1 后再考虑改回 master。
 */
import { copyFile, mkdir, access, readdir, rm } from "node:fs/promises";
import { createWriteStream, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyRuntimeDlls(ffmpegDir) {
  // 静态构建的 ffmpeg 理论上自带 CRT，但用户机缺失时旁路补充
  const needed = [
    "msvcp140.dll",
    "msvcp140_1.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
  ];
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sys32 = join(sysRoot, "System32");
  let copied = 0;
  for (const name of needed) {
    const src = join(sys32, name);
    const dest = join(ffmpegDir, name);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) continue;
    try {
      copyFileSync(src, dest);
      copied++;
    } catch { /* ignore */ }
  }
  if (copied) console.log(`[ffmpeg-setup] copied ${copied} CRT DLLs beside ffmpeg`);
}

/** 钉选 n7.1 gpl，避免 master 最新头文件要求过新驱动 */
const FFMPEG_ASSET = "ffmpeg-n7.1-latest-win64-gpl-7.1.zip";
const FFMPEG_ZIP_ROOT = "ffmpeg-n7.1-latest-win64-gpl-7.1";
const FFMPEG_URLS = [
  `https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_ASSET}`,
  `https://mirror.ghproxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_ASSET}`,
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_ASSET}`,
];
const DOWNLOAD_RETRIES = 3;

function parseArgs(argv) {
  let installDir = process.env.CLIP_INSTALL_DIR?.trim() || root;
  let force = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--install-dir" && argv[i + 1]) {
      installDir = argv[++i];
    }
  }
  return { installDir, force };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code ?? err?.code;
  if (
    typeof code === "string" &&
    /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/i.test(
      code,
    )
  ) {
    return true;
  }
  const msg = String(err?.message ?? err);
  return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|Connect Timeout|download timeout|AbortError/i.test(msg);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadOnce(url, dest, timeoutMs = 300_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(res.body, createWriteStream(dest));
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`download timeout ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function download(urls, dest) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const url of list) {
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        console.log(`[ffmpeg-setup] fetching ${url} (attempt ${attempt}/${DOWNLOAD_RETRIES})`);
        await downloadOnce(url, dest);
        return url;
      } catch (err) {
        lastErr = err;
        const transient = isTransientNetworkError(err);
        const statusMatch = String(err?.message ?? "").match(/download failed (\d+)/);
        const httpFatal = statusMatch && !["429", "500", "502", "503", "504"].includes(statusMatch[1]);
        if (httpFatal) break;
        if (!transient && !statusMatch) break;
        if (attempt === DOWNLOAD_RETRIES) break;
        const waitMs = attempt * 2000;
        console.warn(
          `[ffmpeg-setup] download retry ${attempt}/${DOWNLOAD_RETRIES} after ${waitMs}ms: ${err?.cause?.code ?? err?.message ?? err}`,
        );
        await sleep(waitMs);
      }
    }
    console.warn(`[ffmpeg-setup] URL 失败，尝试下一个源: ${lastErr?.cause?.code ?? lastErr?.message ?? lastErr}`);
  }
  throw lastErr;
}

/** @returns {{ runnable: boolean, hasNvenc: boolean, detail: string }} */
function probeEncoders(ffmpegExe) {
  try {
    const out = execSync(`"${ffmpegExe}" -hide_banner -encoders`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      runnable: true,
      hasNvenc: /h264_nvenc/i.test(out),
      detail: "",
    };
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    const msg = `${stderr}\n${err?.message ?? err}`.trim();
    const blocked = /Device Guard|应用控制|已被组织|被策略阻止|blocked by/i.test(msg);
    return {
      runnable: false,
      hasNvenc: false,
      detail: blocked
        ? `ffmpeg.exe 被 Device Guard / 应用控制策略拦截: ${msg.slice(0, 240)}`
        : `无法运行 ffmpeg.exe: ${msg.slice(0, 240)}`,
    };
  }
}

/** 实际编码几帧，比 -encoders 更能发现驱动 / 会话问题 */
function probeNvencSmoke(ffmpegExe) {
  try {
    execSync(
      `"${ffmpegExe}" -hide_banner -loglevel warning -f lavfi -i testsrc=duration=0.2:size=320x240:rate=30 -frames:v 5 -c:v h264_nvenc -preset p1 -f null NUL`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, detail: "" };
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    const stdout = err && typeof err === "object" && "stdout" in err ? String(err.stdout) : "";
    const detail = `${stderr}\n${stdout}`.trim().slice(0, 500);
    return { ok: false, detail: detail || String(err) };
  }
}

/** 驱动 NVENC API 落后于 FFmpeg 编译头：重装 FFmpeg 无意义，应提示升级驱动或软编回退 */
function isDriverApiMismatch(detail) {
  return /required nvenc API version/i.test(detail);
}

async function copyBinDirectory(srcBin, destDir) {
  await mkdir(destDir, { recursive: true });
  const names = await readdir(srcBin);
  for (const name of names) {
    await copyFile(join(srcBin, name), join(destDir, name));
  }
  return names.length;
}

/** 本机已有可用 FFmpeg（如 D:\\ClipAgent）时优先拷贝，避免卡在 GitHub 下载 */
async function tryAdoptLocalFfmpeg(destDir) {
  const candidates = [
    process.env.CLIP_FFMPEG_DIR?.trim(),
    process.env.CLIP_INSTALL_DIR ? join(process.env.CLIP_INSTALL_DIR.trim(), "engines", "ffmpeg") : "",
    "D:\\ClipAgent\\engines\\ffmpeg",
    "C:\\Program Files\\ClipAgent\\engines\\ffmpeg",
  ].filter(Boolean);

  for (const srcDir of candidates) {
    const srcExe = join(srcDir, "ffmpeg.exe");
    const srcProbe = join(srcDir, "ffprobe.exe");
    if (!(await fileExists(srcExe)) || !(await fileExists(srcProbe))) continue;
    if (join(srcDir).toLowerCase() === join(destDir).toLowerCase()) continue;

    const enc = probeEncoders(srcExe);
    if (!enc.runnable || !enc.hasNvenc) continue;
    const smoke = probeNvencSmoke(srcExe);
    if (!smoke.ok) {
      // 驱动 API 不匹配的也不要搬；只要能跑且带 nvenc 的优先搬「冒烟通过」的
      continue;
    }

    console.log(`[ffmpeg-setup] 采用本机已有 FFmpeg: ${srcDir}`);
    const names = await readdir(srcDir);
    await mkdir(destDir, { recursive: true });
    let copied = 0;
    for (const name of names) {
      if (!/\.(exe|txt)$/i.test(name)) continue;
      await copyFile(join(srcDir, name), join(destDir, name));
      copied += 1;
    }
    console.log(`[ffmpeg-setup] copied ${copied} files → ${destDir} (NVENC smoke ok)`);
    return true;
  }
  return false;
}

function logSmokeResult(ffmpegExe, smoke, context) {
  if (smoke.ok) {
    console.log(`[ffmpeg-setup] ${context}: ${ffmpegExe} (NVENC smoke ok)`);
    return;
  }
  if (isDriverApiMismatch(smoke.detail)) {
    console.warn(
      `[ffmpeg-setup] ${context}: 本机 NVIDIA 驱动 NVENC API 落后于当前 FFmpeg，硬编暂不可用，运行时将回退 libx264。详情: ${smoke.detail.slice(0, 200)}`,
    );
    console.warn("[ffmpeg-setup] 建议升级 Game Ready / Studio 驱动后再验证 NVENC");
    return;
  }
  console.warn(`[ffmpeg-setup] ${context}: NVENC 冒烟未通过: ${smoke.detail.slice(0, 200)}`);
}

export async function ensureWindowsFfmpeg(options = {}) {
  const installDir = options.installDir ?? root;
  const force = options.force ?? false;
  const ffmpegDir = join(installDir, "engines", "ffmpeg");
  const ffmpegExe = join(ffmpegDir, "ffmpeg.exe");
  const ffprobeExe = join(ffmpegDir, "ffprobe.exe");

  await mkdir(ffmpegDir, { recursive: true });

  const hasExe = await fileExists(ffmpegExe);
  const hasProbe = await fileExists(ffprobeExe);

  if (!force && hasExe && hasProbe) {
    const enc = probeEncoders(ffmpegExe);
    if (!enc.runnable) {
      console.warn(`[ffmpeg-setup] 已有安装不可运行，将重新下载: ${enc.detail}`);
    } else if (!enc.hasNvenc) {
      console.warn(`[ffmpeg-setup] ${ffmpegExe} 缺少 h264_nvenc，将重新下载`);
    } else {
      const smoke = probeNvencSmoke(ffmpegExe);
      if (smoke.ok) {
        console.log(`[ffmpeg-setup] ready: ${ffmpegExe} (NVENC smoke ok)`);
        return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: false };
      }
      // master 头文件过新 → 优先用本机已装的 n7.1；勿无超时地死磕 GitHub
      if (isDriverApiMismatch(smoke.detail)) {
        console.warn(
          `[ffmpeg-setup] 当前 FFmpeg 与本机驱动 NVENC API 不匹配: ${smoke.detail.slice(0, 160)}`,
        );
        if (await tryAdoptLocalFfmpeg(ffmpegDir)) {
          return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: true };
        }
        console.warn(
          `[ffmpeg-setup] 未找到本机可用的 n7.1，跳过联网重下以免卡住打包；运行时将回退 libx264。可手动升级驱动或把可用 ffmpeg 放到 engines/ffmpeg`,
        );
        return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: false };
      }
      logSmokeResult(ffmpegExe, smoke, "ready（已安装）");
      return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: false };
    }
  } else if (!force && hasExe && !hasProbe) {
    console.warn(`[ffmpeg-setup] 缺少 ffprobe.exe，将重新安装完整 bin`);
  }

  if (process.platform !== "win32") {
    console.log("[ffmpeg-setup] skip download on non-Windows");
    return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: false };
  }

  const enginesDir = join(installDir, "engines");
  const zipPath = join(enginesDir, "ffmpeg.zip");
  const extractRoot = join(enginesDir, FFMPEG_ZIP_ROOT);
  const srcBin = join(extractRoot, "bin");
  const candidateExe = join(srcBin, "ffmpeg.exe");

  // 下载前再试一次本机拷贝（无网/GitHub 慢时优先）
  if (await tryAdoptLocalFfmpeg(ffmpegDir)) {
    return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: true };
  }

  console.log(`[ffmpeg-setup] downloading FFmpeg (NVENC) → ${ffmpegDir}`);
  try {
    await download(FFMPEG_URLS, zipPath);
  } catch (err) {
    console.warn(
      `[ffmpeg-setup] 下载失败，保留现有 engines/ffmpeg 继续打包: ${err?.message ?? err}`,
    );
    if (await fileExists(ffmpegExe)) {
      logSmokeResult(ffmpegExe, probeNvencSmoke(ffmpegExe), "download-failed fallback");
      return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: false };
    }
    throw err;
  }

  // 先解到独立目录并校验，通过后再覆盖 engines/ffmpeg，避免坏包毁掉现有可用安装
  await rm(extractRoot, { recursive: true, force: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${enginesDir.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" },
  );

  if (!(await fileExists(candidateExe))) {
    throw new Error(`[ffmpeg-setup] 解压后未找到 ${candidateExe}`);
  }

  const enc = probeEncoders(candidateExe);
  if (!enc.runnable) {
    throw new Error(
      `[ffmpeg-setup] 新下载的 ffmpeg 无法运行（可能被 Device Guard 拦截或包损坏），已保留原 engines/ffmpeg。${enc.detail}`,
    );
  }
  if (!enc.hasNvenc) {
    throw new Error("[ffmpeg-setup] 下载的 FFmpeg 仍无 h264_nvenc，请检查构建版本（已保留原安装）");
  }

  const copied = await copyBinDirectory(srcBin, ffmpegDir);
  console.log(`[ffmpeg-setup] copied ${copied} files from bin/ → ${ffmpegDir}`);
  copyRuntimeDlls(ffmpegDir);

  const smoke = probeNvencSmoke(ffmpegExe);
  // 安装成功即返回：冒烟失败（尤其驱动 API）不应阻断 pack:win / bootstrap
  logSmokeResult(ffmpegExe, smoke, "installed");

  try {
    await rm(extractRoot, { recursive: true, force: true });
    await rm(zipPath, { force: true });
  } catch {
    // 非关键清理
  }

  return { ffmpegPath: ffmpegExe, ffprobePath: ffprobeExe, installed: true };
}

async function main() {
  const { installDir, force } = parseArgs(process.argv);
  await ensureWindowsFfmpeg({ installDir, force });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
