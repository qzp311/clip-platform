import { TosClient, UploadEventType } from "@volcengine/tos-sdk";
import { applyDeduplication, FfmpegRenderer } from "@clip/agent-core";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { EffectiveConfig, TosStorageConfig } from "@clip/sdk";
import { getTosStorageConfig, resolveTosAccessSecret } from "@clip/sdk";

/** 长混剪成片可达数百 MB，分片上传需足够长的超时 */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** 小于该阈值用 putObject 单次上传，避免分片初始化开销 */
const PUT_OBJECT_MAX_BYTES = 20 * 1024 * 1024;

export interface TosUploadInput {
  taskId: string;
  outputPath: string;
  filename?: string;
  /** 对象 key 中的目录段（默认按短剧名归档） */
  folderSegment?: string;
  /** 抽封面用 ffmpeg 路径 */
  ffmpegPath?: string;
  /** 探测帧率用 ffprobe 路径 */
  ffprobePath?: string;
}

/** TOS 配置仅来自服务端 effectiveConfig，不在客户端读环境变量或写死 endpoint */
function requireTosConfig(config: EffectiveConfig): TosStorageConfig {
  const tos = getTosStorageConfig(config);
  if (!tos?.enabled) {
    throw new Error("TOS 上传未启用");
  }
  const missing: string[] = [];
  if (!tos.bucket?.trim()) missing.push("bucket");
  if (!tos.accessKey?.trim()) missing.push("accessKey");
  if (!tos.accessSecret?.trim()) missing.push("accessSecret");
  if (missing.length > 0) {
    throw new Error(`TOS 配置不完整（请检查管理后台）: ${missing.join(", ")}`);
  }
  return tos;
}

function buildObjectKey(
  folderSegment: string,
  filename: string,
  config: TosStorageConfig,
): string {
  const prefix = config.keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  const folder = folderSegment.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${folder}/${filename}` : `${folder}/${filename}`;
}

function buildPublicUrl(objectKey: string, config: TosStorageConfig): string {
  if (config.publicBaseUrl?.trim()) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${objectKey}`;
  }
  const region = config.region?.trim() || "cn-beijing";
  const host = config.publicHost?.trim() || `tos-s3-${region}.volces.com`;
  return `https://${config.bucket}.${host}/${objectKey}`;
}

function coverFilenameFromVideo(videoFilename: string): string {
  return videoFilename.replace(/\.mp4$/i, ".jpg");
}

function coverPathFromVideo(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, ".jpg");
}

function createTosClient(tos: TosStorageConfig): TosClient {
  const region = tos.region?.trim() || "cn-beijing";
  const uploadEndpoint = tos.uploadEndpoint?.trim();
  const secret = resolveTosAccessSecret(tos);
  const clientOpts: {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    endpoint?: string;
    requestTimeout: number;
    connectionTimeout: number;
    maxRetryCount: number;
  } = {
    accessKeyId: tos.accessKey!.trim(),
    accessKeySecret: secret,
    region,
    requestTimeout: UPLOAD_TIMEOUT_MS,
    connectionTimeout: 30_000,
    maxRetryCount: 2,
  };
  if (uploadEndpoint) clientOpts.endpoint = uploadEndpoint;

  console.log(
    `[tos] client region=${region} endpoint=${uploadEndpoint ?? `auto:tos-${region}.volces.com`} bucket=${tos.bucket} secretEncoding=${tos.accessSecretEncoding ?? "plain"}`,
  );
  return new TosClient(clientOpts);
}

