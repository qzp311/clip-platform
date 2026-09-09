import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import type { RawAsrSegment } from "@clip/sdk";
import { ensureFunasrGpuServer, getGpuFatalError, transcribeWithFunasrGpu, type FunasrGpuOptions } from "./backends/funasr-gpu.js";
import { transcribeWithMock } from "./backends/mock.js";
import { transcribeWithVad } from "./backends/vad.js";
import { transcribeWithWhisper } from "./backends/whisper.js";

type Backend = "vad" | "whisper" | "mock" | "funasr-gpu";

function defaultBackend(): Backend {
  if (process.env.CLIP_ASR_BACKEND) return process.env.CLIP_ASR_BACKEND as Backend;
  if (process.platform === "win32") return "funasr-gpu";
  return "vad";
}

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "17860" },
    backend: { type: "string", default: defaultBackend() },
    "python-path": { type: "string" },
    device: { type: "string", default: "cuda:0" },
    "ffmpeg-path": { type: "string" },
    "models-dir": { type: "string" },
  },
});

function stripWinPath(p: string | undefined): string | undefined {
  if (!p) return p;
  return p.replace(/^\\\\\?\\/i, "").replace(/\//g, "\\");
}

const host = values.host ?? "127.0.0.1";
const port = Number(values.port ?? 17860);
const backend = (values.backend ?? defaultBackend()) as Backend;
const ffmpegPath = stripWinPath(values["ffmpeg-path"] ?? process.env.FFMPEG_PATH);
const modelsDir = stripWinPath(values["models-dir"] ?? process.env.CLIP_FUNASR_MODELS_DIR);
const pythonPath = stripWinPath(values["python-path"] ?? process.env.CLIP_PYTHON);

const gpuLaunchOptions: FunasrGpuOptions = {
  host,
  gpuPort: port + 1,
  device: values.device ?? "cuda:0",
  modelsDir: modelsDir ?? undefined,
  pythonPath: pythonPath ?? undefined,
  ffmpegPath: ffmpegPath ?? undefined,
};

let gpuWarmupError: string | null = null;

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/health" && req.method === "GET") {
      if (backend === "funasr-gpu") {
        const fatal = gpuWarmupError ?? getGpuFatalError();
        if (fatal) {
          return sendJson(res, 503, {
            ok: false,
            gpuReady: false,
            fatal: true,
            backend,
            message: fatal,
          });
        }
        const gpuUrl = `http://${host}:${port + 1}/health`;
        try {
          const gpuRes = await fetch(gpuUrl, { signal: AbortSignal.timeout(2000) });
          if (!gpuRes.ok) {
            return sendJson(res, 503, {
              ok: false,
              gpuReady: false,
              backend,
              message: "ASR 模型加载中，首次运行需下载约 1GB 模型",
            });
          }
        } catch {
          return sendJson(res, 503, {
            ok: false,
            gpuReady: false,
            backend,
            message: "ASR 模型下载/加载中，首次约需 5–10 分钟",
          });
        }
      }
      return sendJson(res, 200, {
        ok: true,
        gpuReady: true,
        backend,
        device: values.device,
        modelsDir: values["models-dir"] ?? null,
      });
    }

    if (req.url === "/v1/transcribe" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        audioPath: string;
        options?: Record<string, unknown>;
      };
      if (!body.audioPath) {
        return sendJson(res, 400, { error: "audioPath required" });
      }

      const result = await runBackend(body.audioPath, body.options ?? {});
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[funasr-server] request error:", message.slice(0, 300));
    sendJson(res, 500, { error: message.slice(0, 300) });
  }
});

server.listen(port, host, () => {
  console.log(`funasr-server listening on http://${host}:${port} (backend=${backend})`);
  if (backend === "funasr-gpu") {
    console.log("[funasr-server] 预热 GPU 后端（首次运行会下载 ASR 模型，约 1GB）…");
    void ensureFunasrGpuServer(gpuLaunchOptions)
      .then(() => console.log("[funasr-server] GPU backend ready"))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        gpuWarmupError = message.slice(0, 300);
        console.error("[funasr-server] GPU warmup failed:", gpuWarmupError);
      });
  }
});

async function runBackend(
  audioPath: string,
  options: Record<string, unknown>,
): Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }> {
  const common = {
    ffmpegPath,
    device: String(options.device ?? values.device ?? "cuda:0"),
  };

  switch (backend) {
    case "mock":
      return transcribeWithMock(audioPath);
    case "whisper":
      return transcribeWithWhisper(audioPath, common);
    case "funasr-gpu":
      return transcribeWithFunasrGpu(audioPath, options, gpuLaunchOptions);
    case "vad":
    default:
      return transcribeWithVad(audioPath, common);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
