export interface RedisConfig {
  url?: string;
  host: string;
  port: number;
  password?: string;
  db: number;
}

export function resolveRedisConfig(): RedisConfig | null {
  const url = process.env.CLIP_REDIS_URL?.trim();
  if (url) {
    return { url, host: "", port: 0, db: 0 };
  }
  const host = process.env.CLIP_REDIS_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.CLIP_REDIS_PORT ?? 6379),
    password: process.env.CLIP_REDIS_PASSWORD?.trim() || undefined,
    db: Number(process.env.CLIP_REDIS_DB ?? 0),
  };
}

export function resolveRedisConnectTimeoutMs(): number {
  const raw = Number(process.env.CLIP_REDIS_CONNECT_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(raw)) return 10_000;
  return Math.min(Math.max(Math.floor(raw), 1000), 60_000);
}

export function resolveClaimWaitSec(): number {
  const raw = Number(process.env.CLIP_CLAIM_WAIT_SEC ?? 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(Math.max(Math.floor(raw), 10), 120);
}

/** pending 计数 key 每次写入时续期，默认 24h；过期后 claim 会回查 MySQL 对齐 */
export function resolvePendingCountTtlSec(): number {
  const raw = Number(process.env.CLIP_REDIS_PENDING_TTL_SEC ?? 86_400);
  if (!Number.isFinite(raw)) return 86_400;
  return Math.min(Math.max(Math.floor(raw), 300), 7 * 86_400);
}

/** 唤醒 Stream 最大保留条数（近似裁剪） */
export function resolveWakeStreamMaxLen(): number {
  const raw = Number(process.env.CLIP_REDIS_WAKE_STREAM_MAXLEN ?? 256);
  if (!Number.isFinite(raw)) return 256;
  return Math.min(Math.max(Math.floor(raw), 32), 10_000);
}
