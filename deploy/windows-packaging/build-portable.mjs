#!/usr/bin/env node
/**
 * drama-clip绿色免安装包：任意路径解压即可用（模型首启联网下载）
 *
 * 用法:
 *   npm run pack:portable
 *   CLIP_PORTABLE_SOURCE=D:\ClipAgent npm run pack:portable
 *
 * 产出:
 *   deploy/windows-packaging/output/ClipAgent-portable-{version}-x64.zip
 */
import { cp, mkdir, writeFile, copyFile, readFile, rm, access } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packagingDir = join(root, "deploy/windows-packaging");
const out = join(packagingDir, "output");
const portableDir = join(out, "ClipAgent.portable");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf-8")).version || "0.3.0";
const configDefaults = JSON.parse(
  await readFile(join(packagingDir, "config.defaults.json"), "utf-8"),
);

async function pathOk(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isValidInstallRoot(dir) {
  return (
    existsSync(join(dir, "clip-agent", "dist", "cli.js")) &&
    (existsSync(join(dir, "engines", "node", "node.exe")) ||
      existsSync(join(dir, "engines", "funasr", "venv", "Scripts", "python.exe")))
  );
}

function resolveSourceDir() {
  const fromEnv = process.env.CLIP_PORTABLE_SOURCE?.trim();
  if (fromEnv && isValidInstallRoot(fromEnv)) {
    return fromEnv;
  }
  const candidates = [
    join(out, "ClipAgent.build"),
    join(out, "ClipAgent"),
    "D:\\ClipAgent",
  ];
  for (const c of candidates) {
    if (isValidInstallRoot(c)) return c;
  }
  return null;
}

async function ensureDesktopExe(destRoot) {
  const candidates = [
    join(root, "apps/clip-agent-desktop/src-tauri/target/release/clip-agent-desktop.exe"),
    join(root, "apps/clip-agent-desktop/src-tauri/target/release/ClipAgent.exe"),
    join(destRoot, "clip-agent-desktop.exe"),
  ];
  let src = candidates.find((p) => existsSync(p));
  if (!src || src === join(destRoot, "clip-agent-desktop.exe")) {
    if (!existsSync(join(destRoot, "clip-agent-desktop.exe"))) {
      console.log("[portable] building clip-agent-desktop...");
      try {
        execSync("npm run build -w @clip/clip-agent-desktop", { cwd: root, stdio: "inherit" });
      } catch (err) {
        console.warn("[portable] tauri MSI may fail; checking release exe…", err?.message ?? err);
      }
      src = candidates.find((p) => existsSync(p) && !p.endsWith(`${destRoot}\\clip-agent-desktop.exe`));
      if (!src) {
        src = join(root, "apps/clip-agent-desktop/src-tauri/target/release/clip-agent-desktop.exe");
      }
    } else {
      return;
    }
  }
  if (!existsSync(src)) {
    throw new Error("[portable] missing clip-agent-desktop.exe — build desktop first");
  }
  await copyFile(src, join(destRoot, "clip-agent-desktop.exe"));
  console.log(`[portable] desktop exe ← ${src}`);
}

async function ensureScripts(destRoot) {
  const scripts = [
    "setup-funasr-bundled.ps1",
    "activate-funasr-engine.ps1",
    "repair-funasr-venv.ps1",
    "repair-funasr-sentencepiece.ps1",
    "ensure-ffmpeg-windows.mjs",
  ];
  await mkdir(join(destRoot, "scripts"), { recursive: true });
  for (const name of scripts) {
    const from = join(root, "scripts", name);
    const to = join(destRoot, "scripts", name);
    if (existsSync(from)) {
      await copyFile(from, to);
    }
  }
}

/** 绿色包内预置 sentencepiece 离线 wheel + CRT + VC 红装，避免目标机 import AV */
async function ensureSentencepieceRuntime(destRoot) {
  const packWheels = join(packagingDir, "wheels");
  const packRedist = join(packagingDir, "redist");
  const destWheels = join(destRoot, "engines/funasr/wheels");
  const destCrt = join(destRoot, "engines/funasr/runtime/crt");
  const destRuntime = join(destRoot, "engines/funasr/runtime");
  await mkdir(destWheels, { recursive: true });
  await mkdir(destCrt, { recursive: true });

  for (const name of [
    "sentencepiece-0.1.99-cp311-cp311-win_amd64.whl",
    "sentencepiece-0.2.2-cp311-cp311-win_amd64.whl",
  ]) {
    const from = join(packWheels, name);
    if (existsSync(from)) {
      await copyFile(from, join(destWheels, name));
    }
  }

  const crtSrc = join(packRedist, "crt-x64");
  if (existsSync(crtSrc)) {
    await cp(crtSrc, destCrt, { recursive: true, dereference: true });
  }
  const vc = join(packRedist, "vc_redist.x64.exe");
  if (existsSync(vc)) {
    await copyFile(vc, join(destRuntime, "vc_redist.x64.exe"));
  }

  // 旁路 CRT 到 python / Scripts，降低目标机缺 MSVCP140 概率
  const crtFiles = [
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "concrt140.dll",
  ];
  const targets = [
    join(destRoot, "engines/python"),
    join(destRoot, "engines/funasr/venv/Scripts"),
  ];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    for (const dll of crtFiles) {
      const from = join(destCrt, dll);
      if (existsSync(from)) {
        try {
          await copyFile(from, join(t, dll));
        } catch {
          /* locked / same file */
        }
      }
    }
  }
  console.log("[portable] sentencepiece wheels + CRT + vc_redist staged");
}


