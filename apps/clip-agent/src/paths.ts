import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dataRoot } from "./config.js";
import type { FfmpegPathSource } from "@clip/agent-core";

const WINDOWS_DEFAULT_INSTALL = "D:\\ClipAgent";
const WINDOWS_LEGACY_INSTALL = "C:\\Program Files\\ClipAgent";

export interface AgentPaths {
  installDir: string;
  installDirSource: string;
  ffmpegPath: string;
  ffmpegPathSource: FfmpegPathSource;
  ffprobePath: string;
  funasrServerPath: string;
  funasrModelsDir: string;
  workspaceDir: string;
  logsDir: string;
  inboxDir: string;
  repoRoot: string;
  nodePath: string;
  pythonPath: string;
  dataRoot: string;
  credentialsPath: string;
  configPath: string | null;
  /** 白名字体文件目录；用于渲染花字/字幕/角标 */
  fontsDir: string;
  /** 贴花/花字模板素材目录 */
  stickersDir: string;
}

export interface ResolvePathsOptions {
  installDir?: string;
  ffmpegPath?: string;
  funasrServerPath?: string;
  funasrModelsDir?: string;
}

export function resolveBundledNode(repoRoot: string): string {
  const win = join(repoRoot, "engines", "node", "node.exe");
  if (existsSync(win)) return win;
  const unix = join(repoRoot, "engines", "node", "node");
  if (existsSync(unix)) return unix;
  return process.execPath;
}

