import { TosClient } from "@volcengine/tos-sdk";
import { basename } from "node:path";
import type { RenderConfig, TosStorageConfig } from "@clip/sdk";
import {
  getTosStorageConfig,
  resolveTosAccessSecret,
  resolveTosPublicHost,
  resolveTosSdkUploadEndpoint,
} from "@clip/sdk";

const PACKAGE_UPLOAD_EXPIRES_SEC = 3600;

export function requireTosForPackageUpload(render: RenderConfig | undefined): TosStorageConfig {
  const raw = getTosStorageConfig({ render });
  if (!raw?.enabled) {
    throw new Error("TOS 未启用：请在「系统配置 → 火山云 TOS」开启后再上传压缩包");
  }
  const missing: string[] = [];
  if (!raw.bucket?.trim()) missing.push("bucket");
  if (!raw.accessKey?.trim()) missing.push("accessKey");
  if (!raw.accessSecret?.trim()) missing.push("accessSecret");
  if (missing.length) {
    throw new Error(`TOS 配置不完整：${missing.join(", ")}`);
  }
  return {
    ...raw,
    uploadEndpoint: resolveTosSdkUploadEndpoint(raw),
    publicHost: resolveTosPublicHost(raw),
  };
}

function buildPackageObjectKey(packageName: string, tos: TosStorageConfig): string {
  const prefix = tos.keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  const rel = `sources/packages/${basename(packageName)}`;
  return prefix ? `${prefix}/${rel}` : rel;
}

