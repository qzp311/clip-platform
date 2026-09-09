import type { FastifyInstance } from "fastify";
import type { ClipStore } from "./store.js";
import type { DramaIntakeType } from "@clip/sdk";
import type { RemixJobStatus } from "./mysql/remix-replica-repository.js";

type DeviceAuthorizer = (deviceId?: string, token?: string) => Promise<string | null>;

export interface RemixReplicaCreateBody {
  /** 已有短剧复刻：已入库的 dramaId */
  dramaId?: string;
  /** 案例视频 URL（兼容单值；多案例时优先用 caseVideoUrls） */
  caseVideoUrl?: string;
  /** 案例视频 URL 列表（可多条案例） */
  caseVideoUrls?: string[];  episodeUrls?: string[];
  parentPackageTaskId?: string;
  /** 新短剧复刻：复用短剧入库能力 */
  title?: string;
  externalDramaId?: string;
  dramaType?: DramaIntakeType;
  /** 是否启用裂变 */
  fissionEnabled?: boolean | string | number;
  /** 裂变维度列表（不传则使用默认全部） */
  fissionOps?: string[];
  /** 每个成片裂变数量 */
  fissionCount?: number;
}

/** 归一化案例 URL 列表：优先取 caseVideoUrls 数组，兼容 caseVideoUrl 单值 */
function normalizeCaseVideoUrls(body: RemixReplicaCreateBody): string[] {
  const fromArray = Array.isArray(body.caseVideoUrls)
    ? body.caseVideoUrls.filter((url): url is string => typeof url === "string" && url.trim() !== "").map((url) => url.trim())
    : [];
  const single = String(body.caseVideoUrl || "").trim();
  const urls = [...fromArray, single].filter(Boolean);
  return [...new Set(urls)];
}

