import { createClient, type RedisClientType } from "redis";
import {
  resolveClaimWaitSec,
  resolvePendingCountTtlSec,
  resolveRedisConfig,
  resolveRedisConnectTimeoutMs,
  resolveWakeStreamMaxLen,
  type RedisConfig,
} from "./config.js";

const WAKE_STREAM_KEY = "clip:task:wake";
const WAKE_GROUP = "clip-agents";
const PENDING_COUNT_KEY = "clip:task:pending:top";
const ONLINE_PREFIX = "clip:device:online:";
const ONLINE_TTL_SEC = 120;
/** 消费组内 pending 超过此毫秒未 ack 可被 XAUTOCLAIM 接管 */
const WAKE_CLAIM_IDLE_MS = 60_000;

export interface WakeMessage {
  id: string;
}

export class TaskWakeService {
  private client: RedisClientType | null = null;
  private enabled = false;
  private readonly pendingTtlSec = resolvePendingCountTtlSec();
  private readonly wakeStreamMaxLen = resolveWakeStreamMaxLen();

  static defaultWaitSec(): number {
    return resolveClaimWaitSec();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async connect(config: RedisConfig | null): Promise<void> {
    if (!config) {
      console.warn("[clip-api] Redis 未配置，claim 将降级为定时等待（不写入唤醒队列，超时后查库一次）");
      return;
    }
    try {
      const connectTimeout = resolveRedisConnectTimeoutMs();
      this.client = config.url
        ? createClient({
            url: config.url,
            socket: { connectTimeout },
          })
        : createClient({
            socket: { host: config.host, port: config.port, connectTimeout },
            password: config.password,
            database: config.db,
          });
      this.client.on("error", (err) => {
        console.error("[clip-api] Redis error:", err instanceof Error ? err.message : err);
      });
      await this.client.connect();
      await this.ensureWakeStream();
      this.enabled = true;
      console.log(
        `[clip-api] Redis connected ${config.url ?? `${config.host}:${config.port}/${config.db}`} ` +
          `(claim wait ${TaskWakeService.defaultWaitSec()}s, wake=stream+ack, pending TTL ${this.pendingTtlSec}s)`,
      );
    } catch (err) {
      console.error(
        "[clip-api] Redis 连接失败，claim 降级:",
        err instanceof Error ? err.message : err,
      );
      this.client = null;
      this.enabled = false;
    }
  }

  async close(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
    this.client = null;
    this.enabled = false;
  }

  /** 启动时与 MySQL 对齐 pending 计数，并唤醒可能遗漏的任务 */
  async syncPendingFromDb(count: number): Promise<void> {
    if (count <= 0) return;
    await this.setPendingCount(count);
    await this.notifyWake(Math.min(count, 32));
  }

  async setPendingCount(count: number): Promise<void> {
    if (!this.enabled || !this.client) return;
    await this.client.set(PENDING_COUNT_KEY, String(Math.max(0, count)), {
      EX: this.pendingTtlSec,
    });
  }

  async getPendingCount(): Promise<number | null> {
    if (!this.enabled || !this.client) return null;
    const raw = await this.client.get(PENDING_COUNT_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  }

  async incrementPending(by = 1): Promise<void> {
    if (!this.enabled || !this.client) return;
    const pipe = this.client.multi();
    pipe.incrBy(PENDING_COUNT_KEY, by);
    pipe.expire(PENDING_COUNT_KEY, this.pendingTtlSec);
    await pipe.exec();
  }

  async decrementPending(): Promise<void> {
    if (!this.enabled || !this.client) return;
    const next = await this.client.decr(PENDING_COUNT_KEY);
    if (next < 0) {
      await this.client.set(PENDING_COUNT_KEY, "0", { EX: this.pendingTtlSec });
      return;
    }
    await this.client.expire(PENDING_COUNT_KEY, this.pendingTtlSec);
  }

  /** 新 pending 顶层任务 / retry / stale 释放 */
  async notifyWake(times = 1): Promise<void> {
    if (!this.enabled || !this.client) return;
    const n = Math.min(Math.max(times, 1), 64);
    const pipe = this.client.multi();
    for (let i = 0; i < n; i++) {
      pipe.xAdd(
        WAKE_STREAM_KEY,
        "*",
        { v: "1", at: String(Date.now()) },
        {
          TRIM: {
            strategy: "MAXLEN",
            strategyModifier: "~",
            threshold: this.wakeStreamMaxLen,
          },
        },
      );
    }
    await pipe.exec();
  }

  /**
   * 阻塞读取唤醒消息（进入消费组 pending，需 claim 成功后 ackWake）。
   * consumerId 建议使用 deviceId，便于排查未 ack 消息归属。
   */
  async waitForWake(
    consumerId: string,
    timeoutSec = TaskWakeService.defaultWaitSec(),
  ): Promise<WakeMessage | null> {
    if (!this.enabled || !this.client) {
      await sleep(timeoutSec * 1000);
      return null;
    }
    try {
      await this.reclaimStaleWakeMessages(consumerId);
      const blockMs = Math.max(timeoutSec, 1) * 1000;
      const batches = await this.client.xReadGroup(
        WAKE_GROUP,
        consumerId,
        [{ key: WAKE_STREAM_KEY, id: ">" }],
        { COUNT: 1, BLOCK: blockMs },
      );
      const msg = firstStreamMessage(batches);
      return msg ? { id: msg.id } : null;
    } catch (err) {
      console.error("[clip-api] Redis XREADGROUP failed:", err instanceof Error ? err.message : err);
      await sleep(Math.min(timeoutSec, 15) * 1000);
      return null;
    }
  }

  /** claim 完成后再 ack，避免 BLPOP 式「先删后领」丢信号 */
  async ackWake(messageId: string): Promise<void> {
    if (!this.enabled || !this.client || !messageId) return;
    try {
      await this.client.xAck(WAKE_STREAM_KEY, WAKE_GROUP, messageId);
    } catch (err) {
      console.error(
        "[clip-api] Redis XACK failed:",
        err instanceof Error ? err.message : err,
        messageId,
      );
    }
  }

  async touchOnline(deviceId: string, agentVersion?: string): Promise<void> {
    if (!this.enabled || !this.client) return;
    await this.client.setEx(
      `${ONLINE_PREFIX}${deviceId}`,
      ONLINE_TTL_SEC,
      JSON.stringify({ agentVersion, at: Date.now() }),
    );
  }

  async isOnline(deviceId: string): Promise<boolean | null> {
    if (!this.enabled || !this.client) return null;
    return (await this.client.exists(`${ONLINE_PREFIX}${deviceId}`)) === 1;
  }

  /** 旧版 LIST 队列迁移为 Stream；创建消费组 */
  private async ensureWakeStream(): Promise<void> {
    if (!this.client) return;
    const keyType = await this.client.type(WAKE_STREAM_KEY);
    if (keyType === "list") {
      await this.client.del(WAKE_STREAM_KEY);
      console.warn("[clip-api] Redis 已删除旧版 LIST 唤醒队列，改用 Stream+ACK");
    }
    try {
      await this.client.xGroupCreate(WAKE_STREAM_KEY, WAKE_GROUP, "0", { MKSTREAM: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("BUSYGROUP")) throw err;
    }
  }

  /** 接管其他 consumer 长时间未 ack 的 pending 消息 */
  private async reclaimStaleWakeMessages(consumerId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.xAutoClaim(
        WAKE_STREAM_KEY,
        WAKE_GROUP,
        consumerId,
        WAKE_CLAIM_IDLE_MS,
        "0-0",
        { COUNT: 8 },
      );
    } catch {
      // Redis < 6.2 或无 pending 时忽略
    }
  }
}

function firstStreamMessage(
  batches: Awaited<ReturnType<RedisClientType["xReadGroup"]>> | null,
): { id: string } | null {
  if (!batches?.length) return null;
  for (const batch of batches) {
    for (const msg of batch.messages) {
      if (msg.id) return { id: msg.id };
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let singleton: TaskWakeService | null = null;

export async function getTaskWakeService(): Promise<TaskWakeService> {
  if (!singleton) {
    singleton = new TaskWakeService();
    await singleton.connect(resolveRedisConfig());
  }
  return singleton;
}