/** 与 Agent 成片上传公网 URL 规则一致，供 Agent 下载 zip */
export function buildTosPublicObjectUrl(objectKey: string, tos: TosStorageConfig): string {
  const key = objectKey.replace(/^\/+/, "");
  if (tos.publicBaseUrl?.trim()) {
    return `${tos.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
  const region = tos.region?.trim() || "cn-beijing";
  const host = tos.publicHost?.trim() || resolveTosPublicHost(tos);
  return `https://${tos.bucket}.${host}/${key}`;
}

/**
 * 预签名 GET 下载链接（私有 bucket 也可读）。
 * getPreSignedUrl 是纯本地签名计算，不发网络请求，批量生成无 IO 开销。
 */
export function buildTosPresignedGetUrl(objectKey: string, tos: TosStorageConfig, expiresSec = 6 * 3600): string {
  const client = createTosClient(tos);
  return client.getPreSignedUrl({
    bucket: tos.bucket,
    key: objectKey.replace(/^\/+/, ""),
    method: "GET",
    expires: expiresSec,
  });
}

function createTosClient(tos: TosStorageConfig): TosClient {
  const region = tos.region?.trim() || "cn-beijing";
  const uploadEndpoint = tos.uploadEndpoint?.trim();
  const opts: {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    endpoint?: string;
    requestTimeout: number;
    connectionTimeout: number;
    maxRetryCount: number;
  } = {
    accessKeyId: tos.accessKey!.trim(),
    accessKeySecret: resolveTosAccessSecret(tos),
    region,
    requestTimeout: 30 * 60 * 1000,
    connectionTimeout: 30_000,
    maxRetryCount: 0,
  };
  if (uploadEndpoint) opts.endpoint = uploadEndpoint;
  return new TosClient(opts);
}

/** 创建只读列举用客户端（超时短，避免列表接口被长上传超时拖慢） */
function createTosListClient(tos: TosStorageConfig): TosClient {
  const region = tos.region?.trim() || "cn-beijing";
  const uploadEndpoint = tos.uploadEndpoint?.trim();
  const opts: {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    endpoint?: string;
    requestTimeout: number;
    connectionTimeout: number;
    maxRetryCount: number;
  } = {
    accessKeyId: tos.accessKey!.trim(),
    accessKeySecret: resolveTosAccessSecret(tos),
    region,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    maxRetryCount: 1,
  };
  if (uploadEndpoint) opts.endpoint = uploadEndpoint;
  return new TosClient(opts);
}

export interface TosMaterialItem {
  objectKey: string;
  filename: string;
  sizeBytes: number;
  lastModified: string;
  /** 预签名 GET 下载/预览地址（私有桶可读，有效期 6 小时，勿持久化） */
  url: string;
  /** 公网 URL（与成片上传的 sourceUrl 同规则，可长期存储、作为复刻案例地址） */
  publicUrl: string;
}

/**
 * 按前缀列举 TOS 下的视频素材（成片按 {prefix}/{项目名}/{专辑名}/{文件} 归档）。
 * 只返回 .mp4，跳过封面 jpg；一次请求最多 maxKeys 条，避免大目录拖垮接口。
 */
export async function listTosMaterialObjects(
  tos: TosStorageConfig,
  input: { projectName?: string; albumName?: string; limit?: number },
): Promise<TosMaterialItem[]> {
  const prefix = tos.keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  const parts = [prefix, input.projectName, input.albumName]
    .map((p) => p?.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const objectPrefix = parts.length ? `${parts.join("/")}/` : "";

  const client = createTosListClient(tos);
  const res = await client.listObjectsType2({
    bucket: tos.bucket,
    prefix: objectPrefix,
    maxKeys: Math.min(Math.max(input.limit ?? 200, 1), 1000),
  });

  const items = (res.data.Contents ?? [])
    .filter((o) => /\.mp4$/i.test(o.Key))
    .map((o) => ({
      objectKey: o.Key,
      filename: o.Key.split("/").pop() ?? o.Key,
      sizeBytes: o.Size ?? 0,
      lastModified: o.LastModified,
      url: buildTosPresignedGetUrl(o.Key, tos),
      publicUrl: buildTosPublicObjectUrl(o.Key, tos),
    }));
  return items;
}

export interface DramaPackageTosUploadPolicy {
  uploadUrl: string;
  objectKey: string;
  sourceUrl: string;
  packageName: string;
  dedupSeq: number;
  expiresSec: number;
  contentType: string;
}

export function createDramaPackageTosUploadPolicy(
  tos: TosStorageConfig,
  input: { packageName: string; dedupSeq: number },
): DramaPackageTosUploadPolicy {
  const packageName = basename(input.packageName);
  if (!/\.zip$/i.test(packageName)) {
    throw new Error("压缩包文件名必须以 .zip 结尾");
  }
  const objectKey = buildPackageObjectKey(packageName, tos);
  const sourceUrl = buildTosPublicObjectUrl(objectKey, tos);
  const client = createTosClient(tos);
  const uploadUrl = client.getPreSignedUrl({
    bucket: tos.bucket,
    key: objectKey,
    method: "PUT",
    expires: PACKAGE_UPLOAD_EXPIRES_SEC,
  });
  return {
    uploadUrl,
    objectKey,
    sourceUrl,
    packageName,
    dedupSeq: input.dedupSeq,
    expiresSec: PACKAGE_UPLOAD_EXPIRES_SEC,
    contentType: "application/zip",
  };
}

export function assertZipFilename(filename: string): string {
  const name = basename(filename.trim());
  if (!name) throw new Error("文件名不能为空");
  if (!/\.zip$/i.test(name)) throw new Error("仅支持 .zip 压缩包");
  return name;
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".flv", ".wmv", ".webm", ".ts", ".mts", ".m2ts",
]);

export function assertMediaFilename(filename: string): { name: string; contentType: string } {
  const name = basename(filename.trim());
  if (!name) throw new Error("文件名不能为空");
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw new Error(`仅支持视频文件：${[...VIDEO_EXTENSIONS].join(", ")}`);
  }
  const contentTypeMap: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".webm": "video/webm",
    ".ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".m2ts": "video/mp2t",
  };
  return { name, contentType: contentTypeMap[ext] ?? "video/mp4" };
}

function buildMediaObjectKey(filename: string, tos: TosStorageConfig): string {
  const prefix = tos.keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  const rel = `sources/media/${basename(filename)}`;
  return prefix ? `${prefix}/${rel}` : rel;
}

export interface MediaTosUploadPolicy {
  uploadUrl: string;
  objectKey: string;
  sourceUrl: string;
  filename: string;
  expiresSec: number;
  contentType: string;
}

export function createMediaTosUploadPolicy(
  tos: TosStorageConfig,
  filename: string,
): MediaTosUploadPolicy {
  const name = basename(filename);
  const objectKey = buildMediaObjectKey(name, tos);
  const sourceUrl = buildTosPublicObjectUrl(objectKey, tos);
  const client = createTosClient(tos);
  const uploadUrl = client.getPreSignedUrl({
    bucket: tos.bucket,
    key: objectKey,
    method: "PUT",
    expires: PACKAGE_UPLOAD_EXPIRES_SEC,
  });
  const { contentType } = assertMediaFilename(filename);
  return {
    uploadUrl,
    objectKey,
    sourceUrl,
    filename: name,
    expiresSec: PACKAGE_UPLOAD_EXPIRES_SEC,
    contentType,
  };
}