function headerOne(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeDramaType(value: unknown): DramaIntakeType {
  const raw = String(value || "").trim();
  if (["comic", "short", "paid_comic", "paid_short"].includes(raw)) return raw as DramaIntakeType;
  return "short";
}

export function registerRemixReplicaRoutes(
  app: FastifyInstance,
  store: ClipStore,
  authorizeDevice?: DeviceAuthorizer,
): void {
  // 同时注册两套前缀：admin-web 走 /admin/api，外部/Agent 走 /api/v1
  registerRemixReplicaRoutesAtPrefix(app, store, "/admin/api");
  registerRemixReplicaRoutesAtPrefix(app, store, "/api/v1");

  // Agent 端接口：固定 /agent 前缀，不随管理台/外部前缀重复注册
  app.post<{
    Body: RemixReplicaCreateBody;
    Headers: { "x-device-id"?: string; "x-device-token"?: string };
  }>("/agent/remix/replica", async (req, reply) => {
    const authErr = authorizeDevice
      ? await authorizeDevice(req.headers["x-device-id"], req.headers["x-device-token"])
      : null;
    if (authErr) return reply.code(401).send({ error: authErr });
    const body = req.body ?? {};
    const caseVideoUrls = normalizeCaseVideoUrls(body);
    const caseVideoUrl = caseVideoUrls[0] ?? "";
    const dramaId = String(body.dramaId || "").trim();
    const episodeUrls = Array.isArray(body.episodeUrls)
      ? body.episodeUrls.filter((url): url is string => typeof url === "string" && url.trim() !== "").map((url) => url.trim())
      : [];
    if (!dramaId || caseVideoUrls.length === 0 || episodeUrls.length === 0) {
      return reply.code(400).send({ error: "dramaId, caseVideoUrl and episodeUrls required" });
    }
    try {
      await store.ensureDramaStubForClient(dramaId, { title: String(body.title || dramaId).trim() || dramaId });
      const { task, remixJob } = await store.createRemixReplica({
        dramaId,
        caseVideoUrl,
        caseVideoUrls,
        episodeUrls,
        parentPackageTaskId: body.parentPackageTaskId,
        fissionEnabled: body.fissionEnabled === true || body.fissionEnabled === "true" || body.fissionEnabled === 1,
        fissionOps: body.fissionOps,
        fissionCount: body.fissionCount,
      });
      return { jobId: task?.taskId ?? remixJob.jobId, status: remixJob.status, dramaId };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { deviceId?: string };
    Headers: { "x-device-id"?: string; "x-device-token"?: string };
  }>("/agent/remix-replica/:id/claim", async (req, reply) => {
    const deviceId = headerOne(req.body?.deviceId) ?? headerOne(req.headers["x-device-id"]);
    if (!deviceId) return reply.code(400).send({ error: "deviceId required" });
    await store.claimRemixReplica(req.params.id, deviceId);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { status: RemixJobStatus; timeline?: Record<string, unknown>; errorMessage?: string };
    Headers: { "x-device-id"?: string; "x-device-token"?: string };
  }>("/agent/remix-replica/:id/status", async (req, reply) => {
    const { status, timeline, errorMessage } = req.body ?? {};
    if (!status) return reply.code(400).send({ error: "status required" });
    await store.updateRemixReplicaStatus(req.params.id, status, { timeline, errorMessage });
    return { ok: true };
  });

  // 父任务尚未完成时，Agent 把复刻任务恢复为 pending 等待下次领取
  app.post<{
    Params: { id: string };
    Headers: { "x-device-id"?: string; "x-device-token"?: string };
  }>("/agent/remix-replica/:id/release", async (req, reply) => {
    await store.releaseRemixReplicaClaim(req.params.id);
    return { ok: true };
  });

  // Agent 查询/登记复刻原片特征缓存（元数据入 clip_drama，二进制特征入 TOS）
  app.get<{ Params: { dramaId: string } }>("/agent/remix-replica/:dramaId/feature-cache", async (req) => {
    const cache = await store.getRemixFeatureCache(req.params.dramaId);
    if (!cache) return { cached: false };
    return {
      cached: true,
      objectKey: cache.objectKey,
      fingerprint: cache.fingerprint,
      sizeBytes: cache.sizeBytes,
      frameCount: cache.frameCount,
      sourceCount: cache.sourceCount,
      updatedAt: cache.updatedAt,
    };
  });

  app.post<{
    Params: { dramaId: string };
    Body: {
      objectKey: string;
      fingerprint: string;
      sizeBytes: number;
      frameCount: number;
      sourceCount: number;
    };
  }>("/agent/remix-replica/:dramaId/feature-cache", async (req, reply) => {
    const { objectKey, fingerprint, sizeBytes, frameCount, sourceCount } = req.body ?? {};
    if (!objectKey || !fingerprint || typeof sizeBytes !== "number") {
      return reply.code(400).send({ error: "objectKey/fingerprint/sizeBytes required" });
    }
    await store.setRemixFeatureCache(req.params.dramaId, {
      objectKey,
      fingerprint,
      sizeBytes,
      frameCount: Number(frameCount ?? 0),
      sourceCount: Number(sourceCount ?? 0),
    });
    return { ok: true };
  });
}

function registerRemixReplicaRoutesAtPrefix(app: FastifyInstance, store: ClipStore, prefix: string): void {
  // 创建复刻任务
  app.post<{
    Body: RemixReplicaCreateBody;
  }>(`${prefix}/remix/replica`, async (req, reply) => {
    const body = req.body ?? {};
    const caseVideoUrls = normalizeCaseVideoUrls(body);
    const caseVideoUrl = caseVideoUrls[0] ?? "";
    const rawEpisodeUrls = Array.isArray(body.episodeUrls)
      ? body.episodeUrls.filter((u): u is string => typeof u === "string" && Boolean(u.trim())).map((u) => u.trim())
      : [];

    if (caseVideoUrls.length === 0) {
      return reply.code(400).send({ error: "caseVideoUrl 必填" });
    }

    const parseNumber = (value: unknown): number | undefined => {
      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const parseStringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const arr = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
      return arr.length > 0 ? arr : undefined;
    };

    const fissionOptions = {
      fissionEnabled: body.fissionEnabled === true || body.fissionEnabled === "true" || body.fissionEnabled === 1,
      fissionOps: parseStringArray(body.fissionOps),
      fissionCount: parseNumber(body.fissionCount),
    };

    try {
      // 已有短剧复刻：直接创建 clip_task + clip_remix_job
      const dramaId = typeof body.dramaId === "string" ? body.dramaId.trim() || undefined : undefined;
      if (dramaId) {
        // 客户端上传原片时可直接创建一个本地剧目占位，复刻任务仍走统一 pending/claim 流程。
        if (body.title) {
          await store.ensureDramaStubForClient(dramaId, { title: body.title });
        }
        const { task, remixJob } = await store.createRemixReplica({
          dramaId,
          caseVideoUrl,
          caseVideoUrls,
          episodeUrls: rawEpisodeUrls,
          ...fissionOptions,
        });
        return { jobId: task?.taskId ?? remixJob.jobId, status: remixJob.status };
      }

      // 新短剧复刻：复用短剧入库，先创建 drama_intake + 等待中的 clip_remix_job
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const externalDramaId = typeof body.externalDramaId === "string" ? body.externalDramaId.trim() : "";
      if (!title || !externalDramaId) {
        return reply.code(400).send({ error: "已有短剧复刻请传 dramaId；新短剧复刻请传 title 和 externalDramaId" });
      }
      const dramaType = normalizeDramaType(body.dramaType);

      const intakeResult = await store.batchCreateDramaIntake([
        { title, externalDramaId, dramaType },
      ]);
      const intake = intakeResult.created[0] ?? intakeResult.existingRecords[0];
      if (!intake) {
        return reply.code(500).send({ error: "创建短剧入库记录失败" });
      }
      const { remixJob } = await store.createRemixReplica({
        caseVideoUrl,
        caseVideoUrls,
        episodeUrls: rawEpisodeUrls,
        intakeId: intake.intakeId,
        externalDramaId: intake.externalDramaId,
        ...fissionOptions,
      });
      return {
        jobId: remixJob.jobId,
        status: remixJob.status,
        intakeId: intake.intakeId,
        externalDramaId: intake.externalDramaId,
        note: "短剧入库后系统将自动创建复刻任务",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // 查询复刻任务
  app.get<{ Params: { id: string } }>(`${prefix}/remix/replica/:id`, async (req, reply) => {
    const { task, remixJob } = await store.getRemixReplica(req.params.id);
    if (!remixJob) return reply.code(404).send({ error: "job not found" });
    return {
      jobId: remixJob.jobId,
      dramaId: remixJob.dramaId,
      intakeId: remixJob.intakeId,
      externalDramaId: remixJob.externalDramaId,
      caseVideoUrl: remixJob.caseVideoUrl,
      caseVideoUrls: remixJob.caseVideoUrls,
      episodeUrls: remixJob.episodeUrls,
      parentPackageTaskId: remixJob.parentPackageTaskId,
      status: task?.status ?? remixJob.status,
      outputUrl: task?.outputUrl,
      timeline: remixJob.timeline,
      errorMessage: task?.failMessage ?? remixJob.errorMessage,
      createdAt: task?.createdAt ?? remixJob.createdAt,
      updatedAt: task?.updatedAt ?? remixJob.updatedAt,
    };
  });

  // 查询全部复刻任务列表
  app.get(`${prefix}/remix/replica`, async () => {
    const items = await store.listRemixReplicasByDrama();
    return items.map(({ task, remixJob }) => ({
      jobId: task?.taskId ?? remixJob.jobId,
      dramaId: remixJob.dramaId,
      intakeId: remixJob.intakeId,
      externalDramaId: remixJob.externalDramaId,
      caseVideoUrl: remixJob.caseVideoUrl,
      caseVideoUrls: remixJob.caseVideoUrls,
      episodeUrls: remixJob.episodeUrls,
      parentPackageTaskId: remixJob.parentPackageTaskId,
      status: task?.status ?? remixJob.status,
      outputUrl: task?.outputUrl,
      createdAt: task?.createdAt ?? remixJob.createdAt,
      updatedAt: task?.updatedAt ?? remixJob.updatedAt,
    }));
  });

  // 按短剧查询复刻任务列表
  app.get<{ Params: { dramaId: string } }>(`${prefix}/remix/replica/drama/:dramaId`, async (req) => {
    const items = await store.listRemixReplicasByDrama(req.params.dramaId);
    return items.map(({ task, remixJob }) => ({
      jobId: task?.taskId ?? remixJob.jobId,
      dramaId: remixJob.dramaId,
      intakeId: remixJob.intakeId,
      externalDramaId: remixJob.externalDramaId,
      caseVideoUrl: remixJob.caseVideoUrl,
      caseVideoUrls: remixJob.caseVideoUrls,
      episodeUrls: remixJob.episodeUrls,
      parentPackageTaskId: remixJob.parentPackageTaskId,
      status: task?.status ?? remixJob.status,
      outputUrl: task?.outputUrl,
      createdAt: task?.createdAt ?? remixJob.createdAt,
      updatedAt: task?.updatedAt ?? remixJob.updatedAt,
    }));
  });
}