async function writePortableExtras(destRoot) {
  await writeFile(join(destRoot, "portable.flag"), "clip-portable=1\n", "utf-8");
  await mkdir(join(destRoot, "data", "models"), { recursive: true });
  await mkdir(join(destRoot, "data", "logs"), { recursive: true });
  await writeFile(join(destRoot, "data", "models", ".gitkeep"), "", "utf-8");

  const bat = [
    "@echo off",
    "chcp 65001 >nul",
    "cd /d \"%~dp0\"",
    "start \"\" \"%~dp0clip-agent-desktop.exe\"",
    "",
  ].join("\r\n");
  await writeFile(join(destRoot, "启动drama-clip.bat"), bat, "utf-8");

  const readme = [
    "drama-clip・绿色免安装版",
    "================",
    "",
    "1. 解压到任意目录（例如 D:\\ClipAgent 或 D:\\Weijing；路径请尽量用英文，避免纯中文目录名）",
    "2. 双击「启动drama-clip.bat」或 clip-agent-desktop.exe",
    "3. 首次启动会自动激活本机 FunASR 路径（无需安装）",
    "4. ASR 模型约 1–2GB，首次使用时联网下载到本目录 data\\models",
    "",
    "系统要求：Windows 11、NVIDIA RTX（建议 4060 8GB）、驱动 ≥ 522",
    `API：${configDefaults.apiBase}`,
    `版本：${version}`,
    "",
    "不要删除 portable.flag。换文件夹后再次启动会自动重写 Python 虚拟环境路径。",
    "",
  ].join("\r\n");
  await writeFile(join(destRoot, "使用说明.txt"), readme, "utf-8");

  // 便携包内 config 使用云端默认；若源目录是本机 127.0.0.1 则覆盖
  const cfgPath = join(destRoot, "config.json");
  let apiBase = configDefaults.apiBase;
  if (existsSync(cfgPath)) {
    try {
      const cur = JSON.parse(await readFile(cfgPath, "utf-8"));
      if (cur.apiBase && !/127\.0\.0\.1|localhost/i.test(String(cur.apiBase))) {
        apiBase = cur.apiBase;
      }
    } catch {
      /* keep default */
    }
  }
  await writeFile(
    cfgPath,
    JSON.stringify({ ...configDefaults, apiBase }, null, 2) + "\n",
    "utf-8",
  );
}

