#!/usr/bin/env node
/**
 * 下载 Windows 内置运行时：Node.js LTS + Python embeddable
 * 在 pack:win 或 Windows bootstrap 时执行
 */
import { mkdir, writeFile, access, readFile, copyFile, chmod } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enginesDir = join(root, "engines");
const nodeDir = join(enginesDir, "node");
const pythonDir = join(enginesDir, "python");
const vcRuntimeDir = join(enginesDir, "funasr", "runtime");

const NODE_VERSION = "v20.18.1";
const PYTHON_VERSION = "3.11.9";
const PYTHON_PTH_NAME = `python${PYTHON_VERSION.split(".").slice(0, 2).join("")}._pth`;
const VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
}

async function ensureNode() {
  const nodeExe = join(nodeDir, "node.exe");
  if (existsSync(nodeExe)) {
    console.log(`[runtimes] node ready: ${nodeExe}`);
    return;
  }

  const zipPath = join(enginesDir, "node-win-x64.zip");
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
  console.log(`[runtimes] downloading Node ${NODE_VERSION}...`);
  await download(url, zipPath);

  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${enginesDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
    const extracted = join(enginesDir, `node-${NODE_VERSION}-win-x64`);
    execSync(`xcopy /E /I /Y "${extracted}\\*" "${nodeDir}\\"`, { stdio: "inherit", shell: true });
  } else {
    execSync(`unzip -qo "${zipPath}" -d "${enginesDir}"`, { stdio: "inherit" });
    const extracted = join(enginesDir, `node-${NODE_VERSION}-win-x64`);
    await mkdir(nodeDir, { recursive: true });
    execSync(`cp -R "${extracted}/"* "${nodeDir}/"`, { stdio: "inherit", shell: true });
  }

  console.log(`[runtimes] node installed: ${nodeExe}`);
}

async function configurePythonPth() {
  const pthFile = join(pythonDir, PYTHON_PTH_NAME);
  if (!existsSync(pthFile)) return;

  let content = await readFile(pthFile, "utf-8");
  content = content.replace("#import site", "import site");
  if (!content.includes("import site")) content += "\nimport site\n";
  if (!content.includes("Lib\\site-packages")) content += "Lib\\site-packages\n";
  await writeFile(pthFile, content);
}

async function ensurePythonEmbed() {
  const pythonExe = join(pythonDir, "python.exe");
  const virtualenvExe = join(pythonDir, "Scripts", "virtualenv.exe");
  if (existsSync(pythonExe) && existsSync(virtualenvExe)) {
    console.log(`[runtimes] python ready: ${pythonExe}`);
    return;
  }

  const zipPath = join(enginesDir, "python-embed.zip");
  const url = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  console.log(`[runtimes] downloading Python ${PYTHON_VERSION} embeddable...`);
  await download(url, zipPath);

  await mkdir(pythonDir, { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${pythonDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -qo "${zipPath}" -d "${pythonDir}"`, { stdio: "inherit" });
  }

  await configurePythonPth();

  const getPip = join(enginesDir, "get-pip.py");
  if (!existsSync(getPip)) {
    await download("https://bootstrap.pypa.io/get-pip.py", getPip);
  }

  if (process.platform === "win32") {
    const pipExe = join(pythonDir, "Scripts", "pip.exe");
    if (!existsSync(pipExe)) {
      execSync(`"${pythonExe}" "${getPip}"`, { stdio: "inherit" });
    }
    if (!existsSync(virtualenvExe)) {
      execSync(`"${pythonExe}" -m pip install virtualenv`, { stdio: "inherit" });
    }
  } else {
    console.log("[runtimes] python embed extracted (pip install runs on Windows target)");
  }

  console.log(`[runtimes] python installed: ${pythonExe}`);
}

async function ensureVcRuntime() {
  const vcRedistExe = join(vcRuntimeDir, "vc_redist.x64.exe");
  if (existsSync(vcRedistExe)) {
    console.log(`[runtimes] vc_redist ready: ${vcRedistExe}`);
    return vcRedistExe;
  }

  console.log("[runtimes] downloading VC++ Redistributable x64...");
  await mkdir(vcRuntimeDir, { recursive: true });
  await download(VC_REDIST_URL, vcRedistExe);
  console.log(`[runtimes] vc_redist downloaded: ${vcRedistExe}`);
  return vcRedistExe;
}

async function ensureCrtDlls() {
  // 旁路部署 torch/ffmpeg 所需的 VC++ CRT DLL，避免用户机未装 vc_redist 时直接失败
  const crtDir = join(vcRuntimeDir, "crt");
  const needed = [
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "concrt140.dll",
  ];
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sys32 = join(sysRoot, "System32");
  let copied = 0;
  let already = 0;
  await mkdir(crtDir, { recursive: true });
  for (const name of needed) {
    const src = join(sys32, name);
    const dest = join(crtDir, name);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      already++;
      continue;
    }
    await copyFile(src, dest);
    copied++;
  }
  console.log(`[runtimes] CRT DLLs: copied=${copied}, already=${already} at ${crtDir}`);
}

async function main() {
  if (process.platform !== "win32" && !process.env.CLIP_FORCE_WIN_RUNTIMES) {
    console.log("[runtimes] skip full runtime download on non-Windows (set CLIP_FORCE_WIN_RUNTIMES=1 to force)");
    await mkdir(nodeDir, { recursive: true });
    await mkdir(pythonDir, { recursive: true });
    await writeFile(
      join(nodeDir, "README.txt"),
      "Run pack:win on Windows to download node.exe, or set CLIP_FORCE_WIN_RUNTIMES=1\n",
    );
    return;
  }

  await mkdir(enginesDir, { recursive: true });
  await ensureNode();
  await ensurePythonEmbed();
  const vcRedistExe = await ensureVcRuntime();
  await ensureCrtDlls();
  const { ensureWindowsFfmpeg } = await import("./ensure-ffmpeg-windows.mjs");
  await ensureWindowsFfmpeg({ installDir: root });
  console.log(`[runtimes] Windows runtimes ready (vc_redist=${vcRedistExe})`);
}

main().catch((err) => {
  console.error("[runtimes] failed:", err);
  process.exit(1);
});
