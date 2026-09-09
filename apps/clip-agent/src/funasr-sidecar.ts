import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveConfig, RawAsrSegment } from "@clip/sdk";
import type { FunasrLaunchSpec } from "./paths.js";
import { logSidecarOutput, findFatalSidecarErrorInChunk } from "./sidecar-log.js";

const execFileAsync = promisify(execFile);

export interface FunasrSidecarOptions {
  host?: string;
  port?: number;
  launch: FunasrLaunchSpec;
  startupTimeoutMs?: number;
}

export interface TranscribeResponse {
  rawSegments: RawAsrSegment[];
  durationMs: number;
}

export class FunasrSidecar {
  private readonly host: string;
  private readonly port: number;
  private readonly startupTimeoutMs: number;
  private process: ChildProcess | null = null;
  /** 仅当本实例真正 spawn 出进程时才 stop 杀掉，避免误杀 daemon 共享的 FunASR */
  private ownsProcess = false;
  private fatalError: string | null = null;

  constructor(private readonly options: FunasrSidecarOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? options.launch.port ?? 17860;
    this.startupTimeoutMs =
      options.startupTimeoutMs ??
      Number(process.env.CLIP_FUNASR_STARTUP_TIMEOUT_MS ?? 900_000);
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.process) return;

    const expectedBackend = this.options.launch.backend ?? process.env.CLIP_ASR_BACKEND ?? "";
    const attached = await this.tryAttachExisting(expectedBackend);
    if (attached) {
      await this.waitForReady();
      return;
    }

    const { command, args, cwd, ffmpegPath } = this.options.launch;
    const env = { ...process.env };
    if (ffmpegPath?.trim()) {
      env.FFMPEG_PATH = ffmpegPath.trim();
      env.CLIP_FFMPEG_PATH = ffmpegPath.trim();
    }