export function resolveBundledPython(repoRoot: string, installDir?: string): string {
  if (process.env.CLIP_PYTHON && existsSync(process.env.CLIP_PYTHON)) {
    return process.env.CLIP_PYTHON;
  }

  // 安装目录优先（运行态），开发仓库其次
  const roots = installDir ? [installDir, repoRoot] : [repoRoot];
  for (const root of roots) {
    const venvWin = join(root, "engines", "funasr", "venv", "Scripts", "python.exe");
    if (existsSync(venvWin)) return venvWin;

    const embedWin = join(root, "engines", "python", "python.exe");
    if (existsSync(embedWin)) {
      if (process.platform === "win32" && defaultAsrBackend() === "funasr-gpu" && root === repoRoot) {
        console.warn(
          "[clip-agent] FunASR venv 未找到，将尝试自动配置；若 ASR 启动失败请重新运行安装程序",
        );
      }
      return embedWin;
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

function resolveInstallDir(options: ResolvePathsOptions, repoRoot: string): {
  installDir: string;
  source: string;
} {
  if (options.installDir?.trim()) {
    return { installDir: options.installDir.trim(), source: "cli --install-dir" };
  }
  if (process.env.CLIP_INSTALL_DIR?.trim()) {
    return { installDir: process.env.CLIP_INSTALL_DIR.trim(), source: "CLIP_INSTALL_DIR" };
  }
  if (process.env.CLIP_AGENT_HOME?.trim()) {
    return { installDir: process.env.CLIP_AGENT_HOME.trim(), source: "CLIP_AGENT_HOME" };
  }
  if (existsSync(join(repoRoot, "engines"))) {
    return { installDir: repoRoot, source: "CLIP_REPO_ROOT(engines)" };
  }
  if (process.platform === "win32") {
    if (existsSync(WINDOWS_DEFAULT_INSTALL)) {
      return { installDir: WINDOWS_DEFAULT_INSTALL, source: "default D:\\ClipAgent" };
    }
    if (existsSync(WINDOWS_LEGACY_INSTALL)) {
      return { installDir: WINDOWS_LEGACY_INSTALL, source: "legacy Program Files" };
    }
    return { installDir: WINDOWS_DEFAULT_INSTALL, source: "default D:\\ClipAgent (未创建)" };
  }
  return {
    installDir: join(homedir(), ".clip-agent", "install"),
    source: "unix ~/.clip-agent/install",
  };
}

function resolveConfigPath(repoRoot: string): string | null {
  const candidates = [
    join(dataRoot(), "config.json"),
    join(repoRoot, "config.json"),
    join(repoRoot, "assets", "config.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function resolveAgentPaths(options: ResolvePathsOptions = {}): AgentPaths {
  const repoRoot = findRepoRoot();
  const { installDir, source: installDirSource } = resolveInstallDir(options, repoRoot);
  const userData = dataRoot();

  const { ffmpegPath, ffmpegPathSource } = resolveFfmpegPathMeta(installDir, options.ffmpegPath);
  const ffprobePath = resolveFfprobePath(installDir, ffmpegPath);

  const funasrServerPath = resolveFunasrServerPath(repoRoot, installDir, options.funasrServerPath);

  const funasrModelsDir =
    options.funasrModelsDir ??
    process.env.CLIP_FUNASR_MODELS_DIR ??
    join(userData, "models");

  return {
    installDir,
    installDirSource,
    ffmpegPath,
    ffmpegPathSource,
    ffprobePath,
    funasrServerPath,
    funasrModelsDir,
    workspaceDir: join(userData, "workspace"),
    logsDir: join(userData, "logs"),
    inboxDir: join(userData, "inbox"),
    repoRoot,
    nodePath: resolveBundledNode(repoRoot),
    pythonPath: resolveBundledPython(repoRoot, installDir),
    dataRoot: userData,
    credentialsPath:
      process.env.CLIP_AGENT_CREDENTIALS ?? join(userData, "credentials.json"),
    configPath: resolveConfigPath(repoRoot),
    fontsDir: resolveFontsDir(repoRoot, installDir),
    stickersDir: resolveStickersDir(repoRoot, installDir),
  };
}

/** 优先使用安装目录下的字体文件，开发环境回退到 monorepo 里的 assets/fonts */
function resolveFontsDir(repoRoot: string, installDir: string): string {
  const envDir = process.env.CLIP_FONTS_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;

  const installFonts = join(installDir, "assets", "fonts");
  if (existsSync(join(installFonts, "fonts.json"))) return installFonts;

  const repoFonts = join(repoRoot, "apps", "clip-agent", "assets", "fonts");
  if (existsSync(join(repoFonts, "fonts.json"))) return repoFonts;

  return installFonts;
}

/** 优先使用安装目录下的贴花模板文件，开发环境回退到 monorepo 里的 assets/stickers */
function resolveStickersDir(repoRoot: string, installDir: string): string {
  const envDir = process.env.CLIP_STICKERS_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;

  const installStickers = join(installDir, "assets", "stickers");
  if (existsSync(join(installStickers, "stickers.json"))) return installStickers;

  const repoStickers = join(repoRoot, "apps", "clip-agent", "assets", "stickers");
  if (existsSync(join(repoStickers, "stickers.json"))) return repoStickers;

  return installStickers;
}

function defaultAsrBackend(): string {
  if (process.env.CLIP_ASR_BACKEND) return process.env.CLIP_ASR_BACKEND;
  if (process.platform === "win32") return "funasr-gpu";
  return "vad";
}

export function resolveFunasrLaunch(paths: AgentPaths, host = "127.0.0.1", port = 17860, device = "cuda:0"): FunasrLaunchSpec {
  const backend = defaultAsrBackend();
  const commonArgs = ["--host", host, "--port", String(port), "--device", device, "--backend", backend];

  if (paths.funasrServerPath.endsWith(".py")) {
    const args = [
      paths.funasrServerPath,
      "--host", host,
      "--port", String(port),
      "--device", device,
      "--models-dir", paths.funasrModelsDir,
    ];
    return {
      command: paths.pythonPath,
      args,
      cwd: dirname(paths.funasrServerPath),
      backend,
      port,
      ffmpegPath: paths.ffmpegPath,
    };
  }

  const packaged = join(paths.repoRoot, "engines", "funasr", "dist", "index.js");
  const dev = join(paths.repoRoot, "apps", "funasr-server", "dist", "index.js");
  const entry = paths.funasrServerPath.endsWith(".js")
    ? paths.funasrServerPath
    : existsSync(packaged)
      ? packaged
      : dev;

  const args = [...commonArgs, "--ffmpeg-path", paths.ffmpegPath, "--python-path", paths.pythonPath];
  if (paths.funasrModelsDir) args.push("--models-dir", paths.funasrModelsDir);

  return {
    command: paths.nodePath,
    args: [entry, ...args],
    cwd: paths.repoRoot,
    backend,
    port,
    ffmpegPath: paths.ffmpegPath,
  };
}

function resolveFfmpegPathMeta(
  installDir: string,
  override?: string,
): { ffmpegPath: string; ffmpegPathSource: FfmpegPathSource } {
  if (override?.trim()) {
    return { ffmpegPath: override.trim(), ffmpegPathSource: "env_override" };
  }
  if (process.env.CLIP_FFMPEG_PATH?.trim()) {
    return { ffmpegPath: process.env.CLIP_FFMPEG_PATH.trim(), ffmpegPathSource: "env_override" };
  }

  const enginesFfmpeg = join(installDir, "engines", "ffmpeg", "ffmpeg.exe");
  if (existsSync(enginesFfmpeg)) {
    return { ffmpegPath: enginesFfmpeg, ffmpegPathSource: "bundled_engines" };
  }

  const pathHint = join(installDir, "ffmpeg", "PATH.txt");
  if (existsSync(pathHint)) {
    const hinted = readFileSync(pathHint, "utf-8").trim();
    if (hinted) return { ffmpegPath: hinted, ffmpegPathSource: "path_hint" };
  }

  const bundled =
    process.platform === "win32"
      ? join(installDir, "ffmpeg", "ffmpeg.exe")
      : join(installDir, "ffmpeg", "ffmpeg");

  if (existsSync(bundled)) {
    return { ffmpegPath: bundled, ffmpegPathSource: "bundled_legacy" };
  }

  return {
    ffmpegPath: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    ffmpegPathSource: "path_fallback",
  };
}

function resolveFfprobePath(installDir: string, ffmpegPath: string): string {
  if (process.env.CLIP_FFPROBE_PATH?.trim()) return process.env.CLIP_FFPROBE_PATH.trim();
  const engines = join(installDir, "engines", "ffmpeg", "ffprobe.exe");
  if (existsSync(engines)) return engines;
  const bundled =
    process.platform === "win32"
      ? join(installDir, "ffmpeg", "ffprobe.exe")
      : join(installDir, "ffmpeg", "ffprobe");
  if (existsSync(bundled)) return bundled;
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

function resolveFunasrServerPath(repoRoot: string, installDir: string, override?: string): string {
  if (override && existsSync(override)) return override;
  if (process.env.CLIP_FUNASR_SERVER_PATH && existsSync(process.env.CLIP_FUNASR_SERVER_PATH)) {
    return process.env.CLIP_FUNASR_SERVER_PATH;
  }

  const packaged = join(repoRoot, "engines", "funasr", "dist", "index.js");
  if (existsSync(packaged)) return packaged;

  const dev = join(repoRoot, "apps", "funasr-server", "dist", "index.js");
  if (existsSync(dev)) return dev;

  const launcher =
    process.platform === "win32"
      ? join(installDir, "engines", "funasr", "funasr-server.cmd")
      : join(installDir, "engines", "funasr", "funasr-server.sh");
  if (existsSync(launcher)) return launcher;

  return join(installDir, "engines", "funasr", "funasr-server.exe");
}

export function findRepoRoot(): string {
  if (process.env.CLIP_REPO_ROOT) return process.env.CLIP_REPO_ROOT;
  // 安装目录环境变量也代表运行根
  if (process.env.CLIP_INSTALL_DIR) return process.env.CLIP_INSTALL_DIR;

  let current = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, "config.json")) && existsSync(join(current, "clip-agent"))) {
      return current;
    }
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "apps", "clip-agent"))) {
      return current;
    }
    current = dirname(current);
  }

  return process.cwd();
}

/** 查找 FunASR 配置脚本：优先离线激活，其次联网安装（安装目录或 monorepo scripts/） */
export function resolveFunasrSetupScript(startDir: string): string | null {
  const names = ["activate-funasr-engine.ps1", "setup-funasr-bundled.ps1"];
  let current = startDir;
  for (let i = 0; i < 10; i++) {
    for (const name of names) {
      const script = join(current, "scripts", name);
      if (existsSync(script)) return script;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface FunasrLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  /** 期望的 ASR 后端；复用已有进程时需与 /health.backend 一致 */
  backend?: string;
  port?: number;
  ffmpegPath?: string;
}