async function extractVideoCover(
  ffmpegPath: string,
  videoPath: string,
  coverPath: string,
): Promise<boolean> {
  const renderer = new FfmpegRenderer({
    ffmpegPath,
    workDir: dirname(videoPath),
  });
  for (const atSec of [1, 0]) {
    try {
      await renderer.extractCoverFrame(videoPath, coverPath, { atSec });
      const coverStat = await stat(coverPath);
      if (coverStat.size > 0) {
        console.log(`[tos] 封面抽帧成功 atSec=${atSec}: ${basename(coverPath)}`);
        return true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tos] 封面抽帧失败 atSec=${atSec}: ${message.slice(0, 200)}`);
    }
  }
  return false;
}

function createUploadProgressLogger(label: string): (percent: number) => void {
  let lastLoggedPct = -1;
  let lastLoggedAt = 0;
  return (percent: number) => {
    const pct = Math.min(100, Math.floor(percent * 100));
    const now = Date.now();
    if (pct >= lastLoggedPct + 5 || now - lastLoggedAt >= 15_000) {
      lastLoggedPct = pct;
      lastLoggedAt = now;
      console.log(`[tos] 上传进度 ${pct}% (${label})`);
    }
  };
}

async function uploadFileToTos(
  tosClient: TosClient,
  tos: TosStorageConfig,
  localPath: string,
  objectKey: string,
  contentType: string,
  label: string,
): Promise<void> {
  const fileStat = await stat(localPath);
  const logProgress = createUploadProgressLogger(label);
  console.log(
    `[tos] 开始上传 ${label} (${Math.round(fileStat.size / 1024 / 1024)}MB) key=${objectKey}`,
  );

  if (fileStat.size <= PUT_OBJECT_MAX_BYTES) {
    const body = await readFile(localPath);
    await tosClient.putObject({
      bucket: tos.bucket!,
      key: objectKey,
      body,
      contentType,
      contentLength: fileStat.size,
      dataTransferStatusChange: (status) => {
        if (status.totalBytes > 0) {
          logProgress(status.consumedBytes / status.totalBytes);
        }
      },
    });
    logProgress(1);
    return;
  }

  await tosClient.uploadFile({
    bucket: tos.bucket!,
    key: objectKey,
    file: localPath,
    partSize: 8 * 1024 * 1024,
    taskNum: 2,
    contentType,
    progress: logProgress,
    uploadEventChange: (event) => {
      if (
        event.type === UploadEventType.CreateMultipartUploadFailed ||
        event.type === UploadEventType.UploadPartFailed ||
        event.type === UploadEventType.CompleteMultipartUploadFailed
      ) {
        const message = event.err instanceof Error ? event.err.message : String(event.err ?? "unknown");
        console.error(`[tos] 上传事件失败 type=${event.type}: ${message.slice(0, 300)}`);
      }
    },
  });
  logProgress(1);
}

function formatTosUploadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/do not support s3 endpoint/i.test(message)) {
    return new Error(
      `${message}\n提示：请升级 clip-agent 并重启 api-server，TOS endpoint 应由服务端配置并下发。`,
    );
  }
  if (/SignatureDoesNotMatch|signature/i.test(message)) {
    return new Error(
      `${message}\n提示：请在管理后台核对 TOS AccessKey/Secret 与 Secret 编码（plain/base64）。`,
    );
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(message)) {
    return new Error(
      `${message}\n提示：请检查客户端到对象存储（${message.includes("ENOTFOUND") ? "DNS" : "网络"}）是否可达。`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * 上传复刻原片特征缓存 npz 到 TOS。
 * 路径：{prefix}/remix-features/{dramaId}/{fingerprint}.npz
 * 返回 objectKey。
 */
export async function uploadRemixFeatureCacheToTos(
  config: EffectiveConfig,
  dramaId: string,
  fingerprint: string,
  localPath: string,
): Promise<string> {
  const tos = requireTosConfig(config);
  const objectKey = buildObjectKey(`remix-features/${dramaId}`, `${fingerprint}.npz`, tos);
  const tosClient = createTosClient(tos);
  try {
    await uploadFileToTos(tosClient, tos, localPath, objectKey, "application/octet-stream", `${fingerprint}.npz`);
  } catch (err) {
    throw formatTosUploadError(err);
  }
  console.log(`[tos] 复刻特征缓存上传完成: ${objectKey}`);
  return objectKey;
}

/**
 * 从 TOS 下载复刻原片特征缓存 npz。
 */
export async function downloadRemixFeatureCacheFromTos(
  config: EffectiveConfig,
  objectKey: string,
  localPath: string,
): Promise<void> {
  const tos = requireTosConfig(config);
  const tosClient = createTosClient(tos);
  const res = await tosClient.getObjectV2({ bucket: tos.bucket!, key: objectKey, dataType: "buffer" });
  const buf = Buffer.isBuffer(res.data.content) ? res.data.content : Buffer.from([]);
  await writeFile(localPath, buf);
  console.log(`[tos] 复刻特征缓存下载完成: ${objectKey} -> ${localPath}`);
}

/** 将渲染成片直传到 TOS，路径为 {folderSegment}/{filename} */
export async function uploadOutputVideoToTos(
  config: EffectiveConfig,
  input: TosUploadInput,
): Promise<string> {
  const tos = requireTosConfig(config);
  const ffmpegPath = input.ffmpegPath?.trim() || "ffmpeg";

  const name = input.filename || basename(input.outputPath);
  const folderSegment = input.folderSegment?.trim() || "outputs";
  const fileStat = await stat(input.outputPath);
  console.log(
    `[tos] 直传成片 ${name} (${Math.round(fileStat.size / 1024 / 1024)}MB) → ${tos.bucket}/${folderSegment}`,
  );

  const objectKey = buildObjectKey(folderSegment, name, tos);
  const coverName = coverFilenameFromVideo(name);
  const coverLocalPath = coverPathFromVideo(input.outputPath);
  const coverObjectKey = buildObjectKey(folderSegment, coverName, tos);
  const tosClient = createTosClient(tos);

  const abortTimer = setTimeout(() => {
    console.error("[tos] 上传超时（30min），请检查网络或 TOS 配置");
  }, UPLOAD_TIMEOUT_MS);

  // 上传前随机轻度处理，避免平台判重
  const dedupResult = await applyDeduplication({
    videoPath: input.outputPath,
    ffmpegPath,
    ffprobePath: input.ffprobePath?.trim() || "ffprobe",
  });
  const processedPath = dedupResult.outputPath;
  const processedStat = await stat(processedPath);
  console.log(
    `[tos] 去重后大小: ${Math.round(processedStat.size / 1024 / 1024)}MB (mode=${dedupResult.mode})`,
  );

  let coverReady = false;
  try {
    try {
      await uploadFileToTos(tosClient, tos, processedPath, objectKey, "video/mp4", name);
    } catch (err) {
      throw formatTosUploadError(err);
    }

    const url = buildPublicUrl(objectKey, tos);
    console.log(`[tos] 直传完成: ${url}`);

    coverReady = await extractVideoCover(ffmpegPath, processedPath, coverLocalPath);
    if (coverReady) {
      try {
        const coverStat = await stat(coverLocalPath);
        await uploadFileToTos(
          tosClient,
          tos,
          coverLocalPath,
          coverObjectKey,
          "image/jpeg",
          coverName,
        );
        console.log(`[tos] 封面上传完成: ${buildPublicUrl(coverObjectKey, tos)} (${Math.round(coverStat.size / 1024)}KB)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[tos] 封面上传失败: ${message.slice(0, 200)}`);
      }
    }

    return url;
  } finally {
    clearTimeout(abortTimer);
    if (coverReady) {
      await unlink(coverLocalPath).catch(() => {});
    }
    // 删除去重临时文件，不保留原 workspace 副本
    if (processedPath !== input.outputPath) {
      await unlink(processedPath).catch(() => {});
    }
  }
}