async function pruneUserData(destRoot) {
  // 勿打进打包机用户模型 / 凭证 / 锁
  for (const rel of [
    "data/models",
    "data/credentials.json",
    "data/agent.lock",
    "data/workspace",
    "data/logs",
  ]) {
    const p = join(destRoot, rel);
    if (existsSync(p)) {
      await rm(p, { recursive: true, force: true });
    }
  }
  await mkdir(join(destRoot, "data", "models"), { recursive: true });
  await mkdir(join(destRoot, "data", "logs"), { recursive: true });
}

function zipDir(sourceDir, zipPath) {
  if (existsSync(zipPath)) {
    try {
      execSync(`del /f /q "${zipPath}"`, { stdio: "ignore", shell: true });
    } catch {
      /* ignore */
    }
  }
  // Windows 自带 tar 支持 zip
  const tar = spawnSync(
    "tar",
    ["-a", "-cf", zipPath, "-C", sourceDir, "."],
    { stdio: "inherit", shell: false },
  );
  if (tar.status === 0 && existsSync(zipPath)) {
    return;
  }
  console.warn("[portable] tar zip failed, fallback Compress-Archive…");
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" },
  );
}

/**
 * 绿色包只需要这些顶层目录/文件。其余如 deploy/apps/packages/skills
 * 等仓库或打包机相关目录必须排除，防止递归套娃导致体积极速膨胀。
 */
const PORTABLE_ROOT_WHITELIST = [
  "clip-agent",
  "engines",
  "node_modules",
  "assets",
  "scripts",
  "data",
  "config.json",
  "clip-agent-desktop.exe",
];

/**
 * 即使白名单目录内部，也可能混入打包输出或运行时缓存，需要额外清理。
 */
const PORTABLE_PRUNE_PATHS = [
  // 用户数据
  "data/models",
  "data/credentials.json",
  "data/agent.lock",
  "data/workspace",
  "data/logs",
  "data/recordings",
  "data/temp",
  "data/cache",
  // 打包/开发产物（可能因误拷贝进入 engines 或 clip-agent）
  "engines/funasr/models.bak",
  "engines/funasr/.cache",
  "engines/funasr/venv/.cache",
  "engines/funasr/venv/Lib/site-packages/__pycache__",
  "clip-agent/.cache",
  "node_modules/.cache",
  // 旧的套娃产物
  "deploy/windows-packaging/output",
];

async function copyWhitelist(source, dest) {
  await mkdir(dest, { recursive: true });
  for (const name of PORTABLE_ROOT_WHITELIST) {
    const from = join(source, name);
    const to = join(dest, name);
    if (!existsSync(from)) continue;
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, dereference: true });
    console.log(`[portable] copied ${name}`);
  }
}

/**
 * 校验包内 clip-agent/dist 对 @clip/agent-core 的具名导入在包内 agent-core 中真实导出。
 * ESM 导入是加载期静态校验，缺一个导出目标机 daemon 就起不来。
 */
async function assertRuntimeExportsConsistent(portableRoot) {
  const pipelineJs = join(portableRoot, "clip-agent/dist/pipeline.js");
  const coreIndexJs = join(portableRoot, "node_modules/@clip/agent-core/dist/index.js");
  if (!existsSync(pipelineJs) || !existsSync(coreIndexJs)) return;

  const pipeline = await readFile(pipelineJs, "utf-8");
  const m = pipeline.match(/import\s*\{([^}]*)\}\s*from\s*"@clip\/agent-core"/);
  if (!m) return;
  const wanted = m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter((s) => s && !s.startsWith("type "));

  const core = await readFile(coreIndexJs, "utf-8");
  // 收集 agent-core 的实际导出名（export { a, b as c } / export const …）
  const exported = new Set();
  for (const em of core.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (let name of em[1].split(",")) {
      name = name.trim();
      if (!name) continue;
      const asMatch = name.match(/^[\w$]+\s+as\s+([\w$]+)$/);
      exported.add(asMatch ? asMatch[1] : name.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const dm of core.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([\w$]+)/g)) {
    exported.add(dm[1]);
  }

  const missing = wanted.filter((name) => !exported.has(name));
  if (missing.length) {
    throw new Error(
      `[portable] 打包自检失败：包内 agent-core 缺少导出 ${JSON.stringify(missing)}（pipeline 与 @clip/agent-core 版本不一致）`,
    );
  }
  console.log(`[portable] runtime exports self-check ok (${wanted.length} imports)`);
}

