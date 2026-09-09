import type { EffectiveConfig, RenderConfig, TosStorageConfig } from "./index.js";

const TOS_SDK_BLOCKED_S3_ENDPOINTS = new Set([
  "tos-s3-cn-beijing.volces.com",
  "tos-s3-cn-guangzhou.volces.com",
  "tos-s3-cn-shanghai.volces.com",
  "tos-s3-ap-southeast-1.volces.com",
]);

function stripEndpointHost(endpoint: string, bucket?: string): string {
  let host = endpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const b = bucket?.trim();
  if (b && host.startsWith(`${b}.`)) {
    host = host.slice(b.length + 1);
  }
  return host;
}

/** 解析传给 @volcengine/tos-sdk 的 endpoint；返回 undefined 表示由 SDK 按 region 自动推导 */
export function resolveTosSdkUploadEndpoint(tos: TosStorageConfig): string | undefined {
  const region = tos.region?.trim() || "cn-beijing";
  const raw = tos.endpoint?.trim();
  if (!raw) return undefined;

  const host = stripEndpointHost(raw, tos.bucket);
  if (TOS_SDK_BLOCKED_S3_ENDPOINTS.has(host) || /tos-s3-/i.test(host)) {
    return undefined;
  }

  const autoEndpoint = `tos-${region}.volces.com`;
  if (host === autoEndpoint) return undefined;

  if (/\.(volces|ivolces)\.com$/i.test(host)) {
    return host;
  }
  return undefined;
}

/** 拼接成片公网 URL 用的 host（通常为 tos-s3-{region}.volces.com） */
export function resolveTosPublicHost(tos: TosStorageConfig): string {
  const region = tos.region?.trim() || "cn-beijing";
  const raw = tos.endpoint?.trim();
  if (!raw) return `tos-s3-${region}.volces.com`;

  const host = stripEndpointHost(raw, tos.bucket);
  if (/^tos-[a-z0-9-]+\.volces\.com$/i.test(host) && !/^tos-s3-/i.test(host)) {
    return host.replace(/^tos-/i, "tos-s3-");
  }
  return host;
}

/** 解析 TOS Secret（兼容 plain / base64 / 历史二次编码） */
export function resolveTosAccessSecret(
  config: Pick<TosStorageConfig, "accessSecret" | "accessSecretEncoding">,
): string {
  const raw = config.accessSecret?.trim() ?? "";
  if (!raw) return "";
  if (config.accessSecretEncoding !== "base64") return raw;

  let decoded = Buffer.from(raw, "base64").toString("utf8").trim();
  if (!decoded) {
    throw new Error("TOS accessSecret base64 解码结果为空，请检查管理后台 Secret 与编码设置");
  }
  // 历史配置或控制台复制值可能多一层 base64
  if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length >= 16 && decoded !== raw) {
    try {
      const again = Buffer.from(decoded, "base64").toString("utf8").trim();
      if (again && /^[\x20-\x7e]+$/.test(again)) decoded = again;
    } catch {
      // 保留第一次解码
    }
  }
  // 误选 base64 但实际存明文时，解码结果不可用，回退原文
  if (!/^[\x20-\x7e]+$/.test(decoded) && /^[\x20-\x7e]+$/.test(raw)) {
    return raw;
  }
  return decoded;
}

/** 服务端下发 Agent 前 enrich：仅计算 uploadEndpoint/publicHost，Secret 原样下发由 Agent 解码 */
export function enrichTosConfigForAgent(tos: TosStorageConfig): TosStorageConfig {
  return {
    ...tos,
    uploadEndpoint: resolveTosSdkUploadEndpoint(tos),
    publicHost: resolveTosPublicHost(tos),
  };
}

export function enrichRenderConfigForAgent(render: RenderConfig): RenderConfig {
  const tos = render.storage?.tos;
  if (!tos?.enabled) return render;
  return {
    ...render,
    storage: {
      ...render.storage,
      tos: enrichTosConfigForAgent(tos),
    },
  };
}

/** Agent 拉取 effectiveConfig 时由 api-server 调用 */
export function enrichEffectiveConfigForAgent(config: EffectiveConfig): EffectiveConfig {
  return {
    ...config,
    render: enrichRenderConfigForAgent(config.render),
  };
}

// 兼容旧引用
export function normalizeTosEndpoint(endpoint: string, bucket?: string): string {
  return stripEndpointHost(endpoint, bucket).replace(/^tos-s3-/i, "tos-");
}

export function normalizeTosS3Endpoint(endpoint: string, bucket?: string): string {
  return resolveTosPublicHost({ endpoint, bucket, region: "cn-beijing" });
}
