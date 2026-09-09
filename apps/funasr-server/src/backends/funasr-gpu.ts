import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { RawAsrSegment } from "@clip/sdk";
import { logSidecarOutput, findFatalSidecarErrorInChunk } from "../sidecar-log.js";

const pythonScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../python/funasr_gpu_server.py",
);

let gpuProcess: ChildProcess | null = null;
let gpuStartupPromise: Promise<string> | null = null;
let gpuFatalError: string | null = null;
let lastExitCode: number | null = null;
let lastOutLog: string | null = null;
let lastErrLog: string | null = null;
let lastPythonPid: number | null = null;

export function getGpuFatalError(): string | null {
  return gpuFatalError;
}

const DEFAULT_STARTUP_TIMEOUT_MS = Number(process.env.CLIP_FUNASR_STARTUP_TIMEOUT_MS ?? 900_000);

/** 检测本机是否有可用的 NVIDIA GPU（CUDA），用于启动前选择 device */
function hasNvidiaGpu(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8", timeout: 5000 });
    if (result.status === 0 && result.stdout?.toLowerCase().includes("gpu")) return true;
  } catch {
    /* ignore */
  }
  try {
    const ps = resolvePowerShellExe();
    const result = spawnSync(
      ps,
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status === 0 && result.stdout?.toLowerCase().includes("nvidia")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function resolveAsrDevice(requested?: string): string {
  if (requested && requested !== "auto") return requested;
  const envDevice = process.env.CLIP_ASR_DEVICE?.trim();
  if (envDevice && envDevice !== "auto") return envDevice;
  return hasNvidiaGpu() ? "cuda:0" : "cpu";
}

function isAccessViolationExit(code: number | null): boolean {
  if (code == null) return false;
  return code === 3221225477 || code === -1073741819;
}

function stripExtendedPath(p: string): string {
  return p.replace(/^\\\\\?\\/i, "").replace(/\//g, "\\");
}

function resolvePowerShellExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const p = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(p) ? p : "powershell.exe";
}

function escapePsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

function tailFile(path: string | null, maxChars = 1200): string {
  if (!path || !existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(Math.max(0, text.length - maxChars)).trim();
  } catch {
    return "";
  }
}

export interface FunasrGpuOptions {
  host?: string;
  port?: number;
  gpuPort?: number;
  device?: string;
  modelsDir?: string;
  pythonPath?: string;
  ffmpegPath?: string;
}

export async function ensureFunasrGpuServer(options: FunasrGpuOptions = {}): Promise<string> {
  if (gpuStartupPromise) return gpuStartupPromise;
  gpuStartupPromise = startFunasrGpuServer(options).finally(() => {
    gpuStartupPromise = null;
  });
  return gpuStartupPromise;
}

function collectTorchDllDirs(pythonPath: string): string[] {
  const dirs: string[] = [];
  const venvRoot = dirname(dirname(pythonPath));
  const site = join(venvRoot, "Lib", "site-packages");
  const torchLib = join(site, "torch", "lib");
  if (existsSync(torchLib)) dirs.push(torchLib);

  const nvidiaRoot = join(site, "nvidia");
  if (existsSync(nvidiaRoot)) {
    try {
      for (const name of readdirSync(nvidiaRoot)) {
        const base = join(nvidiaRoot, name);
        for (const sub of ["bin", "lib", join("lib", "x64")]) {
          const p = join(base, sub);
          if (existsSync(p)) dirs.push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const scripts = join(venvRoot, "Scripts");
  if (existsSync(scripts)) dirs.push(scripts);

  for (const key of ["CUDA_PATH", "CUDA_PATH_V12_1", "CUDA_PATH_V12_4", "CUDA_PATH_V11_8"]) {
    const root = process.env[key];
    if (root) {
      const bin = join(root, "bin");
      if (existsSync(bin)) dirs.push(bin);
    }
  }
  return dirs;
}

function buildPythonEnv(options: FunasrGpuOptions, pythonPath: string): NodeJS.ProcessEnv {
  const ffmpegPath =
    options.ffmpegPath?.trim() ||
    process.env.CLIP_FFMPEG_PATH?.trim() ||
    process.env.FFMPEG_PATH?.trim() ||
    "";
  const sep = process.platform === "win32" ? ";" : ":";
  // 注意：不要把 torch/nvidia 目录插到 PATH 最前——会令 sentencepiece.pyd 加载错误 DLL 而 AV。
  // torch DLL 改由 python 在 import sentencepiece 成功后再 add_dll_directory。
  const prepend: string[] = [];
  if (process.platform === "win32") {
    const winRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    for (const p of [
      join(winRoot, "System32"),
      join(winRoot, "SysWOW64"),
      join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
    ]) {
      if (existsSync(p)) prepend.push(p);
    }
    const scripts = join(dirname(dirname(pythonPath)), "Scripts");
    if (existsSync(scripts)) prepend.push(scripts);
  }
  if (ffmpegPath && existsSync(ffmpegPath)) {
    prepend.unshift(dirname(ffmpegPath));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    KMP_DUPLICATE_LIB_OK: "TRUE",
    CUDA_MODULE_LOADING: "LAZY",
    MODELSCOPE_ENDPOINT: process.env.MODELSCOPE_ENDPOINT || "https://www.modelscope.cn",
    MODELSCOPE_DOMAIN: process.env.MODELSCOPE_DOMAIN || "www.modelscope.cn",
    HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
  };

  for (const key of ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "PYTHONSTARTUP", "PYTHONUSERBASE"]) {
    delete env[key];
  }

  // 从继承的 PATH 里去掉 torch/nvidia，防止父进程已污染
  if (process.platform === "win32" && env.PATH) {
    env.PATH = env.PATH.split(sep)
      .filter((p) => {
        const low = p.toLowerCase().replace(/\//g, "\\");
        return !low.includes("\\torch\\") && !low.includes("\\nvidia\\") && !low.includes("site-packages\\torch");
      })
      .join(sep);
  }

  if (options.modelsDir) {
    env.MODELSCOPE_CACHE = stripExtendedPath(options.modelsDir);
  }
  if (prepend.length) {
    env.PATH = `${prepend.join(sep)}${sep}${env.PATH ?? ""}`;
  }
  if (ffmpegPath && existsSync(ffmpegPath)) {
    const ff = stripExtendedPath(ffmpegPath);
    env.FFMPEG_BINARY = ff;
    env.FFMPEG_PATH = ff;
    env.IMAGEIO_FFMPEG_EXE = ff;
  }
  return env;
}

/**
 * Windows：与 activate-funasr-engine.ps1 一致，用 Start-Process -NoNewWindow 拉起 Python。
 * Node 直接 CreateProcess / PowerShell `&` 调用在部分机器会 0xC0000005。
 */
function spawnPythonProcess(
  python: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  port: number,
): ChildProcess {
  if (process.platform !== "win32") {
    return spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd,
    });
  }

  const psExe = resolvePowerShellExe();
  const stamp = `${port}-${Date.now()}`;
  const logDir = join(tmpdir(), "clip-funasr-gpu");
  mkdirSync(logDir, { recursive: true });
  const outLog = join(logDir, `${stamp}.out.log`);
  const errLog = join(logDir, `${stamp}.err.log`);
  const pidFile = join(logDir, `${stamp}.pid`);
  const launcher = join(logDir, `${stamp}.launch.ps1`);
  lastOutLog = outLog;
  lastErrLog = errLog;
  lastPythonPid = null;

  const argListLiteral = args.map((a) => `'${escapePsSingleQuoted(a)}'`).join(", ");
  // Start-Process 的 -ArgumentList 传数组在 WinPS5.1 上易丢参数；改成一条带引号的命令行字符串
  const ps1 = [
    "$ErrorActionPreference = 'Stop'",
    `$python = '${escapePsSingleQuoted(python)}'`,
    `$cwd = '${escapePsSingleQuoted(cwd)}'`,
    `$outLog = '${escapePsSingleQuoted(outLog)}'`,
    `$errLog = '${escapePsSingleQuoted(errLog)}'`,
    `$pidFile = '${escapePsSingleQuoted(pidFile)}'`,
    `$expectedPort = ${port}`,
    `$argsList = @(${argListLiteral})`,
    "function Quote-Arg([string]$a) {",
    "  if ($a -match '[\\s\"]') { return ('\"' + ($a -replace '\"','\\\"') + '\"') }",
    "  return $a",
    "}",
    "$argString = ($argsList | ForEach-Object { Quote-Arg $_ }) -join ' '",
    "Write-Output (\"funasr-gpu-cmdline=\" + $python + \" \" + $argString)",
    // 合并 stdout/stderr 到同一文件，避免崩溃时 stderr 丢空
    "$p = Start-Process -FilePath $python -ArgumentList $argString -WorkingDirectory $cwd -PassThru -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog",
    "if (-not $p) { throw 'Start-Process returned null' }",
    "Start-Sleep -Milliseconds 800",
    "$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue",
    "if (-not $alive) {",
    "  Start-Sleep -Milliseconds 300",
    "  $tail = ''",
    "  if (Test-Path $errLog) { $tail = Get-Content $errLog -Raw -ErrorAction SilentlyContinue }",
    "  if (Test-Path $outLog) { $tail += Get-Content $outLog -Raw -ErrorAction SilentlyContinue }",
    "  throw (\"python exited immediately after Start-Process. log=\" + $tail)",
    "}",
    "Set-Content -Path $pidFile -Value $p.Id -Encoding ASCII",
    "Write-Output (\"funasr-gpu-pid=\" + $p.Id)",
    "Write-Output (\"funasr-gpu-name=\" + $alive.ProcessName)",
    "Wait-Process -Id $p.Id",
    "Start-Sleep -Milliseconds 400",
    "if ($null -ne $p.ExitCode) { exit $p.ExitCode } else { exit 1 }",
    "",
  ].join("\r\n");
  writeFileSync(launcher, ps1, "utf8");

  console.log(`[funasr-gpu] spawn via Start-Process -NoNewWindow (ps1=${launcher})`);
  console.log(`[funasr-gpu] python logs: out=${outLog} err=${errLog}`);
  // 给子进程打开 faulthandler，原生崩溃时尽量留痕迹
  env.PYTHONFAULTHANDLER = "1";
  env.PYTHONUNBUFFERED = "1";
  return spawn(
    psExe,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
      cwd,
    },
  );
}

function killProcessTree(child: ChildProcess): void {
  if (lastPythonPid) {
    spawnSync("taskkill", ["/PID", String(lastPythonPid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    lastPythonPid = null;
  }
  if (!child.pid) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function buildFatalFromExit(code: number | null, modelsDir?: string): string {
  const hint = isAccessViolationExit(code)
    ? "（Windows ACCESS_VIOLATION / 0xC0000005）"
    : "";
  const errTail = tailFile(lastErrLog, 2500);
  const outTail = tailFile(lastOutLog, 2500);
  const detail = [errTail && `stderr: ${errTail}`, outTail && `stdout: ${outTail}`]
    .filter(Boolean)
    .join(" | ");
  const crashHint = modelsDir
    ? `；也可查看 ${join(modelsDir, "funasr-gpu-crash.log")}`
    : "";
  return `funasr-gpu 进程异常退出 (code=${code})${hint}${detail ? ` — ${detail}` : ""}${crashHint}`;
}

async function spawnGpuProcess(options: FunasrGpuOptions): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  const port = options.gpuPort ?? options.port ?? 17861;
  const baseUrl = `http://${host}:${port}`;
  const device = resolveAsrDevice(options.device);

  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return baseUrl;
  } catch {
    // start below
  }

  if (!existsSync(pythonScript)) {
    throw new Error(`funasr GPU script not found: ${pythonScript}`);
  }

  const python = stripExtendedPath(
    options.pythonPath ?? process.env.CLIP_PYTHON ?? resolveDefaultPython(),
  );
  const modelsDir = stripExtendedPath(options.modelsDir ?? join(process.cwd(), "models"));
  const script = stripExtendedPath(pythonScript);
  mkdirSync(modelsDir, { recursive: true });

  const args = [
    "-u",
    script,
    "--host",
    host,
    "--port",
    String(port),
    "--device",
    device,
    "--models-dir",
    modelsDir,
  ];

  const env = buildPythonEnv({ ...options, modelsDir, ffmpegPath: options.ffmpegPath }, python);
  if (device.toLowerCase().startsWith("cpu")) {
    env.CUDA_VISIBLE_DEVICES = "";
  }

  console.log(`[funasr-gpu] spawn device=${device} python=${python} models=${modelsDir}`);
  gpuFatalError = null;
  lastExitCode = null;

  // cwd 用 venv\Scripts，避免 python 目录下杂文件干扰原生扩展加载
  const spawnCwd = dirname(python);
  gpuProcess = spawnPythonProcess(python, args, env, spawnCwd, port);

  let logCursorOut = 0;
  let logCursorErr = 0;
  let lastHeartbeat = 0;
  const pumpLogs = () => {
    for (const [path, kind] of [
      [lastOutLog, "stdout"],
      [lastErrLog, "stderr"],
    ] as const) {
      if (!path || !existsSync(path)) continue;
      try {
        const raw = readFileSync(path, "utf8");
        // tqdm 进度用 \r 刷新，转成换行才能进 agent.log
        const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const prev = kind === "stdout" ? logCursorOut : logCursorErr;
        if (text.length > prev) {
          const chunk = text.slice(prev);
          if (kind === "stdout") logCursorOut = text.length;
          else logCursorErr = text.length;
          const fatal = findFatalSidecarErrorInChunk(chunk);
          if (fatal) gpuFatalError = fatal;
          logSidecarOutput("[funasr-gpu]", kind, chunk);
        }
      } catch {
        /* ignore */
      }
    }
    const now = Date.now();
    if (now - lastHeartbeat > 15_000) {
      lastHeartbeat = now;
      const outBytes = lastOutLog && existsSync(lastOutLog) ? readFileSync(lastOutLog).length : 0;
      const errBytes = lastErrLog && existsSync(lastErrLog) ? readFileSync(lastErrLog).length : 0;
      const pidInfo = lastPythonPid ? `pid=${lastPythonPid}` : "pid=?";
      console.log(
        `[funasr-gpu] still loading models (${pidInfo}, log out=${outBytes}B err=${errBytes}B). 首次约需下载 1GB，请等待…`,
      );
    }
  };

  gpuProcess.stdout?.on("data", (c: Buffer) => {
    const text = c.toString();
    const m = text.match(/funasr-gpu-pid=(\d+)/);
    if (m) lastPythonPid = Number(m[1]);
    logSidecarOutput("[funasr-gpu]", "stdout", text);
  });
  gpuProcess.stderr?.on("data", (c: Buffer) => {
    logSidecarOutput("[funasr-gpu]", "stderr", c.toString());
  });
  gpuProcess.on("exit", (code) => {
    // 等文件刷盘
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    } catch {
      /* ignore */
    }
    pumpLogs();
    lastExitCode = code;
    if (code !== 0 && code !== null && !gpuFatalError) {
      gpuFatalError = buildFatalFromExit(code, modelsDir);
    }
    gpuProcess = null;
  });
  gpuProcess.on("error", (err) => {
    gpuFatalError = `funasr-gpu 启动失败: ${err.message}`;
  });

  await waitForHealthy(baseUrl, DEFAULT_STARTUP_TIMEOUT_MS, () => {
    pumpLogs();
    return gpuFatalError;
  });
  return baseUrl;
}

function resolveInstallRootFromPython(pythonPath: string): string | null {
  const scripts = dirname(pythonPath);
  const venv = dirname(scripts);
  const funasr = dirname(venv);
  const engines = dirname(funasr);
  const root = stripExtendedPath(dirname(engines));
  if (existsSync(join(root, "engines", "funasr", "venv", "Scripts", "python.exe"))) {
    return root;
  }
  for (const key of ["CLIP_REPO_ROOT", "CLIP_INSTALL_DIR", "CLIP_ACTIVATE_INSTALL_DIR"]) {
    const v = process.env[key]?.trim();
    if (v && existsSync(join(stripExtendedPath(v), "engines", "funasr", "venv", "Scripts", "python.exe"))) {
      return stripExtendedPath(v);
    }
  }
  return null;
}

/** 用热修包内离线 wheel 重装损坏的 sentencepiece.pyd（只尝试一次） */
function tryRepairSentencepiece(pythonPath: string): boolean {
  if (process.platform !== "win32") return false;
  const root = resolveInstallRootFromPython(pythonPath);
  if (!root) return false;
  const script = join(root, "scripts", "repair-funasr-sentencepiece.ps1");
  const wheelDir = join(root, "engines", "funasr", "wheels");
  const hasWheel =
    existsSync(join(wheelDir, "sentencepiece-0.1.99-cp311-cp311-win_amd64.whl")) ||
    existsSync(join(wheelDir, "sentencepiece-0.2.2-cp311-cp311-win_amd64.whl"));
  if (!existsSync(script) || !hasWheel) {
    console.warn(
      `[funasr-gpu] sentencepiece repair skipped (missing script/wheel). script=${existsSync(script)} wheel=${hasWheel}`,
    );
    return false;
  }
  const ps = resolvePowerShellExe();
  console.warn(`[funasr-gpu] repairing sentencepiece via ${script}`);
  const result = spawnSync(
    ps,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      windowsHide: true,
      timeout: 180_000,
      env: {
        ...process.env,
        CLIP_ACTIVATE_INSTALL_DIR: root,
      },
      encoding: "utf8",
    },
  );
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-800);
  if (result.status === 0) {
    console.log(`[funasr-gpu] sentencepiece repair OK: ${out.slice(-200)}`);
    return true;
  }
  console.error(`[funasr-gpu] sentencepiece repair failed status=${result.status}: ${out}`);
  return false;
}

let sentencepieceRepairAttempted = false;

async function startFunasrGpuServer(options: FunasrGpuOptions): Promise<string> {
  const requested = options.device ?? "auto";
  const python =
    options.pythonPath?.trim() ||
    process.env.CLIP_PYTHON?.trim() ||
    resolveDefaultPython();

  try {
    return await spawnGpuProcess(options);
  } catch (firstErr) {
    let err: unknown = firstErr;
    const msg = err instanceof Error ? err.message : String(err);
    const logBlob = `${msg}\n${tailFile(lastOutLog)}\n${tailFile(lastErrLog)}`;
    const av =
      isAccessViolationExit(lastExitCode) ||
      /3221225477|-1073741819|ACCESS_VIOLATION/i.test(logBlob);
    const looksLikeSentencepiece =
      /sentencepiece/i.test(logBlob) || (av && /import sentencepiece|create_module/i.test(logBlob));

    if (!sentencepieceRepairAttempted && (looksLikeSentencepiece || av)) {
      sentencepieceRepairAttempted = true;
      stopFunasrGpuServer();
      gpuFatalError = null;
      lastExitCode = null;
      if (tryRepairSentencepiece(python)) {
        console.warn("[funasr-server] sentencepiece 已修复，重新启动 FunASR…");
        await new Promise((r) => setTimeout(r, 500));
        try {
          return await spawnGpuProcess(options);
        } catch (err2) {
          err = err2;
        }
      }
    }

    const msg2 = err instanceof Error ? err.message : String(err);
    const av2 =
      isAccessViolationExit(lastExitCode) ||
      /3221225477|-1073741819|ACCESS_VIOLATION/i.test(msg2);
    // Start-Process 包装后原生崩溃有时只体现为 code=1；CUDA 失败一律再试 CPU。
    // 但 funasr 包本身缺失/版本过旧时回退 CPU 无意义，CPU 侧也会同样失败，应直接 fatal。
    const looksLikeFunasrMissing =
      /funasr\s*未安装|funasr 版本 .* 不完整|AutoModel|ImportError.*funasr/i.test(msg2) ||
      /requirements-funasr\.txt/i.test(msg2);
    const shouldRetryCpu =
      (requested.startsWith("cuda") || requested === "auto") &&
      !looksLikeFunasrMissing &&
      (av2 || lastExitCode === 1 || /code=1\)/i.test(msg2) || (/load_model failed/i.test(msg2) || /import torch failed/i.test(msg2)));
    if (shouldRetryCpu) {
      console.error(
        "[funasr-server] GPU 启动失败，自动回退 CPU 重试（识别仍可用，速度较慢）…",
      );
      stopFunasrGpuServer();
      gpuFatalError = null;
      lastExitCode = null;
      await new Promise((r) => setTimeout(r, 500));
      return spawnGpuProcess({ ...options, device: "cpu" });
    }
    throw err;
  }
}

export async function transcribeWithFunasrGpu(
  audioPath: string,
  options: Record<string, unknown>,
  serverOptions: FunasrGpuOptions = {},
): Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }> {
  const baseUrl = await ensureFunasrGpuServer(serverOptions);
  const res = await fetch(`${baseUrl}/v1/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioPath, options }),
    signal: AbortSignal.timeout(3_600_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`funasr-gpu transcribe failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }>;
}

export function stopFunasrGpuServer(): void {
  if (gpuProcess) {
    killProcessTree(gpuProcess);
    gpuProcess = null;
  } else if (lastPythonPid) {
    spawnSync("taskkill", ["/PID", String(lastPythonPid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    lastPythonPid = null;
  }
}

function resolveDefaultPython(): string {
  if (process.env.CLIP_REPO_ROOT) {
    const root = stripExtendedPath(process.env.CLIP_REPO_ROOT);
    const venv = join(root, "engines", "funasr", "venv", "Scripts", "python.exe");
    if (existsSync(venv)) return venv;
    const embed = join(root, "engines", "python", "python.exe");
    if (existsSync(embed)) return embed;
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function waitForHealthy(
  baseUrl: string,
  timeoutMs: number,
  getFatalError?: () => string | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fatal = getFatalError?.();
    if (fatal) throw new Error(fatal);
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tail = [tailFile(lastErrLog), tailFile(lastOutLog)].filter(Boolean).join(" | ");
  throw new Error(
    `funasr-gpu not ready after ${Math.round(timeoutMs / 1000)}s (${baseUrl}/health)${tail ? ` — ${tail}` : ""}`,
  );
}