    this.ownsProcess = true;
    // Windows：funasr/torch 在 CREATE_NO_WINDOW(windowsHide) 下易 ACCESS_VIOLATION
    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform !== "win32",
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const fatal = findFatalSidecarErrorInChunk(text);
      if (fatal) this.fatalError = fatal;
      // 端口被 daemon 占用时，本进程会 EADDRINUSE 退出；交给 waitForReady 改走复用
      if (/EADDRINUSE/i.test(text)) {
        this.fatalError = "EADDRINUSE";
      }
      logSidecarOutput("[funasr]", "stderr", text);
    });
    this.process.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const fatal = findFatalSidecarErrorInChunk(text);
      if (fatal) this.fatalError = fatal;
      logSidecarOutput("[funasr]", "stdout", text);
    });

    this.process.on("exit", (code, signal) => {
      if (code !== 0 && code !== null && !this.fatalError) {
        this.fatalError = `funasr-server 异常退出 (code=${code}${signal ? `, ${signal}` : ""})`;
      }
      if (code !== 0 && code !== null) {
        console.error(`funasr-server exited with code ${code}${signal ? ` (${signal})` : ""}`);
      }
      this.process = null;
      this.ownsProcess = false;
    });

    await this.waitForReady();
  }

  /**
   * 端口上已有兼容的 FunASR（含 503 模型加载中）则复用，不再二次 spawn。
   * 仅 backend 不匹配或 fatal 时杀进程后返回 false。
   */
  private async tryAttachExisting(expectedBackend: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json().catch(() => ({}))) as {
        backend?: string;
        fatal?: boolean;
        message?: string;
      };
      if (body.fatal) {
        console.warn(`funasr-server fatal，将重启: ${body.message || ""}`);
        await killListenersOnPort(this.port);
        await killListenersOnPort(this.port + 1);
        await sleep(500);
        return false;
      }
      const runningBackend = body.backend ?? "";
      if (expectedBackend && runningBackend && runningBackend !== expectedBackend) {
        console.warn(
          `funasr-server backend 不匹配: 现有=${runningBackend}, 需要=${expectedBackend}，将重启 sidecar`,
        );
        await killListenersOnPort(this.port);
        await killListenersOnPort(this.port + 1);
        await sleep(500);
        return false;
      }
      // 200 就绪，或 503 加载中：都说明端口已被正确服务占用，直接复用
      console.log(
        `funasr-server already running at ${this.baseUrl}` +
          (runningBackend ? ` (backend=${runningBackend}` : "") +
          (res.ok ? ")" : ", warming up)"),
      );
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.ownsProcess || !this.process) return;
    const proc = this.process;
    this.process = null;
    this.ownsProcess = false;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastMessage = "";
    while (Date.now() < deadline) {
      if (this.fatalError) {
        // 抢端口失败：若已有服务在听，清掉 fatal，继续等它就绪
        if (
          this.fatalError === "EADDRINUSE" ||
          /EADDRINUSE|异常退出 \(code=1\)/.test(this.fatalError)
        ) {
          const ok = await this.healthReachable();
          if (ok) {
            console.warn("funasr-server 端口已被占用，改为复用已有实例");
            this.fatalError = null;
            this.ownsProcess = false;
            this.process = null;
          } else if (this.fatalError === "EADDRINUSE" || /异常退出/.test(this.fatalError)) {
            // 仍可能刚退出，稍后再探
          } else {
            throw new Error(this.fatalError);
          }
        } else {
          throw new Error(this.fatalError);
        }
      }
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { message?: string; fatal?: boolean };
        if (body.fatal && body.message) {
          throw new Error(body.message);
        }
        if (body.message) lastMessage = body.message;
      } catch (err) {
        if (err instanceof Error && (err.message.includes("FunASR") || err.message.includes("fatal"))) {
          throw err;
        }
        // sidecar still starting
      }
      await sleep(2000);
    }
    const hint = lastMessage ? ` (${lastMessage})` : "";
    throw new Error(
      `funasr-server not ready after ${Math.round(this.startupTimeoutMs / 1000)}s (${this.baseUrl}/health)${hint}`,
    );
  }

  private async healthReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      // 任意 HTTP 响应（含 503）都说明服务进程在
      return res.status > 0;
    } catch {
      return false;
    }
  }

  async transcribe(audioPath: string, config: EffectiveConfig): Promise<TranscribeResponse> {
    const rules = config.asr.rules;
    const runtime = config.asr.runtime;
    const pipeline = rules.pipeline ?? {};

    const body = {
      audioPath,
      options: {
        vad: pipeline.enableVad ?? true,
        punc: pipeline.enablePunc ?? true,
        sentenceLevel: pipeline.sentenceLevel ?? true,
        maxSingleSegmentMs: runtime.maxSingleSegmentMs ?? 60_000,
        batchSizeSec: runtime.batchSizeSec,
        hotwords: rules.hotwords?.items ?? [],
        vadOptions: rules.vad,
        models: config.asr.models,
        device: runtime.device,
      },
    };

    const res = await fetch(`${this.baseUrl}/v1/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_600_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`funasr transcribe failed: ${res.status} ${detail.slice(0, 500)}`);
    }

    const data = (await res.json()) as TranscribeResponse;
    if (!Array.isArray(data.rawSegments)) {
      throw new Error("funasr transcribe response missing rawSegments");
    }
    return data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 结束占用指定端口的监听进程（Windows 上常见残留 vad sidecar） */
async function killListenersOnPort(port: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano"], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const pids = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        const local = parts[1] ?? "";
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      }
      for (const pid of pids) {
        console.warn(`[funasr] 结束占用端口 ${port} 的进程 pid=${pid}`);
        await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
        }).catch(() => undefined);
      }
    } catch {
      // ignore
    }
    return;
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`]);
    for (const raw of stdout.split(/\s+/)) {
      const pid = Number(raw.trim());
      if (!Number.isFinite(pid) || pid <= 0) continue;
      console.warn(`[funasr] 结束占用端口 ${port} 的进程 pid=${pid}`);
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // ignore
  }
}