async function main() {
  console.log("[portable] building green zip…");
  const source = resolveSourceDir();
  if (!source) {
    throw new Error(
      "[portable] 找不到可用安装源。请先 npm run pack:win，或设置 CLIP_PORTABLE_SOURCE=已含 engines 的目录",
    );
  }
  console.log(`[portable] source: ${source}`);

  if (existsSync(portableDir)) {
    console.log("[portable] cleaning previous ClipAgent.portable…");
    await rm(portableDir, { recursive: true, force: true });
  }
  await mkdir(out, { recursive: true });

  console.log(`[portable] copying whitelist → ${portableDir} (可能需数分钟)…`);
  await copyWhitelist(source, portableDir);

  // 同步最新 agent / funasr 脚本与 dist（若仓库已 build）
  for (const [fromRel, toRel] of [
    ["apps/clip-agent/dist", "clip-agent/dist"],
    ["apps/clip-agent/package.json", "clip-agent/package.json"],
    ["apps/funasr-server/dist", "engines/funasr/dist"],
    ["apps/funasr-server/package.json", "engines/funasr/package.json"],
    ["apps/funasr-server/python", "engines/funasr/python"],
    // 关键：@clip 运行时包必须与 clip-agent/dist 同版本，
    // 否则会出现新 pipeline.js import 旧 agent-core 导出的 ESM 崩溃
    ["packages/agent-core/dist", "node_modules/@clip/agent-core/dist"],
    ["packages/sdk/dist", "node_modules/@clip/sdk/dist"],
    ["packages/clip-schema/dist", "node_modules/@clip/clip-schema/dist"],
    ["packages/ffmpeg-templates/dist", "node_modules/@clip/ffmpeg-templates/dist"],
  ]) {
    const from = join(root, fromRel);
    const to = join(portableDir, toRel);
    if (existsSync(from)) {
      await mkdir(dirname(to), { recursive: true });
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true, dereference: true });
    }
  }

  await ensureScripts(portableDir);
  await ensureSentencepieceRuntime(portableDir);
  await ensureDesktopExe(portableDir);
  await pruneUserData(portableDir);
  await writePortableExtras(portableDir);

  // 二次清理可能从 source 带进来的缓存/旧产物
  for (const rel of PORTABLE_PRUNE_PATHS) {
    const p = join(portableDir, rel);
    if (existsSync(p)) {
      await rm(p, { recursive: true, force: true });
      console.log(`[portable] pruned ${rel}`);
    }
  }

  // 删除打包机绝对路径标记，强制目标机首次 activate 改写 pyvenv.cfg
  const marker = join(portableDir, "engines/funasr/venv/.clip-ready");
  if (existsSync(marker)) {
    await rm(marker, { force: true });
    console.log("[portable] cleared .clip-ready (target will re-activate)");
  }

  // 出包自检：clip-agent 引用的 @clip/agent-core 具名导出必须真实存在，
  // 防止「新 pipeline + 旧 agent-core」的 ESM 崩溃包流出
  await assertRuntimeExportsConsistent(portableDir);

  const zipName = `ClipAgent-portable-${version}-x64.zip`;
  const zipPath = join(out, zipName);
  console.log(`[portable] zipping ${zipName}…`);
  zipDir(portableDir, zipPath);

  const size = existsSync(zipPath) ? statSync(zipPath).size : 0;
  console.log(
    JSON.stringify(
      {
        version,
        source,
        portableDir,
        zipPath,
        sizeBytes: size,
        sizeGB: Number((size / 1e9).toFixed(2)),
      },
      null,
      2,
    ),
  );
  console.log("[portable] done. 解压到任意目录后双击「启动drama-clip.bat」");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
