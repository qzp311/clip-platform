import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { findRepoRoot, resolveFunasrSetupScript } from "./paths.js";
import { finishTaskProgress, startTaskProgress } from "./task-progress.js";

/** 去掉 Windows \\?\ 前缀 */
export function stripWinExtendedPath(p: string): string {
  return p.replace(/^\\\\\?\\/i, "").replace(/\//g, "\\").replace(/[\\/]+$/, "");
}

/** 托盘/精简 PATH 下 `powershell.exe` 常找不到，用绝对路径 */
export function resolvePowerShellExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  for (const p of candidates) {
    if (p === "powershell.exe" || existsSync(p)) return p;
  }
  return candidates[0]!;
}

export function funasrVenvPython(repoRoot: string): string {
  return join(repoRoot, "engines", "funasr", "venv", "Scripts", "python.exe");
}

export function funasrVenvMarker(repoRoot: string): string {
  return join(repoRoot, "engines", "funasr", "venv", ".clip-ready");
}

export function isPortableRoot(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "portable.flag"));
}

export function funasrVenvReady(repoRoot: string): boolean {
  return existsSync(funasrVenvMarker(repoRoot)) && existsSync(funasrVenvPython(repoRoot));
}

/** pyvenv.cfg home 是否指向当前安装根 engines\python */
export function funasrVenvPathOk(repoRoot: string): boolean {
  const root = stripWinExtendedPath(repoRoot);
  const cfg = join(root, "engines", "funasr", "venv", "pyvenv.cfg");
  if (!existsSync(cfg)) return false;
  try {
    const text = readFileSync(cfg, "utf-8");
    const expected = join(root, "engines", "python").replace(/\//g, "\\");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*home\s*=\s*(.+)\s*$/i);
      if (m) {
        const home = stripWinExtendedPath(m[1].trim());
        return home.toLowerCase() === expected.toLowerCase();
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** 保证 System32 / PowerShell 在 PATH 中，并前置 torch DLL */
function cleanPythonEnv(pythonPath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "PYTHONHOME",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "PYTHONSTARTUP",
    "PYTHONUSERBASE",
  ]) {
    delete env[key];
  }

  const winRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const systemDirs = [
    join(winRoot, "System32"),
    join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(winRoot, "SysWOW64"),
  ].filter((p) => existsSync(p));

  const prepend: string[] = [...systemDirs];
  if (pythonPath && process.platform === "win32") {
    const venvRoot = dirname(dirname(pythonPath));
    const site = join(venvRoot, "Lib", "site-packages");
    for (const p of [join(site, "torch", "lib"), join(venvRoot, "Scripts")]) {
      if (existsSync(p)) prepend.push(p);
    }
    const nvidiaRoot = join(site, "nvidia");
    if (existsSync(nvidiaRoot)) {
      try {
        for (const name of readdirSync(nvidiaRoot)) {
          for (const sub of ["bin", "lib", join("lib", "x64")]) {
            const p = join(nvidiaRoot, name, sub);
            if (existsSync(p)) prepend.push(p);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  env.PATH = `${prepend.join(";")};${env.PATH ?? ""}`;
  return env;
}

function verifyFunasrImport(pythonPath: string): boolean {
  // windowsHide:true(CREATE_NO_WINDOW) 在部分机器触发 0xC0000005
  const result = spawnSync(pythonPath, ["-c", "import funasr"], {
    windowsHide: false,
    timeout: 180_000,
    env: cleanPythonEnv(pythonPath),
  });
  if (result.status !== 0) {
    const err = [result.error?.message, result.stderr?.toString(), result.stdout?.toString()]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 400);
    console.log(
      `[clip-agent] funasr import check failed status=${result.status} signal=${result.signal} ${err}`,
    );
  }
  return result.status === 0;
}

export async function ensureFunasrVenv(repoRoot = findRepoRoot()): Promise<void> {
  if (process.platform !== "win32") return;

  const root = stripWinExtendedPath(repoRoot);
  const python = funasrVenvPython(root);
  const ready = funasrVenvReady(root);
  const pathOk = funasrVenvPathOk(root);
  // Node 直接 spawn python 在部分机器 ACCESS_VIOLATION；marker+pathOk 即认为已激活成功
  const importOk = ready && pathOk ? verifyFunasrImport(python) : false;
  console.log(
    `[clip-agent] funasr check root=${root} ready=${ready} pathOk=${pathOk} importOk=${importOk}`,
  );

  if (ready && pathOk && importOk) {
    process.env.CLIP_PYTHON = python;
    return;
  }

  if (ready && pathOk && !importOk) {
    console.log(
      "[clip-agent] funasr venv 已存在但导入校验失败，将重新激活/修复…",
    );
  }

  const scriptRaw = resolveFunasrSetupScript(root);
  if (!scriptRaw) {
    throw new Error(
      [
        "FunASR 语音引擎环境未安装。",
        "请重新运行drama-clip安装程序完成一键配置。",
        `缺少自动配置脚本: ${join(root, "scripts", "activate-funasr-engine.ps1")}`,
      ].join("\n"),
    );
  }
  const script = stripWinExtendedPath(scriptRaw);

  const isActivate = script.toLowerCase().endsWith("activate-funasr-engine.ps1");
  const portable = isPortableRoot(root);
  console.log(
    isActivate
      ? "[clip-agent] FunASR 环境未就绪，正在激活预置引擎…"
      : "[clip-agent] FunASR 环境未就绪，正在自动配置（约 3–8 分钟，请保持网络连接）…",
  );
  await startTaskProgress({
    title: "drama-clip",
    kind: "setup",
    phaseCode: "asr",
    phase: isActivate ? "激活 FunASR 引擎…" : "配置 FunASR 环境（约 3–8 分钟）…",
  });

  const psExe = resolvePowerShellExe();
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
  if (portable && isActivate) {
    psArgs.push("-Portable");
  }
  console.log(`[clip-agent] activate via ${psExe}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(psExe, psArgs, {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...cleanPythonEnv(python),
          CLIP_ACTIVATE_INSTALL_DIR: root,
        },
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        const readyAfter = funasrVenvReady(root);
        const pathOkAfter = funasrVenvPathOk(root);
        if (code === 0 && readyAfter && pathOkAfter) {
          process.env.CLIP_PYTHON = python;
          resolve();
          return;
        }
        reject(
          new Error(
            [
              `FunASR 自动配置失败（退出码 ${code ?? "unknown"}`,
              `ready=${readyAfter}`,
              `pathOk=${pathOkAfter}）。`,
              "请确认 engines\\funasr\\venv 完整后重启drama-clip，或重新运行安装程序。",
            ].join(" "),
          ),
        );
      });
    });
  } finally {
    await finishTaskProgress().catch(() => undefined);
  }

  console.log("[clip-agent] FunASR 环境已就绪");
}
