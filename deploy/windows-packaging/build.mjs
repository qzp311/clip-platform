#!/usr/bin/env node
/**
 * Windows 一键安装包构建
 * 支持任意 Windows 10/11 x64 电脑：
 *   - 有 NVIDIA 显卡 → 走 funasr-gpu / NVENC
 *   - 无 NVIDIA 显卡 → 走 funasr-cpu / libx264（AMF/QSV 亦会自动探测）
 */
import { cp, mkdir, writeFile, copyFile, readFile, rm, rename, readdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packagingDir = join(root, "deploy/windows-packaging");
const out = join(packagingDir, "output");
/** 使用短路径构建目录，避免 funasr venv 中 site-packages 长路径超过 Windows MAX_PATH 限制 */
function resolveShortBuildRoot() {
  const candidates = [
    "D:\\ClipAgent.build",
    "C:\\ClipAgent.build",
  ];
  for (const root of candidates) {
    try {
      mkdirSync(root, { recursive: true });
      return root;
    } catch {
      /* 无权限或磁盘不存在，尝试下一个 */
    }
  }
  return join(out, "ClipAgent.build");
}
const buildRoot = resolveShortBuildRoot();
const agentDir = join(buildRoot, "build");
const agentDirLegacy = join(out, "ClipAgent");
const configDefaults = JSON.parse(
  await readFile(join(packagingDir, "config.defaults.json"), "utf-8"),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBusyError(err) {
  return err && typeof err === "object" && "code" in err && err.code === "EBUSY";
}

/** 尽力删除目录；失败时不抛错（用于非关键清理） */
async function removeDirBestEffort(target, label = basename(target)) {
  if (!existsSync(target)) return false;

  const retries = process.platform === "win32" ? 5 : 2;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      return true;
    } catch (err) {
      if (!isBusyError(err) || attempt === retries) break;
      console.warn(`[win-pack] ${label} locked, retry ${attempt}/${retries}...`);
      await sleep(300 * attempt);
    }
  }

  if (process.platform === "win32") {
    const stale = `${target}.stale.${Date.now()}`;
    try {
      await rename(target, stale);
      console.warn(`[win-pack] ${label} in use — renamed to ${basename(stale)}`);
      try {
        await rm(stale, { recursive: true, force: true });
      } catch {
        console.warn(`[win-pack] delete later: ${stale}`);
      }
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 仅清理本次构建目录；不触碰可能被 Agent 占用的 output/ClipAgent */
async function prepareBuildOutput() {
  await mkdir(out, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  const removed = await removeDirBestEffort(agentDir, "build");
  if (!removed && existsSync(agentDir)) {
    const fallback = join(buildRoot, `build.${process.pid}`);
    console.warn(`[win-pack] build locked — using ${basename(fallback)}`);
    await mkdir(fallback, { recursive: true });
    return fallback;
  }
  await mkdir(agentDir, { recursive: true });
  return agentDir;
}

/** 构建成功后尽力同步到 output/ClipAgent（非必须，失败不影响安装包） */
async function publishLegacyAgentDir(buildDir) {
  if (existsSync(agentDirLegacy)) {
    const cleared = await removeDirBestEffort(agentDirLegacy, "ClipAgent");
    if (!cleared && existsSync(agentDirLegacy)) {
      console.warn(
        "[win-pack] skip syncing output/ClipAgent (directory in use). " +
          "Installer already built from ClipAgent.build.",
      );
      return;
    }
  }

  try {
    await rename(buildDir, agentDirLegacy);
    console.log("[win-pack] published output/ClipAgent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[win-pack] could not rename build → ClipAgent: ${msg}`);
  }
}

function issSourceDirDefine(buildDir) {
  const rel = relative(packagingDir, buildDir).replace(/\//g, "\\");
  return rel || "output\\ClipAgent.build";
}

/** Runtime @clip/* packages required by clip-agent (from copied packages/) */
const CLIP_RUNTIME_PACKAGES = ["agent-core", "sdk", "clip-schema", "ffmpeg-templates"];

async function materializeClipRuntimePackages(targetDir) {
  const nmClip = join(targetDir, "node_modules/@clip");
  await mkdir(nmClip, { recursive: true });

  for (const name of CLIP_RUNTIME_PACKAGES) {
    const src = join(targetDir, "packages", name);
    const dest = join(nmClip, name);
    if (!existsSync(src)) {
      console.warn(`[win-pack] skip clip runtime package missing: packages/${name}`);
      continue;
    }
    if (existsSync(dest)) {
      await removeDirBestEffort(dest, `@clip/${name}`);
    }
    await cp(src, dest, { recursive: true, dereference: true });
    console.log(`[win-pack] linked @clip/${name} for runtime`);
  }
}

/**
 * 递归复制 clip-agent 运行时真正需要的第三方 npm 包。
 * 根 node_modules 有 ~480MB（含大量 dev 依赖），全部打进安装包会导致 ISCC 卡死，
 * 因此只按需复制 clip-agent/package.json 依赖树中的包。
 */
async function copyRuntimeDependencies(targetDir) {
  const nmRoot = join(root, "node_modules");
  const nmTarget = join(targetDir, "node_modules");
  const seen = new Set();
  let copied = 0;

  async function copyPackage(name) {
    if (name.startsWith("@clip/")) return; // @clip/* 已由 materializeClipRuntimePackages 处理
    if (seen.has(name)) return;
    seen.add(name);

    const src = join(nmRoot, name);
    if (!existsSync(src)) return; // peer/optional 缺失不影响

    const dest = join(nmTarget, name);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, dereference: true });
    copied++;

    const pkgJsonPath = join(src, "package.json");
    if (!existsSync(pkgJsonPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
    } catch {
      return;
    }
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const depName of Object.keys(deps)) {
      await copyPackage(depName);
    }
  }

  const agentPkgPath = join(root, "apps/clip-agent/package.json");
  const agentPkg = JSON.parse(await readFile(agentPkgPath, "utf-8"));
  for (const depName of Object.keys(agentPkg.dependencies ?? {})) {
    await copyPackage(depName);
  }

  // 额外：@clip/sdk 本身引用了外部依赖，需要递归
  for (const name of CLIP_RUNTIME_PACKAGES) {
    const pkgPath = join(root, `packages/${name}/package.json`);
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    for (const depName of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      await copyPackage(depName);
    }
  }

  console.log(`[win-pack] copied ${copied} runtime dependency packages into node_modules`);
}

/** 检测是否有 NVIDIA GPU（CUDA），用于决定预装 PyTorch 版本 */
function hasNvidiaGpu() {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync("nvidia-smi -L", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/GPU/i.test(out)) return true;
  } catch {
    /* ignore */
  }
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    if (/nvidia/i.test(out)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function main() {
  console.log("[win-pack] syncing dependencies...");
  execSync("npm install", { cwd: root, stdio: "inherit" });
  console.log("[win-pack] building monorepo...");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
  execSync("node scripts/bootstrap.mjs", { cwd: root, stdio: "inherit" });
  execSync("node scripts/download-asr-models.mjs", { cwd: root, stdio: "inherit" });

  if (process.platform === "win32") {
    execSync("node scripts/download-windows-runtimes.mjs", {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CLIP_FORCE_WIN_RUNTIMES: "1" },
    });
  } else {
    console.log("[win-pack] hint: run on Windows to bundle node.exe + python.exe into installer");
  }

  const buildDir = await prepareBuildOutput();
  console.log(`[win-pack] staging into ${buildDir}`);

  const copies = [
    ["apps/clip-agent/dist", "clip-agent/dist"],
    ["apps/clip-agent/package.json", "clip-agent/package.json"],
    ["apps/funasr-server/dist", "engines/funasr/dist"],
    ["apps/funasr-server/package.json", "engines/funasr/package.json"],
    ["apps/funasr-server/python", "engines/funasr/python"],
    ["packages", "packages"],
    ["engines/ffmpeg", "engines/ffmpeg"],
    ["engines/funasr/funasr-server.cmd", "engines/funasr/funasr-server.cmd"],
    ["data/cdn/models", "data/cdn/models"],
    ["scripts/setup-funasr-bundled.ps1", "scripts/setup-funasr-bundled.ps1"],
    ["scripts/activate-funasr-engine.ps1", "scripts/activate-funasr-engine.ps1"],
    ["scripts/repair-funasr-venv.ps1", "scripts/repair-funasr-venv.ps1"],
    ["scripts/repair-funasr-sentencepiece.ps1", "scripts/repair-funasr-sentencepiece.ps1"],
    ["scripts/ensure-ffmpeg-windows.mjs", "scripts/ensure-ffmpeg-windows.mjs"],
    ["apps/clip-agent-desktop/src-tauri/icons", "clip-agent-desktop/icons"],
    ["deploy/windows-packaging/config.defaults.json", "config.json"],
  ];

  // 只复制 node.exe，自带的 npm node_modules 文件极多且 clip-agent 用不到，会导致打包卡死
  if (existsSync(join(root, "engines/node/node.exe"))) {
    copies.push(["engines/node/node.exe", "engines/node/node.exe"]);
  }
  if (existsSync(join(root, "engines/python"))) {
    copies.push(["engines/python", "engines/python"]);
  }
  // 2026-08 策略：打包机预构建 venv 并封进安装包，用户端只做离线激活。
  // 若 venv 不存在，安装向导会走 setup-funasr-bundled.ps1 联网兜底。
  if (existsSync(join(root, "engines/funasr/venv"))) {
    copies.push(["engines/funasr/venv", "engines/funasr/venv"]);
  }
  if (existsSync(join(root, "engines/funasr/wheels"))) {
    copies.push(["engines/funasr/wheels", "engines/funasr/wheels"]);
  }
  if (existsSync(join(root, "engines/funasr/runtime"))) {
    copies.push(["engines/funasr/runtime", "engines/funasr/runtime"]);
  }

  for (const [src, dest] of copies) {
    const from = join(root, src);
    const to = join(buildDir, dest);
    if (!existsSync(from)) {
      console.warn(`[win-pack] skip missing: ${src}`);
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, dereference: true });
  }

  const setupScriptDest = join(buildDir, "scripts", "setup-funasr-bundled.ps1");
  if (!existsSync(setupScriptDest)) {
    const setupScriptSrc = join(root, "scripts", "setup-funasr-bundled.ps1");
    if (!existsSync(setupScriptSrc)) {
      throw new Error("[win-pack] missing scripts/setup-funasr-bundled.ps1 in repo");
    }
    await mkdir(dirname(setupScriptDest), { recursive: true });
    await copyFile(setupScriptSrc, setupScriptDest);
    console.log("[win-pack] ensured scripts/setup-funasr-bundled.ps1");
  }

  // 不再复制整个根 node_modules，只按需复制 clip-agent 运行时依赖
  await materializeClipRuntimePackages(buildDir);
  await copyRuntimeDependencies(buildDir);

  const undiciDir = join(buildDir, "node_modules/undici");
  if (existsSync(undiciDir)) {
    console.log("[win-pack] pruning node_modules/undici (clip-agent uses Node built-in fetch)...");
    await removeDirBestEffort(undiciDir, "node_modules/undici");
  }

  const hasNvidia = hasNvidiaGpu();
  const asrBackend = hasNvidia ? "funasr-gpu" : "funasr-cpu";
  const asrDevice = hasNvidia ? "cuda:0" : "cpu";
  console.log(`[win-pack] build machine GPU=${hasNvidia ? "NVIDIA" : "CPU/Other"}, backend=${asrBackend}, device=${asrDevice}`);

  await writeFile(
    join(buildDir, "clip-agent.cmd"),
    [
      "@echo off",
      "set CLIP_REPO_ROOT=%~dp0",
      "set CLIP_INSTALL_DIR=%~dp0",
      `set CLIP_ASR_BACKEND=${asrBackend}`,
      `set CLIP_ASR_DEVICE=${asrDevice}`,
      "set CLIP_API_BASE=" + configDefaults.apiBase,
      'if exist "%CLIP_REPO_ROOT%engines\\funasr\\venv\\Scripts\\python.exe" set "CLIP_PYTHON=%CLIP_REPO_ROOT%engines\\funasr\\venv\\Scripts\\python.exe"',
      'set "CLIP_FUNASR_MODELS_DIR=%LOCALAPPDATA%\\ClipAgent\\models"',
      'set "PATH=%CLIP_REPO_ROOT%engines\\node;%PATH%"',
      '"%CLIP_REPO_ROOT%engines\\node\\node.exe" "%CLIP_REPO_ROOT%clip-agent\\dist\\cli.js" %*',
      "",
    ].join("\r\n"),
  );

  const funasrMarker = join(buildDir, "engines/funasr/venv/.clip-ready");
  const prebuild = process.env.CLIP_PREBUILD_FUNASR_VENV !== "0"; // 默认预构建
  if (
    prebuild &&
    process.platform === "win32" &&
    existsSync(join(buildDir, "engines", "python", "python.exe"))
  ) {
    if (existsSync(funasrMarker)) {
      console.log("[win-pack] FunASR venv already built — bundling into installer");
    } else {
      console.log("[win-pack] pre-building FunASR venv into installer (needs network on pack machine, ~3-8 min)...");
      const prebuildScript = join(root, "scripts", "prebuild-funasr-venv.ps1");
      try {
        execSync(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${prebuildScript}" -InstallDir "${buildDir}"`,
          { stdio: "inherit" },
        );
        if (existsSync(funasrMarker)) {
          console.log("[win-pack] FunASR venv ready — will ship inside installer (one-click for end users)");
        } else {
          console.warn("[win-pack] FunASR venv pre-build finished but marker missing — install wizard will retry");
        }
      } catch (err) {
        console.warn(
          "[win-pack] venv pre-build failed; installer will run setup on user machine:",
          err.message ?? err,
        );
      }
    }
  } else if (process.platform !== "win32") {
    console.log("[win-pack] non-Windows pack — FunASR venv must be built on Windows target or during install");
  } else if (!prebuild) {
    console.log("[win-pack] FunASR venv will be built on user machine during install (set CLIP_PREBUILD_FUNASR_VENV=1 to pre-build)");
  }

  if (process.platform === "win32") {
    // 用国内镜像下载 Tauri NSIS 工具链，避免 GitHub 超时
    const tauriEnv = {
      ...process.env,
      TAURI_BUNDLER_TOOLS_GITHUB_MIRROR: process.env.TAURI_BUNDLER_TOOLS_GITHUB_MIRROR || "https://ghfast.top/https://github.com",
    };
    try {
      console.log("[win-pack] building Tauri NSIS installer...");
      execSync("npm run build -w @clip/clip-agent-desktop", { cwd: root, stdio: "inherit", env: tauriEnv });
      const tauriOut = join(root, "apps/clip-agent-desktop/src-tauri/target/release/bundle/nsis");
      if (existsSync(tauriOut)) {
        for (const exe of (await readdir(tauriOut)).filter((f) => f.endsWith(".exe"))) {
          await copyFile(join(tauriOut, exe), join(out, exe));
          console.log(`[win-pack] NSIS installer: ${join(out, exe)}`);
        }
      }
    } catch (err) {
      console.warn("[win-pack] Tauri NSIS build skipped:", err.message ?? err);
    }

    const desktopExeCandidates = [
      join(root, "apps/clip-agent-desktop/src-tauri/target/release/clip-agent-desktop.exe"),
      join(root, "apps/clip-agent-desktop/src-tauri/target/release/ClipAgent.exe"),
    ];
    const desktopExe = desktopExeCandidates.find((p) => existsSync(p));
    if (!desktopExe) {
      throw new Error(
        "[win-pack] clip-agent-desktop.exe missing — run: npm run build -w @clip/clip-agent-desktop",
      );
    }
    await copyFile(desktopExe, join(buildDir, "clip-agent-desktop.exe"));
    console.log(`[win-pack] staged clip-agent-desktop.exe from ${desktopExe}`);
  }

  const manifest = {
    version: "0.3.0",
    apiBase: configDefaults.apiBase,
    platform: configDefaults.platform,
    gpu: "auto-detect",
    minOs: "Windows 10 64-bit 或更高版本",
    asrBackend: configDefaults.asrBackend,
    entry: "clip-agent-desktop.exe",
    oneClick: true,
  };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

  const issSourceDir = issSourceDirDefine(buildDir);
  console.log(`[win-pack] artifacts staged: ${buildDir}`);

  if (process.platform === "win32") {
    const isccCandidates = [
      "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
      "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    ];
    const iscc = isccCandidates.find((p) => existsSync(p));
    if (iscc) {
      const outExe = join(out, "ClipAgent-0.3.0-x64.exe");
      // 使用临时输出文件名，避免旧安装包被 Windows Defender/杀毒软件扫描锁死导致 ISCC 报错 32
      const tmpExeName = `ClipAgent-0.3.0-x64-build-${Date.now()}`;
      const tmpExe = join(out, `${tmpExeName}.exe`);

      // 若旧安装包被占用，先尝试删除；失败则重命名备份
      if (existsSync(outExe)) {
        try {
          await rm(outExe, { force: true });
          console.log(`[win-pack] removed old installer: ${outExe}`);
        } catch (err) {
          const stale = `${outExe}.old.${Date.now()}`;
          try {
            await rename(outExe, stale);
            console.warn(`[win-pack] old installer locked — renamed to ${stale}`);
          } catch (renameErr) {
            console.warn(`[win-pack] could not remove/rename old installer: ${renameErr.message ?? renameErr}`);
          }
        }
      }

      console.log(`[win-pack] compiling Inno Setup (SourceDir=${issSourceDir}, tmp=${tmpExeName})...`);
      // 使用绝对路径；用 spawnSync 数组参数避免空格/引号解析问题
      const absSourceDir = join(packagingDir, issSourceDir).replace(/\//g, "\\");
      const absOutputDir = out.replace(/\//g, "\\");
      await mkdir(absOutputDir, { recursive: true });
      const isccResult = spawnSync(
        iscc,
        [
          `/DClipAgentSourceDir=${absSourceDir}`,
          `/DMyOutputBaseFilename=${tmpExeName}`,
          `/DMyOutputDir=${absOutputDir}`,
          "ClipAgent.iss",
        ],
        { cwd: packagingDir, stdio: "inherit", shell: false },
      );
      if (isccResult.status !== 0) {
        throw new Error(`Inno Setup compile failed with code ${isccResult.status ?? isccResult.signal ?? "unknown"}`);
      }

      if (existsSync(tmpExe)) {
        // 编译成功后再重命名为标准文件名；若标准名仍被锁，保留临时文件并提示
        try {
          if (existsSync(outExe)) {
            await rm(outExe, { force: true });
          }
          await rename(tmpExe, outExe);
          console.log(`[win-pack] installer: ${outExe}`);
        } catch (err) {
          console.warn(`[win-pack] could not rename ${tmpExe} → ${outExe}: ${err.message ?? err}`);
          console.log(`[win-pack] installer available at: ${tmpExe}`);
        }
      }
    } else {
      console.log("[win-pack] Inno Setup not found — compile ClipAgent.iss manually");
      console.log(`[win-pack] use: ISCC.exe /DClipAgentSourceDir=${issSourceDir} ClipAgent.iss`);
    }
  } else {
    console.log("[win-pack] compile ClipAgent.iss with Inno Setup → ClipAgent-0.3.0-x64.exe");
  }

  await publishLegacyAgentDir(buildDir);
  console.log(`[win-pack] done: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
