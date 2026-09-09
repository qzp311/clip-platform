/**
 * TOS 上传公共逻辑（本目录独立运行，不依赖仓库其他文件）
 */
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const PUT_OBJECT_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const CONFIG_PATH = join(__dirname, "config.json");

export async function loadConfig(path = CONFIG_PATH) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `找不到配置文件: ${path}\n请复制 config.example.json 为 config.json 并填写 AK/SK、watchDir`,
      );
    }
    throw err;
  }
  return JSON.parse(text);
}

/** 兼容 plain / base64 / 二次 base64 */
export function resolveAccessSecret(raw, encoding) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (encoding !== "base64") return value;

  let decoded = Buffer.from(value, "base64").toString("utf8").trim();
  if (!decoded) throw new Error("SK base64 解码结果为空");
  if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length >= 16 && decoded !== value) {
    try {
      const again = Buffer.from(decoded, "base64").toString("utf8").trim();
      if (again && /^[\x20-\x7e]+$/.test(again)) decoded = again;
    } catch {
      // keep first decode
    }
  }
  if (!/^[\x20-\x7e]+$/.test(decoded) && /^[\x20-\x7e]+$/.test(value)) return value;
  return decoded;
}

export function guessContentType(filename) {
  const ext = extname(filename).toLowerCase();
  const map = {
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };
  return map[ext] ?? "application/octet-stream";
}

export function buildObjectKey(filename, prefix, explicitKey) {
  if (explicitKey) return explicitKey.replace(/^\/+/, "");
  const cleanPrefix = (prefix || "sources/packages").replace(/^\/+|\/+$/g, "");
  return `${cleanPrefix}/${basename(filename)}`;
}

export function buildPublicUrl(bucket, region, objectKey) {
  const key = objectKey.replace(/^\/+/, "");
  return `https://${bucket}.tos-s3-${region}.volces.com/${key}`;
}

export function createProgressLogger(label, tag = "tos") {
  let lastLoggedPct = -1;
  let lastLoggedAt = 0;
  return (percent) => {
    const pct = Math.min(100, Math.floor(percent * 100));
    const now = Date.now();
    if (pct >= lastLoggedPct + 5 || now - lastLoggedAt >= 10_000) {
      lastLoggedPct = pct;
      lastLoggedAt = now;
      console.log(`[${tag}] 进度 ${pct}% (${label})`);
    }
  };
}

export function loadTosSettings(cfg, overrides = {}) {
  const accessKey = String(overrides.accessKey ?? cfg.accessKey ?? "").trim();
  const accessSecretRaw = String(overrides.accessSecret ?? cfg.accessSecret ?? "").trim();
  const bucket = String(overrides.bucket ?? cfg.bucket ?? "vland").trim();
  const endpoint = String(overrides.endpoint ?? cfg.endpoint ?? "https://tos-cn-beijing.volces.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const region = String(overrides.region ?? cfg.region ?? "cn-beijing").trim();
  const prefix = String(overrides.prefix ?? cfg.prefix ?? "sources/packages").trim();
  const secretEncoding = String(
    overrides.secretEncoding ?? cfg.accessSecretEncoding ?? "plain",
  )
    .trim()
    .toLowerCase();

  if (!accessKey || !accessSecretRaw) {
    throw new Error("config.json 缺少 accessKey / accessSecret");
  }

  return {
    accessKey,
    accessKeySecret: resolveAccessSecret(accessSecretRaw, secretEncoding),
    bucket,
    endpoint,
    region,
    prefix,
    secretEncoding,
  };
}

export function createTosClient(settings) {
  let TosClient;
  let UploadEventType;
  try {
    const sdk = require("@volcengine/tos-sdk");
    TosClient = sdk.TosClient;
    UploadEventType = sdk.UploadEventType;
  } catch {
    throw new Error(
      "找不到 @volcengine/tos-sdk。请在本目录执行: npm install\n" +
        `当前目录: ${__dirname}`,
    );
  }

  const client = new TosClient({
    accessKeyId: settings.accessKey,
    accessKeySecret: settings.accessKeySecret,
    region: settings.region,
    endpoint: settings.endpoint,
    requestTimeout: UPLOAD_TIMEOUT_MS,
    connectionTimeout: 30_000,
    maxRetryCount: 2,
  });
  return { client, UploadEventType };
}

export async function uploadLocalFileToTos(client, UploadEventType, settings, localPath, opts = {}) {
  const tag = opts.tag ?? "tos";
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) throw new Error(`不是文件: ${localPath}`);

  const filename = basename(localPath);
  const objectKey = buildObjectKey(filename, settings.prefix, opts.key);
  const contentType = guessContentType(filename);
  const sizeMb = Math.round((fileStat.size / 1024 / 1024) * 10) / 10;
  const logProgress = createProgressLogger(filename, tag);
  const started = Date.now();

  console.log(`[${tag}] 文件: ${localPath}`);
  console.log(`[${tag}] 大小: ${sizeMb} MB  key=${objectKey}`);

  if (fileStat.size <= PUT_OBJECT_MAX_BYTES) {
    const body = await readFile(localPath);
    await client.putObject({
      bucket: settings.bucket,
      key: objectKey,
      body,
      contentType,
      contentLength: fileStat.size,
      dataTransferStatusChange: (status) => {
        if (status.totalBytes > 0) logProgress(status.consumedBytes / status.totalBytes);
      },
    });
  } else {
    await client.uploadFile({
      bucket: settings.bucket,
      key: objectKey,
      file: localPath,
      partSize: 8 * 1024 * 1024,
      taskNum: 4,
      contentType,
      progress: logProgress,
      uploadEventChange: (event) => {
        if (
          event.type === UploadEventType.CreateMultipartUploadFailed ||
          event.type === UploadEventType.UploadPartFailed ||
          event.type === UploadEventType.CompleteMultipartUploadFailed
        ) {
          const message = event.err instanceof Error ? event.err.message : String(event.err ?? "unknown");
          console.error(`[${tag}] 分片失败 type=${event.type}: ${message.slice(0, 300)}`);
        }
      },
    });
  }

  logProgress(1);
  const publicUrl = buildPublicUrl(settings.bucket, settings.region, objectKey);
  const elapsedMs = Date.now() - started;
  console.log(`[${tag}] 上传完成 (${(elapsedMs / 1000).toFixed(1)}s)`);
  console.log(`[${tag}] objectKey: ${objectKey}`);
  console.log(`[${tag}] publicUrl: ${publicUrl}`);
  return { objectKey, publicUrl, sizeBytes: fileStat.size, elapsedMs };
}

export function formatUploadError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const hints = [];
  if (/SignatureDoesNotMatch|signature/i.test(message)) {
    hints.push("Check AK/SK. Set accessSecretEncoding to plain (do not base64-decode SK)");
  }
  if (/do not support s3 endpoint/i.test(message)) {
    hints.push("endpoint 请用 tos-cn-beijing.volces.com，不要用 tos-s3- 开头");
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(message)) {
    hints.push("检查本机到火山 TOS 的网络/DNS/代理");
  }
  return { message, hints };
}
