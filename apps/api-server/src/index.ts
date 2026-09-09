import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  AgentServicesConfig,
  AsrRules,
  AsrRuntimeConfig,
  AsrSegment,
  ClipPlan,
  ClipPlanBatch,
  ClipTask,
  DeviceRegisterRequest,
  DramaIntakeStatus,
  DramaIntakeType,
  DramaPackageMeta,
  MixRenderRecord,
  RawAsrSegment,
  RenderConfig,
  TelemetryBatch,
  TosStorageConfig,
} from "@clip/sdk";
import { listTemplates } from "@clip/ffmpeg-templates";
import { normalizeDramaIntakeType } from "@clip/sdk";
import { ClipStore } from "./store.js";
import { LocalOss } from "./local-oss.js";
import { ModelCdn } from "./model-cdn.js";
import { agentReleaseObjectKey } from "./agent-release.js";
import { resolvePublicApiBase, warnIfLocalhostDownloadUrl } from "./public-base.js";
import { buildAsrSubtitleUrls, segmentsToSrt } from "./subtitles.js";
import { parsePagination } from "./pagination.js";
import { bootstrapEnv, resolveClipEnvName } from "./env.js";
import { getTaskWakeService } from "./redis/task-wake.js";
import { getTosStorageConfig } from "@clip/sdk";
import {
  assertMediaFilename,
  assertZipFilename,
  buildTosPresignedGetUrl,
  createDramaPackageTosUploadPolicy,
  createMediaTosUploadPolicy,
  requireTosForPackageUpload,
} from "./tos-package-upload.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadedEnvFiles = bootstrapEnv(repoRoot);
const clipEnv = resolveClipEnvName();
if (loadedEnvFiles.length > 0) {
  console.log(`[clip-api] CLIP_ENV=${clipEnv ?? "(未设置)"} env: ${loadedEnvFiles.join(", ")}`);
} else {
  const hint = clipEnv
    ? `（deploy/.env.${clipEnv} 不存在）`
    : "（请设置 CLIP_ENV=test|production，或 NODE_ENV=production 自动加载 production）";
  console.warn(`[clip-api] env: 未加载配置文件 ${hint}`);
}

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const OSS_ROOT = process.env.CLIP_OSS_ROOT ?? join(repoRoot, "data", "oss");
const CDN_MODELS_ROOT = process.env.CLIP_CDN_MODELS_ROOT ?? join(repoRoot, "data", "cdn", "models");
const API_PUBLIC_BASE = resolvePublicApiBase(PORT);
const ADMIN_WEB_DIST = join(repoRoot, "apps/admin-web/dist");

console.log(`[clip-api] public download base (clip_task.source_url): ${API_PUBLIC_BASE}`);
if (HOST === "0.0.0.0" && isLocalhostPublicBase(API_PUBLIC_BASE)) {
  console.warn(
    "[clip-api] HOST=0.0.0.0 but CLIP_API_PUBLIC_BASE is not set — " +
      "tasks will store http://127.0.0.1 download links and remote agents will fail. " +
      "Set CLIP_API_PUBLIC_BASE in deploy/.env.<CLIP_ENV> or on the command line",
  );
}

function isLocalhostPublicBase(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === "127.0.0.1" || h === "localhost";
  } catch {
    return false;
  }
}

import { registerRemixReplicaRoutes } from "./remix-replica-controller.js";

const store = new ClipStore(API_PUBLIC_BASE);
await store.initMysql();
const taskWake = await getTaskWakeService();
store.setTaskWake(taskWake);
await store.initTaskWakeFromDb();
setInterval(
  () => {
    void store.reconcileTaskWake().catch((err) => {
      console.error("[clip-api] task wake reconcile failed:", err instanceof Error ? err.message : err);
    });
  },
  15 * 60 * 1000,
);
const oss = new LocalOss(OSS_ROOT);
store.setOssArtifactChecker((objectKey) => oss.exists(objectKey));
store.setLocalOss(oss);
const modelCdn = new ModelCdn(CDN_MODELS_ROOT);
if (!existsSync(modelCdn.manifestPath())) {
  const { execSync } = await import("node:child_process");
  execSync("node scripts/download-asr-models.mjs", {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, CLIP_API_BASE: API_PUBLIC_BASE },
  });
}

const demoSource = join(repoRoot, "fixtures/test-source.mp4");
let demoSourceAvailable = oss.exists("sources/demo.mp4");
if (existsSync(demoSource)) {
  await oss.seedDemoSource(demoSource);
  demoSourceAvailable = true;
}
await store.reconcileDemoTask(demoSourceAvailable);
if (!demoSourceAvailable) {
  console.warn(
    "[clip-api] demo.mp4 not found — task-demo-001 will not run until fixtures/test-source.mp4 is added",
  );
}
const releaseManifest = store.getAgentReleaseManifest();
const releaseObjectKey = agentReleaseObjectKey(releaseManifest.version);
if (!oss.exists(releaseObjectKey)) {
  console.warn(
    `[clip-api] agent release v${releaseManifest.version} is configured but artifact is missing: ${releaseObjectKey}. ` +
      "Clients will not be offered this update until the zip is uploaded again.",
  );
}

const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const app = Fastify({
  logger: { level: "warn" },
  disableRequestLogging: true,
  bodyLimit: UPLOAD_MAX_BYTES,
  requestTimeout: UPLOAD_TIMEOUT_MS,
});
await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: {
    fileSize: UPLOAD_MAX_BYTES,
    files: 1,
  },
});

function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function requireDeviceAuth(
  store: ClipStore,
  deviceId: string | undefined,
  token: string | undefined,
): Promise<string | null> {
  const normalizedToken = headerOne(token);
  if (!deviceId || !normalizedToken || !(await store.authDeviceAsync(deviceId, normalizedToken))) {
    return "invalid device token";
  }
  return null;
}

app.get("/health", async () => ({
  ok: true,
  version: "0.3.0",
  ossRoot: OSS_ROOT,
  mysql: store.mysqlEnabled(),
  redis: taskWake.isEnabled,
}));

registerRemixReplicaRoutes(app, store, (deviceId, token) => requireDeviceAuth(store, deviceId, token));

app.get("/admin/api/package-caches", async (req) => {
  const q = req.query as { dramaId?: string; deviceId?: string; status?: string; limit?: string; offset?: string };
  const { limit, offset } = parsePagination(q);
  return store.listPackageCaches({ dramaId: q.dramaId, deviceId: q.deviceId, status: q.status, limit, offset });
});
app.get<{ Headers: { "x-device-id"?: string; "x-device-token"?: string }; Querystring: { dramaId?: string; status?: string; limit?: string; offset?: string; all?: string } }>(
  "/agent/package-caches",
  async (req, reply) => {
    const deviceId = headerOne(req.headers["x-device-id"]);
    const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    const q = req.query;
    const { limit, offset } = parsePagination(q);
    const tos = getTosStorageConfig({ render: store.getGlobalConfig().render as RenderConfig | undefined });

    if (q.all === "1") {
      // 全部设备视角：以 clip_task(drama_package) 为主表，本机缓存表只做状态标注（未缓存的走按需下载）
      const page = await store.listTasksPage({
        taskKind: "drama_package",
        dramaId: q.dramaId,
        limit,
        offset,
      });
      const myCaches = new Map(
        (await store.listPackageCaches({ deviceId: deviceId!, limit: 500, offset: 0 }))
          .items.map((c) => [c.dramaId, c]),
      );
      const items = page.tasks.map((t) => {
        const meta = (t as { dramaPackage?: DramaPackageMeta }).dramaPackage;
        const cached = t.dramaId ? myCaches.get(t.dramaId) : undefined;
        // objectKey 三级回落：任务 meta → 本机缓存 → sourceUrl 解析，保证尽量可下载
        const objectKeyFromUrl = (() => {
          try {
            return t.sourceUrl ? decodeURIComponent(new URL(t.sourceUrl).pathname.replace(/^\/+/, "")) : "";
          } catch {
            return "";
          }
        })();
        const objectKey = meta?.packageObjectKey || cached?.packageObjectKey || objectKeyFromUrl;
        // 下载链接：有 objectKey 走预签名 GET（私有桶可读）；否则回落任务 sourceUrl 原始地址
        // 注意不能拿 sourceUrl 解析出的 objectKey 去当前 bucket 拼签名——老任务的 sourceUrl 可能指向历史 bucket，桶对不上必 404
        const metaObjectKey = meta?.packageObjectKey || cached?.packageObjectKey || "";
        const downloadUrl = metaObjectKey && tos?.enabled
          ? buildTosPresignedGetUrl(metaObjectKey, tos as TosStorageConfig)
          : t.sourceUrl || undefined;
        return {
          cacheId: cached?.cacheId,
          cacheKey: cached?.cacheKey,
          dramaId: t.dramaId || "",
          dramaTitle: meta?.title || store.dramaTitleById(t.dramaId),
          packageTaskId: t.taskId,
          packageObjectKey: objectKey || undefined,
          packageName: meta?.packageName || cached?.packageName || String(t.sourceUrl || "").split("/").pop() || `${meta?.title || "剧包"}.zip`,
          zipExists: cached?.zipExists ?? false,
          extracted: cached?.extracted ?? false,
          episodeCount: meta?.episodeCount ?? cached?.episodeCount,
          sizeBytes: cached?.sizeBytes ?? 0,
          // 本机无缓存记录时标 uncached，客户端展示为可按需下载
          status: cached?.status ?? "uncached",
          taskStatus: t.status,
          downloadUrl,
          updatedAt: t.updatedAt,
        };
      });
      return { items, total: page.total, limit: page.limit, offset: page.offset };
    }

    const page = await store.listPackageCaches({
      dramaId: q.dramaId,
      deviceId: deviceId!,
      status: q.status,
      limit,
      offset,
    });
    return {
      ...page,
      items: page.items.map((it) => {
        const downloadUrl =
          it.packageObjectKey && tos?.enabled
            ? buildTosPresignedGetUrl(it.packageObjectKey, tos as TosStorageConfig)
            : undefined;
        return {
          cacheId: it.cacheId,
          cacheKey: it.cacheKey,
          dramaId: it.dramaId,
          dramaTitle: store.dramaTitleById(it.dramaId),
          packageTaskId: it.packageTaskId,
          packageObjectKey: it.packageObjectKey,
          packageName: it.packageName,
          zipExists: it.zipExists,
          extracted: it.extracted,
          episodeCount: it.episodeCount,
          sizeBytes: it.sizeBytes,
          status: it.status,
          downloadUrl,
          updatedAt: it.updatedAt,
        };
      }),
    };
  },
);
app.get("/admin/api/edit-markers", async (req) => {
  const q = req.query as { sourcePath?: string; taskId?: string; deviceId?: string };
  return { markers: await store.listEditMarkers(q) };
});
// 客户端拉取某任务（分集ASR/剧包/混剪）下的全部人工标记，跨设备共享
app.get<{ Querystring: { taskId?: string }; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/edit-markers",
  async (req, reply) => {
    const deviceId = headerOne(req.headers["x-device-id"]);
    const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    const taskId = headerOne((req.query as { taskId?: string | string[] }).taskId)?.trim();
    if (!taskId) return reply.code(400).send({ error: "taskId required" });
    return { markers: await store.listEditMarkersByTaskId(taskId) };
  },
);
app.post<{
  Body: {
    sourcePath: string;
    startMs: number;
    endMs: number;
    label?: string;
    taskId?: string;
    highlightType?: "hook" | "conflict" | "twist" | "cliff";
    usableAsHook?: boolean;
    source?: "human" | "suppress";
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/edit-markers", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const b = req.body;
  if (!b?.sourcePath || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs) || b.endMs <= b.startMs) {
    return reply.code(400).send({ error: "有效的 sourcePath/startMs/endMs required" });
  }
  const highlightType = b.highlightType;
  const typeLabel =
    highlightType === "hook"
      ? "片头钩子"
      : highlightType === "conflict"
        ? "冲突"
        : highlightType === "twist"
          ? "反转"
          : highlightType === "cliff"
            ? "悬念"
            : null;
  const source = b.source === "suppress" ? "suppress" : "human";
  return store.createEditMarker({
    sourcePath: b.sourcePath,
    deviceId: deviceId!,
    taskId: b.taskId,
    startMs: Number(b.startMs),
    endMs: Number(b.endMs),
    label: b.label?.trim() || typeLabel || "高光",
    highlightType,
    usableAsHook: b.usableAsHook === true || highlightType === "hook",
    source,
  });
});
app.put<{
  Body: {
    sourcePath: string;
    oldStartMs: number;
    oldEndMs: number;
    startMs: number;
    endMs: number;
    label?: string;
    highlightType?: "hook" | "conflict" | "twist" | "cliff";
    usableAsHook?: boolean;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/edit-markers", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const b = req.body;
  if (
    !b?.sourcePath ||
    !Number.isFinite(b.oldStartMs) ||
    !Number.isFinite(b.oldEndMs) ||
    !Number.isFinite(b.startMs) ||
    !Number.isFinite(b.endMs) ||
    b.endMs <= b.startMs
  ) {
    return reply.code(400).send({ error: "有效的 sourcePath/oldStartMs/oldEndMs/startMs/endMs required" });
  }
  const updated = await store.updateEditMarkerByRange({
    deviceId: deviceId!,
    sourcePath: b.sourcePath,
    oldStartMs: Number(b.oldStartMs),
    oldEndMs: Number(b.oldEndMs),
    startMs: Number(b.startMs),
    endMs: Number(b.endMs),
    label: b.label,
    highlightType: b.highlightType,
    usableAsHook: b.usableAsHook,
  });
  if (!updated) return reply.code(404).send({ error: "未找到可更新的标记" });
  return updated;
});
app.delete<{
  Body: { sourcePath?: string; startMs?: number; endMs?: number; markerId?: number };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/edit-markers", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const b = req.body;
  // 云端标记按 markerId 精确删；本地标记按路径+区间删（兼容老逻辑）
  if (b?.markerId != null && Number.isFinite(Number(b.markerId))) {
    const deleted = await store.deleteEditMarkerById(Number(b.markerId));
    return { ok: true, deleted };
  }
  if (!b?.sourcePath || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) {
    return reply.code(400).send({ error: "有效的 markerId 或 sourcePath/startMs/endMs required" });
  }
  const deleted = await store.deleteEditMarkerByRange({
    deviceId: deviceId!,
    sourcePath: b.sourcePath,
    startMs: Number(b.startMs),
    endMs: Number(b.endMs),
  });
  return { ok: true, deleted };
});
app.post<{ Headers: { "x-device-id"?: string; "x-device-token"?: string }; Body: Record<string, unknown> }>("/agent/package-caches/heartbeat", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const body = req.body ?? {};
  if (!body.cacheKey || !body.dramaId || !body.packageName) return reply.code(400).send({ error: "cacheKey, dramaId, packageName required" });
  return store.upsertPackageCache({ cacheKey: String(body.cacheKey), dramaId: String(body.dramaId), packageTaskId: body.packageTaskId ? String(body.packageTaskId) : undefined, packageObjectKey: body.packageObjectKey ? String(body.packageObjectKey) : undefined, packageName: String(body.packageName), deviceId: deviceId!, zipPath: body.zipPath ? String(body.zipPath) : undefined, extractPath: body.extractPath ? String(body.extractPath) : undefined, zipExists: body.zipExists === true, extracted: body.extracted === true, episodeCount: body.episodeCount == null ? undefined : Number(body.episodeCount), sizeBytes: Number(body.sizeBytes ?? 0), status: String(body.status ?? "missing") as import("./mysql/package-cache-repository.js").PackageCacheStatus, lastUsedAt: body.lastUsedAt ? String(body.lastUsedAt) : undefined, lastError: body.lastError ? String(body.lastError) : undefined });
});

// ── Agent APIs ──────────────────────────────────────────────

app.post<{ Body: DeviceRegisterRequest }>("/agent/devices/register", async (req) => {
  return store.registerDevice(req.body);
});

app.get<{ Params: { id: string }; Querystring: { ruleSetId?: string }; Headers: { "x-device-token"?: string } }>(
  "/agent/devices/:id/config",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.params.id, req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    return store.getDeviceConfig(req.params.id, req.query.ruleSetId);
  },
);

app.get<{ Headers: { "x-device-id"?: string; "x-device-token"?: string } }>("/agent/media/outputs", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  return { outputs: await store.listAgentMediaOutputs(deviceId!) };
});

/** 桌面端音频轨候选：直接读 clip_bgm_track，不依赖 profile_json */
app.get<{ Headers: { "x-device-id"?: string; "x-device-token"?: string } }>("/agent/bgm-tracks", async (req, reply) => {
  const deviceId = headerOne(req.headers["x-device-id"]);
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const tracks = await store.listAgentBgmTracks();
  return { tracks };
});

app.post<{ Params: { id: string }; Headers: { "x-device-token"?: string }; Body: { agentVersion?: string } }>(
  "/agent/devices/:id/heartbeat",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.params.id, req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    return store.heartbeat(req.params.id, req.body?.agentVersion);
  },
);

app.get<{ Headers: { "x-device-id"?: string; "x-device-token"?: string }; Querystring: { taskId?: string } }>(
  "/agent/tasks/claim",
  async (req, reply) => {
    const deviceId = req.headers["x-device-id"];
    const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    const task = await store.pollClaimTask(deviceId!, taskWake, req.query.taskId);
    if (!task) return { task: null };
    const config = store.getDeviceConfig(deviceId!, task.asrRuleSetId, task.dramaId);
    return { task, effectiveConfig: config };
  },
);

app.get<{ Params: { id: string }; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/tasks/:id",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    const task = await store.getTaskForAgent(req.params.id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return { task };
  },
);

app.post<{ Params: { id: string }; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/tasks/:id/retry",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    try {
      const task = await store.retryTask(req.params.id);
      return { ok: true, task };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

app.post<{
  Body: {
    filename: string;
    contentBase64: string;
    templateId?: string;
    dramaId?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/materials/submit", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.filename || !req.body?.contentBase64) {
    return reply.code(400).send({ error: "filename and contentBase64 required" });
  }
  const objectKey = await oss.saveSourceUpload(req.body.filename, req.body.contentBase64);
  const sourceUrl = oss.toPublicUrl(API_PUBLIC_BASE, objectKey);
  const task = await store.createTask({
    sourceUrl,
    templateId: req.body.templateId,
    dramaId: req.body.dramaId ?? "drama-demo",
    dramaMeta: req.body.dramaMeta,
    asrRuleSetId: req.body.asrRuleSetId,
    taskKind: "single",
  });
  return { ok: true, taskId: task.taskId, sourceUrl, objectKey, task };
});

/** 客户端案例复刻素材上传：仅保存原片/案例并返回 URL，不创建普通剪辑任务。 */
app.post<{
  Body: { filename: string; contentBase64: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/remix/replica/upload-source", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.filename || !req.body?.contentBase64) {
    return reply.code(400).send({ error: "filename and contentBase64 required" });
  }
  const objectKey = await oss.saveSourceUpload(req.body.filename, req.body.contentBase64);
  return {
    ok: true,
    objectKey,
    sourceUrl: oss.toPublicUrl(API_PUBLIC_BASE, objectKey),
  };
});

app.post<{
  Body: {
    filename: string;
    contentBase64: string;
    dramaId: string;
    episodeNo?: number;
    title?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/materials/submit-episode", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.filename || !req.body?.contentBase64 || !req.body?.dramaId) {
    return reply.code(400).send({ error: "filename, contentBase64 and dramaId required" });
  }
  const objectKey = await oss.saveSourceUpload(req.body.filename, req.body.contentBase64);
  const sourceUrl = oss.toPublicUrl(API_PUBLIC_BASE, objectKey);
  const { episode, task } = await store.registerEpisode({
    dramaId: req.body.dramaId,
    sourceUrl,
    filename: req.body.filename,
    episodeNo: req.body.episodeNo,
    title: req.body.title,
    dramaMeta: req.body.dramaMeta,
    asrRuleSetId: req.body.asrRuleSetId,
  });
  return { ok: true, episodeId: episode.episodeId, episodeNo: episode.episodeNo, taskId: task.taskId, sourceUrl, objectKey, episode, task };
});

app.post<{
  Body: {
    localPath: string;
    filename?: string;
    templateId?: string;
    dramaId?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/materials/register", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.localPath) {
    return reply.code(400).send({ error: "localPath required" });
  }
  const { toClipLocalSourceUrl } = await import("@clip/sdk");
  const sourceUrl = toClipLocalSourceUrl(req.body.localPath);
  const task = await store.createTask({
    sourceUrl,
    templateId: req.body.templateId,
    dramaId: req.body.dramaId ?? "drama-demo",
    dramaMeta: req.body.dramaMeta,
    asrRuleSetId: req.body.asrRuleSetId,
    taskKind: "single",
  });
  return { ok: true, taskId: task.taskId, sourceUrl, task };
});

app.post<{
  Body: {
    localPath: string;
    filename?: string;
    dramaId: string;
    episodeNo?: number;
    title?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
    packageTaskId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/materials/register-episode", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.localPath || !req.body?.dramaId) {
    return reply.code(400).send({ error: "localPath and dramaId required" });
  }
  const { toClipLocalSourceUrl } = await import("@clip/sdk");
  const sourceUrl = toClipLocalSourceUrl(req.body.localPath);
  const { episode, task } = await store.registerEpisode({
    dramaId: req.body.dramaId,
    sourceUrl,
    filename: req.body.filename ?? req.body.localPath.split(/[/\\]/).pop(),
    episodeNo: req.body.episodeNo,
    title: req.body.title,
    dramaMeta: req.body.dramaMeta,
    asrRuleSetId: req.body.asrRuleSetId,
    packageTaskId: req.body.packageTaskId,
    deviceId: headerOne(req.headers["x-device-id"]),
  });
  return {
    ok: true,
    episodeId: episode.episodeId,
    episodeNo: episode.episodeNo,
    taskId: task.taskId,
    sourceUrl,
    episode,
    task,
  };
});

/** 登记本地成片，仅跑 ASR + 高光打分（不选段/渲染） */
app.post<{
  Body: {
    localPath: string;
    filename?: string;
    dramaId?: string;
    parentTaskId?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/materials/register-output", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.localPath) {
    return reply.code(400).send({ error: "localPath required" });
  }
  const { toClipLocalSourceUrl } = await import("@clip/sdk");
  const sourceUrl = toClipLocalSourceUrl(req.body.localPath);
  const dramaMeta =
    req.body.dramaMeta && typeof req.body.dramaMeta === "object"
      ? (req.body.dramaMeta as Record<string, unknown>)
      : undefined;
  const titleFromMeta =
    (typeof dramaMeta?.title === "string" && dramaMeta.title.trim()) ||
    (typeof dramaMeta?.dramaTitle === "string" && String(dramaMeta.dramaTitle).trim()) ||
    "";
  const dramaId =
    req.body.dramaId?.trim() ||
    (titleFromMeta
      ? `drama-lib-${createHash("sha1").update(titleFromMeta).digest("hex").slice(0, 16)}`
      : "drama-output-asr");
  const parentTaskId = req.body.parentTaskId?.trim() || undefined;
  const deviceId = headerOne(req.headers["x-device-id"]);
  await store.ensureDramaStubForClient(dramaId, {
    ...(dramaMeta || {}),
    title: titleFromMeta || dramaId,
  });
  // 由当前设备 CLI 立即处理：标 processing + claimed，避免进 daemon pending 队列
  const task = await store.createTask({
    sourceUrl,
    dramaId,
    dramaMeta: { ...(dramaMeta || {}), title: titleFromMeta || dramaId },
    asrRuleSetId: req.body.asrRuleSetId,
    taskKind: "output_asr",
    parentPackageTaskId: parentTaskId,
    claimedBy: deviceId,
    initialStatus: "processing",
  });
  return {
    ok: true,
    taskId: task.taskId,
    sourceUrl,
    task,
  };
});

app.get<{ Params: { dramaId: string } }>("/agent/dramas/:dramaId/episodes", async (req, reply) => {
  const authErr = await requireDeviceAuth(
    store,
    headerOne(req.headers["x-device-id"]),
    headerOne(req.headers["x-device-token"]),
  );
  if (authErr) return reply.code(401).send({ error: authErr });
  // 以 clip_asr_result 为准回填，避免重启后分集 status 不准导致「未识别」假象
  const episodes = await store.listDramaEpisodesReconciled(req.params.dramaId);
  return { dramaId: req.params.dramaId, episodes };
});

/** 批量查询多部剧 meta + episodes：桌面端混剪列表刷新用，避免 N 部剧并发 N×2 次请求 */
app.post<{
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
  Body: { dramaIds?: string[] };
}>("/agent/dramas/batch", async (req, reply) => {
  const authErr = await requireDeviceAuth(
    store,
    headerOne(req.headers["x-device-id"]),
    headerOne(req.headers["x-device-token"]),
  );
  if (authErr) return reply.code(401).send({ error: authErr });
  const ids = (req.body?.dramaIds || []).filter((id) => typeof id === "string" && id.trim());
  const [metas, episodesMap] = await Promise.all([
    store.resolveAgentDramasBatch(ids),
    store.listDramasEpisodesReconciledBatch(ids),
  ]);
  return {
    dramas: metas.map((m) => ({
      ...m,
      episodes: episodesMap[m.dramaId] || [],
    })),
  };
});

/** 查询剧目 meta（桌面端列表/弹窗：clip_drama.meta + clip_drama_intake 回落） */
app.get<{
  Params: { dramaId: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/dramas/:dramaId/meta", async (req, reply) => {
  const authErr = await requireDeviceAuth(
    store,
    headerOne(req.headers["x-device-id"]),
    headerOne(req.headers["x-device-token"]),
  );
  if (authErr) return reply.code(401).send({ error: authErr });
  const resolved = await store.resolveAgentDramaMeta(req.params.dramaId);
  if (!resolved) return reply.code(404).send({ error: "drama not found" });
  return { ok: true, ...resolved };
});

/** Agent/桌面端：更新剧名、题材、简介（简介可空） */
app.put<{
  Params: { dramaId: string };
  Body: { title?: string; synopsis?: string; genre?: string; genreTags?: string[] };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/dramas/:dramaId/meta", async (req, reply) => {
  const authErr = await requireDeviceAuth(
    store,
    headerOne(req.headers["x-device-id"]),
    headerOne(req.headers["x-device-token"]),
  );
  if (authErr) return reply.code(401).send({ error: authErr });
  const title = req.body?.title?.trim();
  const genre = req.body?.genre?.trim();
  const genreTags =
    req.body?.genreTags?.filter((t) => typeof t === "string" && t.trim()) ??
    (genre ? [genre] : undefined);
  try {
    const drama = await store.updateDramaMeta(req.params.dramaId, {
      title: title || undefined,
      synopsis: req.body?.synopsis,
      genreTags,
    });
    return { ok: true, drama };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "drama not found") return reply.code(404).send({ error: msg });
    return reply.code(400).send({ error: msg });
  }
});

/** 混剪前对齐：按集号查 MySQL ASR，已有识别则回填分集并跳过 ASR */
app.post<{
  Params: { dramaId: string };
  Body: {
    episodes: Array<{ episodeNo: number; localPath?: string; sourceUrl?: string; title?: string; filename?: string }>;
    dramaMeta?: Record<string, unknown>;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/dramas/:dramaId/ensure-episodes", async (req, reply) => {
  const authErr = await requireDeviceAuth(
    store,
    headerOne(req.headers["x-device-id"]),
    headerOne(req.headers["x-device-token"]),
  );
  if (authErr) return reply.code(401).send({ error: authErr });
  const items = req.body?.episodes;
  if (!Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ error: "episodes required" });
  }
  try {
    const { toClipLocalSourceUrl } = await import("@clip/sdk");
    const mapped = items.map((it) => {
      const sourceUrl =
        it.sourceUrl ||
        (it.localPath ? toClipLocalSourceUrl(it.localPath) : "");
      if (!sourceUrl) throw new Error(`episodeNo=${it.episodeNo} 缺少 localPath/sourceUrl`);
      return {
        episodeNo: Number(it.episodeNo),
        sourceUrl,
        title: it.title,
        filename: it.filename ?? it.localPath?.split(/[/\\]/).pop(),
      };
    });
    const results = await store.ensureEpisodesForMix(req.params.dramaId, mapped, {
      dramaMeta: req.body?.dramaMeta,
      deviceId: headerOne(req.headers["x-device-id"]),
    });
    return {
      dramaId: req.params.dramaId,
      episodes: results.map((r) => ({
        episode: r.episode,
        asrReady: r.asrReady,
        reusedAsr: r.reusedAsr,
      })),
      asrReadyCount: results.filter((r) => r.asrReady).length,
      needAsrCount: results.filter((r) => !r.asrReady).length,
    };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{
  Params: { dramaId: string };
  Body: { episodeIds?: string[]; packageTaskId?: string };
}>(
  "/agent/dramas/:dramaId/create-mix-task",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(
      store,
      headerOne(req.headers["x-device-id"]),
      headerOne(req.headers["x-device-token"]),
    );
    if (authErr) return reply.code(401).send({ error: authErr });
    try {
      const task = await store.createDramaMixTask(req.params.dramaId, req.body?.episodeIds, {
        packageTaskId: req.body?.packageTaskId,
        deviceId: headerOne(req.headers["x-device-id"]),
      });
      return { ok: true, taskId: task.taskId, task };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

app.get<{ Params: { id: string }; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/tasks/:id/mix-segments",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    try {
      const segments = await store.getMixSegmentsForTask(req.params.id);
      return { taskId: req.params.id, segments };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

/** 成片预览：基本信息 + 映射到成片时间轴的台词 */
app.get<{
  Params: { id: string };
  Querystring: { path?: string; fileName?: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/output-inspect", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  try {
    const data = await store.inspectTaskOutput(req.params.id, {
      path: req.query.path,
      fileName: req.query.fileName,
    });
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = /not found|缺少|无法匹配|没有成片/i.test(msg) ? 404 : 400;
    return reply.code(code).send({ error: msg });
  }
});

app.get<{ Params: { id: string }; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/tasks/:id/asr-result",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    const record = await store.getAsrResult(req.params.id);
    if (!record) return reply.code(404).send({ error: "asr result not found" });
    return { asrResult: record };
  },
);

/** 本地索引缺失时：按 dramaId+episodeNo（或 deviceId+episodeNo / episodeId）回落查库 */
app.get<{
  Querystring: { dramaId?: string; episodeId?: string; episodeNo?: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/asr-result/resolve", async (req, reply) => {
  const deviceId = req.headers["x-device-id"];
  const authErr = await requireDeviceAuth(store, deviceId, req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });

  const dramaId = req.query.dramaId?.trim() || undefined;
  const episodeId = req.query.episodeId?.trim() || undefined;
  const episodeNoRaw = req.query.episodeNo?.trim();
  const episodeNo =
    episodeNoRaw != null && episodeNoRaw !== "" && Number.isFinite(Number(episodeNoRaw))
      ? Math.trunc(Number(episodeNoRaw))
      : undefined;

  const hasDramaEp = !!dramaId && episodeNo != null;
  const hasDeviceEp = !!deviceId && episodeNo != null;
  const hasEpisodeId = !!episodeId;
  if (!hasDramaEp && !hasDeviceEp && !hasEpisodeId) {
    return reply.code(400).send({
      error: "需要 dramaId+episodeNo，或 episodeId，或可解析的 episodeNo（将按当前设备回落）",
    });
  }

  const record = await store.resolveAsrResult({
    dramaId,
    episodeId,
    episodeNo,
    // 有 dramaId 时优先跨设备同剧同集；仅有集号时限定本机，避免串剧
    deviceId: hasDramaEp || hasEpisodeId ? undefined : deviceId,
  });
  if (!record) return reply.code(404).send({ error: "asr result not found" });
  return {
    asrResult: record,
    resolvedBy: hasEpisodeId ? "episodeId" : hasDramaEp ? "dramaId+episodeNo" : "deviceId+episodeNo",
  };
});

/** 成片真 ASR 回落：按本地路径 / 父任务+文件名 */
app.get<{
  Querystring: { path?: string; parentTaskId?: string; fileName?: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/asr-result/resolve-output", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });

  const pathHint = req.query.path?.trim() || "";
  const parentTaskId = req.query.parentTaskId?.trim() || undefined;
  const fileName =
    req.query.fileName?.trim() ||
    (pathHint ? pathHint.replace(/\\/g, "/").split("/").pop() || "" : "");

  if (!pathHint && !fileName) {
    return reply.code(400).send({ error: "需要 path，或 fileName（可选 parentTaskId）" });
  }

  const { toClipLocalSourceUrl } = await import("@clip/sdk");
  let record = pathHint
    ? await store.resolveOutputAsrResult({ sourceUrl: toClipLocalSourceUrl(pathHint) })
    : null;
  let resolvedBy = pathHint ? "sourceUrl" : "";
  if (!record && parentTaskId && fileName) {
    record = await store.resolveOutputAsrResult({ parentTaskId, fileName });
    resolvedBy = "parentTaskId+fileName";
  }
  if (!record && fileName) {
    record = await store.resolveOutputAsrResult({ fileName });
    resolvedBy = "fileName";
  }
  if (!record) return reply.code(404).send({ error: "output asr result not found" });
  return { asrResult: record, resolvedBy };
});

app.post<{
  Params: { id: string };
  Body: { phase: string; episodeCount?: number };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/package-phase", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  await store.updatePackagePhase(req.params.id, req.body.phase as import("@clip/sdk").DramaPackagePhase, {
    episodeCount: req.body.episodeCount,
  });
  return { ok: true };
});

app.post<{
  Params: { id: string };
  Body: {
    mixTaskId: string;
    processingStartedAt?: string;
    totalWallTimeSec?: number;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/package-complete", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!req.body?.mixTaskId) {
    return reply.code(400).send({ error: "mixTaskId required" });
  }
  const timing =
    req.body.processingStartedAt && req.body.totalWallTimeSec != null
      ? {
          processingStartedAt: req.body.processingStartedAt,
          totalWallTimeSec: req.body.totalWallTimeSec,
        }
      : undefined;
  const task = await store.completePackageTask(req.params.id, req.body.mixTaskId, timing);
  if (!task) return reply.code(404).send({ error: "package task not found" });
  return { ok: true, task };
});

app.post<{
  Params: { id: string };
  Body: { segments: AsrSegment[]; rawSegments?: RawAsrSegment[]; rawSegmentCount?: number };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/asr-result", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  if (!Array.isArray(req.body?.segments)) {
    return reply.code(400).send({ error: "segments array required" });
  }

  const taskId = req.params.id;
  const { subtitleUrl, subtitlesJsonUrl } = buildAsrSubtitleUrls(API_PUBLIC_BASE, taskId);

  const asrRecord = await store.saveAsrResult(taskId, req.body.segments, req.body.rawSegmentCount, {
    rawSegments: req.body.rawSegments,
    subtitleUrl,
    subtitlesJsonUrl,
  });

  void oss.deleteAsrArtifacts(taskId).then((removed) => {
    if (removed.length) {
      req.log.info({ taskId, removed }, "purged legacy ASR artifact files");
    }
  });

  const { segments: _s, rawSegments: _r, ...asrSummary } = asrRecord;

  return {
    ok: true,
    segmentCount: req.body.segments.length,
    subtitleUrl,
    subtitlesJsonUrl,
    asrResult: asrSummary,
  };
});

app.post<{
  Body: { taskId: string; segments: AsrSegment[]; round?: number };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/api/v1/clip/plan", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });

  const task = await store.getTaskForAgent(req.body.taskId);
  const taskKind = task?.taskKind ?? "single";
  const isDramaMix = taskKind === "drama_mix";
  const round = req.body.round ?? 1;

  // remix_replica / drama_package 等任务不走本地方案生成，旧版 Agent 误调用时直接拒绝
  if (taskKind === "remix_replica" || taskKind === "drama_package") {
    return reply.code(400).send({
      error: `任务类型 ${taskKind} 不需要调用 /api/v1/clip/plan，请升级 Agent 版本`,
      taskId: req.body.taskId,
      taskKind,
    });
  }

  // 接口整体超时保护：plan 生成最长 150s；超时时返回兜底方案，避免 nginx 502 导致 Agent 失败
  const PLAN_HANDLER_TIMEOUT_MS = 150_000;
  const planPromise: Promise<ClipPlan | ClipPlanBatch> = isDramaMix
    ? store.generatePlanBatch(req.body.taskId, req.body.segments, round)
    : store.generatePlan(req.body.taskId, req.body.segments);

  let result: ClipPlan | ClipPlanBatch | undefined;
  try {
    result = await Promise.race([
      planPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("plan generation timeout")), PLAN_HANDLER_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "plan generation timeout") {
      console.warn(
        `[api/v1/clip/plan] 生成方案超时(${PLAN_HANDLER_TIMEOUT_MS}ms)，返回兜底方案 task=${req.body.taskId} round=${round}`,
      );
      result = buildFallbackPlanBatch(req.body.segments, round, isDramaMix ? 10 : 1);
    } else {
      throw err;
    }
  }

  if (!isDramaMix) {
    // 单素材任务原返回 ClipPlan；兜底 batch 只有一条 plan，取第一条
    const batch = result as ClipPlanBatch;
    return batch.plans?.[0] ?? (result as ClipPlan);
  }
  return result as ClipPlanBatch;
});

/** 兜底方案：按 segments 顺序简单拼接，保证至少有一条可渲染方案 */
function buildFallbackPlanBatch(segments: AsrSegment[], round: number, totalRounds: number): ClipPlanBatch {
  const clips = segments
    .filter((s) => s.segmentId && (s.endMs ?? 0) > (s.startMs ?? 0))
    .slice(0, 20)
    .map((s) => ({
      segmentId: s.segmentId,
      throughSegmentId: s.segmentId,
      reason: "兜底拼接",
      role: "context" as const,
      episodeId: s.episodeId,
      trimStartMs: s.startMs,
      trimEndMs: s.endMs,
    }));

  const estimatedDurationSec = Math.max(
    1,
    clips.reduce((sum, c) => sum + ((c.trimEndMs ?? 0) - (c.trimStartMs ?? 0)) / 1000, 0),
  );

  const plan: ClipPlan = {
    version: "2.0",
    clips,
    output: { ratio: "9:16", maxDurationSec: 600, addHead: false, addTail: false, subtitle: true },
    strategy: "fallback_concat",
    durationTier: "M",
    targetDurationSec: estimatedDurationSec,
    estimatedDurationSec,
    narrativeLine: "服务端超时兜底：按 ASR 片段顺序拼接",
    confidence: 0.1,
  };

  return {
    version: "2.0",
    round,
    totalRounds,
    plansPerRound: 1,
    plans: [plan],
    clipSelectionMode: "skills",
  };
}

app.post<{
  Params: { id: string };
  Body: {
    outputUrl?: string;
    outputUrls?: string[];
    mixRenders?: MixRenderRecord[];
    processingStartedAt?: string;
    totalWallTimeSec?: number;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/complete", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });

  const taskId = req.params.id;
  const timing =
    req.body?.processingStartedAt && req.body.totalWallTimeSec != null
      ? {
          processingStartedAt: req.body.processingStartedAt,
          totalWallTimeSec: Number(req.body.totalWallTimeSec),
        }
      : undefined;

  if (req.body?.mixRenders?.length) {
    await store.completeMixTask(taskId, req.body.mixRenders, timing);
    const asrTaskIds = [taskId, ...(await store.getEpisodeAsrTaskIdsForMix(taskId))];
    for (const id of [...new Set(asrTaskIds)]) {
      const removed = await oss.deleteAsrArtifacts(id);
      if (removed.length) {
        console.log(`[oss] purged ASR artifacts for ${id}: ${removed.join(", ")}`);
      }
    }
    return {
      ok: true,
      outputUrl: req.body.mixRenders[0]!.outputUrl,
      outputUrls: req.body.mixRenders.map((r) => r.outputUrl),
      mixRenders: req.body.mixRenders,
    };
  }

  if (!req.body?.outputUrl) {
    return reply.code(400).send({ error: "outputUrl or mixRenders required" });
  }
  await store.completeTask(taskId, req.body.outputUrl, timing);
  const removed = await oss.deleteAsrArtifacts(taskId);
  if (removed.length) {
    console.log(`[oss] purged ASR artifacts for ${taskId}: ${removed.join(", ")}`);
  }
  return { ok: true, outputUrl: req.body.outputUrl };
});

/** 素材库推 TOS 后追加/升级单条产出 URL（写入 clip_task_output，不整表覆盖） */
app.post<{
  Params: { id: string };
  Body: { outputUrl?: string; localOutputPath?: string; filename?: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/outputs", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const outputUrl = String(req.body?.outputUrl || "").trim();
  if (!outputUrl) return reply.code(400).send({ error: "outputUrl required" });
  try {
    const result = await store.appendTaskOutput(req.params.id, {
      outputUrl,
      localOutputPath: req.body?.localOutputPath,
      filename: req.body?.filename,
    });
    return { ok: true, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/task not found/i.test(msg)) return reply.code(404).send({ error: msg });
    return reply.code(400).send({ error: msg });
  }
});

/** 无父任务时登记 TOS 成片为新的已完成任务（写入 clip_task_output） */
app.post<{
  Body: {
    outputUrl?: string;
    localOutputPath?: string;
    filename?: string;
    dramaTitle?: string;
    dramaId?: string;
  };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/outputs/register-upload", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  const outputUrl = String(req.body?.outputUrl || "").trim();
  if (!outputUrl) return reply.code(400).send({ error: "outputUrl required" });
  try {
    const result = await store.registerUploadedOutput({
      outputUrl,
      localOutputPath: req.body?.localOutputPath,
      filename: req.body?.filename,
      dramaTitle: req.body?.dramaTitle,
      dramaId: req.body?.dramaId,
      claimedBy: headerOne(req.headers["x-device-id"]),
    });
    return { ok: true, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ error: msg });
  }
});

app.post<{
  Params: { id: string };
  Body: { message: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/tasks/:id/fail", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  await store.failTask(req.params.id, req.body.message);
  return { ok: true };
});

app.post<{ Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/oss/upload",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });

    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      let taskId = "";
      let filename = "output.mp4";

      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "taskId") taskId = String(part.value);
          if (part.fieldname === "filename") filename = String(part.value);
          continue;
        }
        if (!taskId) {
          part.file.resume();
          continue;
        }
        if (part.filename) filename = part.filename;

        req.log.info({ taskId, filename }, "oss multipart upload started");
        const objectKey = await oss.saveStreamUpload(taskId, filename, part.file);
        req.log.info({ taskId, objectKey }, "oss multipart upload done");
        return { ok: true, objectKey, url: oss.toPublicUrl(API_PUBLIC_BASE, objectKey), destination: "server" };
      }

      return reply.code(400).send({ error: "taskId and file required" });
    }

    const jsonBody = req.body as { taskId?: string; filename?: string; contentBase64?: string };
    if (!jsonBody.taskId || !jsonBody.contentBase64) {
      return reply.code(400).send({ error: "taskId and contentBase64 required" });
    }

    const objectKey = await oss.saveBase64Upload(
      jsonBody.taskId,
      jsonBody.filename ?? "output.mp4",
      jsonBody.contentBase64,
    );
    return { ok: true, objectKey, url: oss.toPublicUrl(API_PUBLIC_BASE, objectKey), destination: "server" };
  },
);

app.get("/oss/*", async (req, reply) => {
  const objectKey = decodeURIComponent(req.url.replace(/^\/oss\//, "").split("?")[0] ?? "");
  if (!objectKey || !oss.exists(objectKey)) return reply.code(404).send({ error: "object not found" });
  const filePath = oss.resolvePath(objectKey);
  const { size } = statSync(filePath);
  const contentType = objectKey.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return reply.code(416).header("content-range", `bytes */${size}`).send({ error: "invalid range" });
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return reply.code(416).header("content-range", `bytes */${size}`).send({ error: "range not satisfiable" });
    }
    const safeEnd = Math.min(end, size - 1);
    return reply
      .code(206)
      .header("content-type", contentType)
      .header("accept-ranges", "bytes")
      .header("content-range", `bytes ${start}-${safeEnd}/${size}`)
      .header("content-length", String(safeEnd - start + 1))
      .send(createReadStream(filePath, { start, end: safeEnd }));
  }
  return reply
    .header("content-type", contentType)
    .header("accept-ranges", "bytes")
    .header("content-length", String(size))
    .send(createReadStream(filePath));
});

app.post<{ Body: TelemetryBatch; Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/telemetry/events",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    await store.ingestTelemetry(req.body);
    return { ok: true };
  },
);

app.get<{
  Querystring: { version: string; platform?: string };
  Headers: { "x-device-id"?: string; "x-device-token"?: string };
}>("/agent/updates/check", async (req, reply) => {
  const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
  if (authErr) return reply.code(401).send({ error: authErr });
  return store.checkUpdates(req.query.version, req.query.platform ?? "win-x64-4060");
});

app.get<{ Headers: { "x-device-id"?: string; "x-device-token"?: string } }>(
  "/agent/models/manifest",
  async (req, reply) => {
    const authErr = await requireDeviceAuth(store, req.headers["x-device-id"], req.headers["x-device-token"]);
    if (authErr) return reply.code(401).send({ error: authErr });
    return modelCdn.buildManifest(API_PUBLIC_BASE);
  },
);

app.get("/cdn/models/manifest.json", async () => modelCdn.buildManifest(API_PUBLIC_BASE));

app.get<{ Params: { model: string; file: string } }>(
  "/cdn/models/:model/:file",
  async (req, reply) => {
    const objectKey = `${req.params.model}/${req.params.file}`;
    if (!modelCdn.exists(objectKey)) {
      return reply.code(404).send({ error: "model not found" });
    }
    return reply.send(modelCdn.createReadStream(objectKey));
  },
);

// ── Admin APIs ──────────────────────────────────────────────

app.get("/admin/api/stats/devices/daily", async (req) => {
  const q = req.query as { date?: string; limit?: string; offset?: string };
  const date = q.date ?? new Date().toISOString().slice(0, 10);
  const { limit, offset } = parsePagination(q);
  const page = await store.listDailyStatsPage(date, limit, offset);
  return { date, ...page };
});

app.get<{ Params: { id: string }; Querystring: { date?: string; limit?: string; offset?: string } }>(
  "/admin/api/stats/devices/:id/timeline",
  async (req) => {
    const date = req.query.date ?? new Date().toISOString().slice(0, 10);
    const { limit, offset } = parsePagination(req.query);
    return await store.getDeviceTimelinePage(req.params.id, date, limit, offset);
  },
);

// Agent 历史表现聚合（任务数/成功率/耗时分位/活跃），days 缺省为全部历史
app.get<{ Querystring: { days?: string } }>("/admin/api/stats/agents/summary", async (req) => {
  const days = Number(req.query?.days);
  return { agents: await store.agentSummary(Number.isFinite(days) && days > 0 ? days : undefined) };
});

// 近 N 天任务趋势（每日总量/成功/失败）
app.get<{ Querystring: { days?: string } }>("/admin/api/stats/tasks/trend", async (req) => {
  const days = Number(req.query?.days);
  return { trend: await store.taskTrend(Number.isFinite(days) && days > 0 ? days : 14) };
});

app.get("/admin/api/devices", async (req) => {
  const q = req.query as { limit?: string; offset?: string; q?: string; onlineOnly?: string };
  const { limit, offset } = parsePagination(q);
  return store.listDevicesPage({
    limit,
    offset,
    q: q.q,
    onlineOnly: q.onlineOnly === "true" || q.onlineOnly === "1",
  });
});

app.get<{ Params: { id: string } }>("/admin/api/devices/:id/override", async (req) => {
  return store.getDeviceOverride(req.params.id) ?? {};
});

app.put<{
  Params: { id: string };
  Body: { render?: RenderConfig; asrRuleSetId?: string; services?: AgentServicesConfig };
}>("/admin/api/devices/:id/config-overrides", async (req) => {
  store.setDeviceOverride(req.params.id, req.body);
  return { ok: true };
});

app.get("/admin/api/agent-releases", async () => {
  const manifest = store.getAgentReleaseManifest();
  const objectKey = agentReleaseObjectKey(manifest.version);
  const artifactReady = oss.exists(objectKey);
  return {
    manifest: {
      ...manifest,
      objectKey,
      artifactReady,
      downloadUrl: artifactReady ? oss.toPublicUrl(API_PUBLIC_BASE, objectKey) : manifest.downloadUrl,
    },
  };
});

app.put<{
  Body: {
    version: string;
    downloadUrl: string;
    sha256: string;
    mandatory?: boolean;
    releaseNotes?: string;
  };
}>("/admin/api/agent-releases", async (req) => {
  const manifest = await store.publishAgentRelease(req.body);
  return { ok: true, manifest };
});

app.post("/admin/api/agent-releases/upload", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "zip file required" });
  const versionField = file.fields.version;
  const version =
    (typeof versionField === "object" && versionField && "value" in versionField
      ? String(versionField.value)
      : "") || `0.3.0-${Date.now()}`;
  const notesField = file.fields.releaseNotes;
  const releaseNotes =
    typeof notesField === "object" && notesField && "value" in notesField
      ? String(notesField.value)
      : "";
  const mandatoryField = file.fields.mandatory;
  const mandatory =
    typeof mandatoryField === "object" && mandatoryField && "value" in mandatoryField
      ? String(mandatoryField.value) === "true"
      : false;

  const objectKey = `releases/agent/${version}/clip-agent-win-x64.zip`;
  const saved = await oss.saveStreamWithSha256(objectKey, file.file);
  const downloadUrl = oss.toPublicUrl(API_PUBLIC_BASE, saved.objectKey);

  // 可选：上传增量包
  let incrementalUrl: string | undefined;
  let incrementalSha256: string | undefined;
  let incrementalSizeBytes: number | undefined;
  const incrementalField = file.fields.incrementalFile;
  if (incrementalField) {
    const incrementalFile = typeof incrementalField === "object" && "file" in incrementalField
      ? incrementalField.file
      : null;
    if (incrementalFile) {
      const incObjectKey = `releases/agent/${version}/clip-agent-win-x64-incremental.zip`;
      const incSaved = await oss.saveStreamWithSha256(incObjectKey, incrementalFile);
      incrementalUrl = oss.toPublicUrl(API_PUBLIC_BASE, incSaved.objectKey);
      incrementalSha256 = incSaved.sha256;
      incrementalSizeBytes = incSaved.sizeBytes;
    }
  }

  const manifest = await store.publishAgentRelease({
    version,
    downloadUrl,
    sha256: saved.sha256,
    mandatory,
    releaseNotes,
    incrementalUrl,
    incrementalSha256,
  });
  return {
    ok: true,
    manifest,
    sizeBytes: saved.sizeBytes,
    objectKey: saved.objectKey,
    incremental: incrementalSizeBytes ? { sizeBytes: incrementalSizeBytes } : undefined,
  };
});

app.get("/admin/api/tasks", async (req) => {
  const q = req.query as {
    status?: string;
    taskKind?: string;
    dramaId?: string;
    deviceId?: string;
    limit?: string;
    offset?: string;
  };
  const { limit, offset } = parsePagination(q);
  const page = await store.listTasksPage({
    status: q.status as ClipTask["status"] | undefined,
    taskKind: q.taskKind as ClipTask["taskKind"],
    dramaId: q.dramaId,
    claimedBy: q.deviceId,
    limit,
    offset,
  });
  // 附带 deviceId -> machineId 映射，前端展示执行服务器用（一次查询，避免 N+1）
  const deviceNames = await store.getDeviceNameMap(
    page.tasks.map((t) => t.claimedBy).filter((v): v is string => Boolean(v)),
  );
  return { ...page, deviceNames };
});

/** 按剧聚合的任务看板：每剧一张卡，含三段管线阶段进度与分集明细 */
app.get("/admin/api/tasks/board", async (req) => {
  const q = req.query as {
    aggStatus?: string;
    deviceId?: string;
    limit?: string;
    offset?: string;
  };
  const { limit, offset } = parsePagination(q);
  const aggStatus =
    q.aggStatus === "running" || q.aggStatus === "completed" || q.aggStatus === "failed"
      ? q.aggStatus
      : undefined;
  return store.taskBoard({
    aggStatus,
    claimedBy: q.deviceId,
    limit,
    offset,
  });
});

app.get<{ Params: { id: string } }>("/admin/api/tasks/:id", async (req, reply) => {
  const task = await store.getTask(req.params.id);
  if (!task) return reply.code(404).send({ error: "task not found" });
  return task;
});

app.get("/admin/api/asr-results", async (req) => {
  const q = req.query as {
    dramaId?: string;
    episodeId?: string;
    deviceId?: string;
    taskKind?: string;
    limit?: string;
    offset?: string;
  };
  const { limit, offset } = parsePagination(q);
  return store.listAsrResults({
    dramaId: q.dramaId,
    episodeId: q.episodeId,
    deviceId: q.deviceId,
    taskKind: q.taskKind as ClipTask["taskKind"],
    limit,
    offset,
  });
});

app.get<{ Params: { id: string } }>("/admin/api/asr-results/:id", async (req, reply) => {
  const record = await store.getAsrResult(req.params.id);
  if (!record) return reply.code(404).send({ error: "asr result not found" });
  return { asrResult: record };
});

app.get<{ Params: { id: string } }>("/admin/api/asr-results/:id/subtitles.srt", async (req, reply) => {
  const record = await store.getAsrResult(req.params.id);
  if (!record) return reply.code(404).send({ error: "asr result not found" });
  return reply
    .header("content-type", "application/x-subrip; charset=utf-8")
    .header("content-disposition", `attachment; filename="${req.params.id}.srt"`)
    .send(segmentsToSrt(record.segments));
});

app.get<{ Params: { id: string } }>("/admin/api/asr-results/:id/subtitles.json", async (req, reply) => {
  const record = await store.getAsrResult(req.params.id);
  if (!record) return reply.code(404).send({ error: "asr result not found" });
  return reply
    .header("content-type", "application/json; charset=utf-8")
    .header("content-disposition", `attachment; filename="${req.params.id}-subtitles.json"`)
    .send({
      segments: record.segments,
      rawSegments: record.rawSegments,
      rawSegmentCount: record.rawSegmentCount,
      savedAt: record.savedAt,
    });
});

app.post<{
  Body: {
    sourceUrl: string;
    templateId?: string;
    dramaId?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
  };
}>("/admin/api/tasks", async (req) => {
  const task = await store.createTask(req.body);
  return { ok: true, task };
});

app.post<{ Body: { title?: string; filename?: string } }>(
  "/admin/api/drama-packages/tos-upload-policy",
  async (req, reply) => {
    const title = req.body?.title?.trim();
    const filename = req.body?.filename?.trim();
    if (!title) return reply.code(400).send({ error: "title required" });
    if (!filename) return reply.code(400).send({ error: "filename required" });
    try {
      assertZipFilename(filename);
      const global = store.getGlobalConfig();
      const tos = requireTosForPackageUpload(global.render as RenderConfig | undefined);
      const allocated = await store.allocatePackageName(title);
      const policy = createDramaPackageTosUploadPolicy(tos, allocated);
      return { ok: true, ...policy };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

app.post<{ Body: { filename?: string } }>(
  "/admin/api/media/tos-upload-policy",
  async (req, reply) => {
    const filename = req.body?.filename?.trim();
    if (!filename) return reply.code(400).send({ error: "filename required" });
    try {
      assertMediaFilename(filename);
      const global = store.getGlobalConfig();
      const tos = requireTosForPackageUpload(global.render as RenderConfig | undefined);
      const policy = createMediaTosUploadPolicy(tos, filename);
      return { ok: true, ...policy };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

app.post<{
  Body: {
    title?: string;
    sourceUrl?: string;
    filename?: string;
    contentBase64?: string;
    templateId?: string;
    asrRuleSetId?: string;
    expectedEpisodeCount?: number;
    packageObjectKey?: string;
    packageName?: string;
    dedupSeq?: number;
    synopsis?: string;
    /** 与 sourceUrl 同义，完整 zip 下载 URL */
    downloadUrl?: string;
    packages?: Array<{
      title: string;
      sourceUrl: string;
      synopsis?: string;
      templateId?: string;
      asrRuleSetId?: string;
      expectedEpisodeCount?: number;
    }>;
  };
}>("/admin/api/drama-packages", async (req, reply) => {
  if (Array.isArray(req.body?.packages) && req.body.packages.length > 0) {
    const settled = await Promise.allSettled(
      req.body.packages.map((item) => createDramaPackageEntry(item)),
    );
    const results: Array<Record<string, unknown>> = [];
    const errors: Array<{ title: string; error: string }> = [];
    settled.forEach((outcome, i) => {
      const item = req.body!.packages![i]!;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        errors.push({
          title: item.title ?? "",
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    });
    if (results.length === 0) {
      return reply.code(400).send({ error: "batch create failed", errors });
    }
    return { ok: true, results, errors };
  }

  if (!req.body?.title?.trim()) {
    return reply.code(400).send({ error: "title required" });
  }

  try {
    return {
      ok: true,
      ...(await createDramaPackageEntry({
        ...req.body,
        title: req.body.title.trim(),
        sourceUrl: req.body.sourceUrl ?? req.body.downloadUrl,
      })),
    };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function createDramaPackageEntry(body: {
  title: string;
  sourceUrl?: string;
  filename?: string;
  contentBase64?: string;
  templateId?: string;
  asrRuleSetId?: string;
  expectedEpisodeCount?: number;
  packageObjectKey?: string;
  packageName?: string;
  dedupSeq?: number;
  synopsis?: string;
  dramaType?: import("@clip/sdk").DramaIntakeType;
}): Promise<{
  taskId: string;
  sourceUrl: string;
  objectKey: string;
  packageName: string;
  task: ClipTask;
}> {
  const title = body.title.trim();
  const externalUrl = body.sourceUrl?.trim();
  let objectKey = body.packageObjectKey?.trim() ?? "";
  let packageName: string;
  let dedupSeq: number;
  let sourceUrl: string;
  const prePackageName = body.packageName?.trim();

  // 管理台 TOS 直传：预签名阶段已分配包名/objectKey，不再重复 allocate
  if (externalUrl && objectKey && prePackageName) {
    if (!/^https?:\/\//i.test(externalUrl)) {
      throw new Error("sourceUrl must be an http(s) zip download link");
    }
    packageName = prePackageName;
    if (!/\.zip$/i.test(packageName)) {
      throw new Error("package must be a .zip file");
    }
    const match = packageName.match(/-(\d{3})\.zip$/i);
    dedupSeq =
      typeof body.dedupSeq === "number" && body.dedupSeq > 0
        ? body.dedupSeq
        : match
          ? Number(match[1])
          : 1;
    sourceUrl = externalUrl;
  } else if (externalUrl) {
    if (!/^https?:\/\//i.test(externalUrl)) {
      throw new Error("sourceUrl must be an http(s) zip download link");
    }
    const allocated = await store.allocatePackageName(title);
    packageName = packageNameFromUrl(externalUrl) ?? allocated.packageName;
    dedupSeq = allocated.dedupSeq;
    if (!/\.zip$/i.test(packageName)) {
      throw new Error("压缩包链接须指向 .zip 文件");
    }
    objectKey = objectKey || "";
    sourceUrl = externalUrl;
  } else if (objectKey) {
    packageName = objectKey.split("/").pop() ?? objectKey;
    const match = packageName.match(/-(\d{3})\.zip$/i);
    dedupSeq = match ? Number(match[1]) : 1;
    sourceUrl = oss.toPublicUrl(API_PUBLIC_BASE, objectKey);
  } else {
    const { filename, contentBase64 } = body;
    if (!filename || !contentBase64) {
      throw new Error("sourceUrl, packageObjectKey, or filename+contentBase64 required");
    }
    const allocated = await store.allocatePackageName(title);
    packageName = allocated.packageName;
    dedupSeq = allocated.dedupSeq;
    objectKey = await oss.savePackageUpload(packageName, contentBase64);
    sourceUrl = oss.toPublicUrl(API_PUBLIC_BASE, objectKey);
  }

  warnIfLocalhostDownloadUrl(sourceUrl, "create drama package task");

  const task = await store.createDramaPackageTask({
    title,
    sourceUrl,
    packageObjectKey: objectKey,
    packageName,
    dedupSeq,
    templateId: body.templateId,
    asrRuleSetId: body.asrRuleSetId,
    expectedEpisodeCount: body.expectedEpisodeCount,
    synopsis: body.synopsis?.trim(),
    dramaType: body.dramaType,
  });
  return { taskId: task.taskId, sourceUrl, objectKey, packageName, task };
}

function packageNameFromUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name && /\.zip$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

app.post<{ Params: { id: string } }>("/admin/api/tasks/:id/retry", async (req, reply) => {
  try {
    const task = await store.retryTask(req.params.id);
    return { ok: true, task };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch<{
  Params: { id: string };
  Body: { priority?: boolean };
}>("/admin/api/tasks/:id/priority", async (req, reply) => {
  if (typeof req.body?.priority !== "boolean") {
    return reply.code(400).send({ error: "priority must be boolean" });
  }
  try {
    const task = await store.setDramaPackagePriority(req.params.id, req.body.priority);
    return { ok: true, task };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete<{ Params: { id: string } }>("/admin/api/tasks/:id", async (req, reply) => {
  try {
    const deletedIds = await store.deleteTask(req.params.id);
    if (!deletedIds.length) {
      return reply.code(404).send({ error: "task not found" });
    }
    return { ok: true, deletedIds };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put<{ Params: { id: string }; Body: ClipPlan }>("/admin/api/tasks/:id/plan", async (req) => {
  const plan = await store.updateTaskPlan(req.params.id, req.body);
  return { ok: true, plan };
});

app.post<{ Body: { sourceUrl?: string } }>("/admin/api/tasks/reset-demo", async (req) => {
  const sourceUrl = req.body?.sourceUrl ?? oss.toPublicUrl(API_PUBLIC_BASE, "sources/demo.mp4");
  await store.resetDemoTask(sourceUrl);
  return { ok: true, sourceUrl };
});

app.get("/admin/api/config/global", async () => store.getGlobalConfig());

app.put<{
  Body: {
    render?: RenderConfig;
    configVersion?: string;
    asrRuntime?: Partial<AsrRuntimeConfig>;
    services?: AgentServicesConfig;
  };
}>("/admin/api/config/global", async (req) => {
  await store.updateGlobalProfile(req.body ?? {});
  return store.getGlobalConfig();
});

app.get("/admin/api/stickers/templates", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const repoRoot = process.env.CLIP_REPO_ROOT ?? join(process.cwd(), "..", "..");
  const candidates = [
    join(repoRoot, "apps", "clip-agent", "assets", "stickers", "stickers.json"),
    join(process.cwd(), "apps", "clip-agent", "assets", "stickers", "stickers.json"),
    join(process.cwd(), "..", "clip-agent", "assets", "stickers", "stickers.json"),
  ];
  for (const manifestPath of candidates) {
    if (existsSync(manifestPath)) {
      const content = await readFile(manifestPath, "utf-8");
      return JSON.parse(content);
    }
  }
  return { version: "0.0.0", templates: [] };
});

app.get("/admin/api/fonts", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { existsSync, readFileSync, statSync } = await import("node:fs");
  const repoRoot = process.env.CLIP_REPO_ROOT ?? join(process.cwd(), "..", "..");
  const candidates = [
    join(repoRoot, "apps", "clip-agent", "assets", "fonts", "fonts.json"),
    join(process.cwd(), "apps", "clip-agent", "assets", "fonts", "fonts.json"),
    join(process.cwd(), "..", "clip-agent", "assets", "fonts", "fonts.json"),
  ];

  function isRealFontFile(filePath: string): boolean {
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return false;
      const head = readFileSync(filePath).slice(0, 64).toString("utf-8");
      return !head.startsWith("version https://git-lfs.github.com/spec/v1");
    } catch {
      return false;
    }
  }

  for (const manifestPath of candidates) {
    if (existsSync(manifestPath)) {
      const content = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(content) as {
        version?: string;
        fonts?: Array<{ id: string; name: string; family: string; file: string; license?: string; licenseScope?: string }>;
      };
      const fontsDir = join(manifestPath, "..");
      const whitelist: Array<{
        value: string;
        label: string;
        source: "whitelist";
        license?: string;
        licenseScope?: string;
        fileUrl?: string;
      }> = (manifest.fonts ?? []).map((f) => {
        const encodedFile = encodeURIComponent(f.file);
        const fileUrl = `/admin/assets/fonts/${encodedFile}`;
        return {
          value: f.family,
          label: `${f.name}（${f.license ?? "商用字体"}）`,
          source: "whitelist" as const,
          license: f.license,
          licenseScope: f.licenseScope,
          fileUrl,
        };
      });
      // 验证字体文件真实可用；若不存在或为 Git LFS 指针，则去掉 fileUrl，避免前端 404/500
      for (const f of whitelist) {
        if (f.fileUrl) {
          const filePath = join(fontsDir, (manifest.fonts ?? []).find((x) => x.family === f.value)?.file ?? "");
          if (!isRealFontFile(filePath)) {
            f.fileUrl = undefined;
          }
        }
      }
      // 只把真实有字体文件的字体暴露给前端选择
      const availableWhitelist = whitelist.filter((f) => f.fileUrl);
      return {
        version: manifest.version ?? "0.0.0",
        whitelist: availableWhitelist,
        // 系统字体备选，与前端原有 FONT_OPTIONS 保持一致，便于降级
        systemFallbacks: [
          { value: "Microsoft YaHei", label: "Microsoft YaHei（微软雅黑）" },
          { value: "SimHei", label: "SimHei（黑体）" },
          { value: "SimSun", label: "SimSun（宋体）" },
          { value: "SimKai", label: "SimKai（楷体）" },
          { value: "FangSong", label: "FangSong（仿宋）" },
          { value: "DengXian", label: "DengXian（等线）" },
          { value: "Microsoft JhengHei", label: "Microsoft JhengHei（微软正黑体）" },
          { value: "Noto Sans SC", label: "Noto Sans SC" },
          { value: "Noto Serif SC", label: "Noto Serif SC" },
          { value: "Arial", label: "Arial" },
          { value: "HYZhongHeiTi", label: "HYZhongHeiTi（汉仪中黑体）" },
        ],
      };
    }
  }
  return { version: "0.0.0", whitelist: [], systemFallbacks: [] };
});

app.get<{ Params: { file: string } }>("/admin/assets/fonts/:file", async (req, reply) => {
  const { join, resolve, normalize } = await import("node:path");
  const { existsSync, createReadStream, readFileSync, statSync } = await import("node:fs");
  const repoRoot = process.env.CLIP_REPO_ROOT ?? join(process.cwd(), "..", "..");
  // 候选目录：优先运行目录的真实字体，再回退仓库目录（可能因 Git LFS 只有指针）
  const candidates = [
    "D:\\ClipAgent\\assets\\fonts",
    join(repoRoot, "apps", "clip-agent", "assets", "fonts"),
    join(process.cwd(), "apps", "clip-agent", "assets", "fonts"),
    join(process.cwd(), "..", "clip-agent", "assets", "fonts"),
  ];

  const fileParam = decodeURIComponent(req.params.file).trim();
  if (!fileParam) {
    return reply.code(400).send({ error: "file parameter required" });
  }
  // 防止目录穿越：只取文件名，并限制在 fontsDir 下
  const fileName = normalize(fileParam).replace(/^(\.\.(\/|\\))+/g, "").replace(/^[\/\\]/, "");
  if (!fileName || fileName !== fileParam.replace(/^[\/\\]/, "")) {
    return reply.code(400).send({ error: "invalid file parameter" });
  }

  // 遍历候选目录，找到真实非 LFS 指针的字体文件
  let resolvedPath: string | undefined;
  let lfsPointerPath: string | undefined;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const filePath = resolve(join(dir, fileName));
    const resolvedDir = resolve(dir);
    if (!filePath.startsWith(resolvedDir + "\\") && !filePath.startsWith(resolvedDir + "/")) continue;
    if (!existsSync(filePath)) continue;
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;
    // 校验文件不是 Git LFS 指针（头部为 "version https://git-lfs..."），否则尝试下一个目录
    const headBuf = readFileSync(filePath).slice(0, 64);
    const head = headBuf.toString("utf-8");
    if (head.startsWith("version https://git-lfs.github.com/spec/v1")) {
      lfsPointerPath = filePath;
      continue;
    }
    resolvedPath = filePath;
    break;
  }

  if (!resolvedPath) {
    if (lfsPointerPath) {
      // Git LFS 指针视为字体不可用，返回 404 而非 500，避免前端报错
      return reply.code(404).send({ error: "font file is a Git LFS pointer, not real binary", path: lfsPointerPath });
    }
    return reply.code(404).send({ error: "font file not found" });
  }

  const ext = fileName.toLowerCase().split(".").pop();
  const mime = ext === "ttf" ? "font/ttf" : ext === "otf" ? "font/otf" : ext === "woff" ? "font/woff" : ext === "woff2" ? "font/woff2" : "application/octet-stream";
  const stream = createReadStream(resolvedPath);
  return reply.header("Cache-Control", "public, max-age=86400").type(mime).send(stream);
});

app.get("/admin/api/asr-rule-sets", async (req) => {
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  return store.listRuleSetsPage(limit, offset);
});

app.get<{ Params: { id: string } }>("/admin/api/asr-rule-sets/:id", async (req, reply) => {
  const rules = store.getRuleSet(req.params.id);
  if (!rules) return reply.code(404).send({ error: "not found" });
  return rules;
});

app.post<{ Body: AsrRules & { ruleSetId: string } }>("/admin/api/asr-rule-sets", async (req, reply) => {
  try {
    store.createRuleSet(req.body.ruleSetId, req.body);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put<{ Params: { id: string }; Body: AsrRules }>("/admin/api/asr-rule-sets/:id", async (req) => {
  store.updateRuleSet(req.params.id, req.body);
  return { ok: true, version: store.getRuleSet(req.params.id)?.ruleSetVersion };
});

app.get("/admin/api/dramas", async (req) => {
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  return await store.listDramasPage(limit, offset);
});

app.put<{
  Params: { id: string };
  Body: { synopsis?: string; genreTags?: string[]; plotThreads?: string[] };
}>("/admin/api/dramas/:id/meta", async (req, reply) => {
  try {
    const drama = await store.updateDramaMeta(req.params.id, req.body);
    return { ok: true, drama };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put<{ Params: { id: string }; Body: { asrRuleSetId: string } }>(
  "/admin/api/dramas/:id/asr-rule-set",
  async (req) => {
    const drama = store.bindDramaRuleSet(req.params.id, req.body.asrRuleSetId);
    return { ok: true, drama };
  },
);

/** 默认仅返回 pending；显式 status=all 可查全部，其它状态值按传入筛选。已下载请用 /drama-intake/downloaded */
app.get<{
  Querystring: {
    limit?: string;
    offset?: string;
    status?: DramaIntakeStatus | "all";
    dramaType?: DramaIntakeType;
    externalDramaId?: string;
    q?: string;
  };
}>(
  "/admin/api/drama-intake",
  async (req) => {
    const { limit, offset } = parsePagination(req.query);
    const rawStatus = req.query.status;
    const status =
      rawStatus === "all" ? undefined : (rawStatus ?? "pending");
    return await store.listDramaIntakePage(limit, offset, {
      status,
      dramaType: req.query.dramaType,
      externalDramaId: req.query.externalDramaId,
      q: req.query.q,
    });
  },
);

/** 仅查询已进入已下载（downloaded）阶段的短剧入库条目 */
app.get<{
  Querystring: {
    limit?: string;
    offset?: string;
    dramaType?: DramaIntakeType;
    externalDramaId?: string;
    q?: string;
  };
}>(
  "/admin/api/drama-intake/downloaded",
  async (req) => {
    const { limit, offset } = parsePagination(req.query);
    return await store.listDramaIntakePage(limit, offset, {
      status: "downloaded",
      dramaType: req.query.dramaType,
      externalDramaId: req.query.externalDramaId,
      q: req.query.q,
    });
  },
);

app.post<{
  Body: { items?: Array<{ title?: string; externalDramaId?: string; dramaType?: string }> };
}>("/admin/api/drama-intake/batch", async (req, reply) => {
  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return reply.code(400).send({ error: "items required" });
  }
  const items: Array<{ title: string; externalDramaId: string; dramaType: DramaIntakeType }> = [];
  const errors: Array<{ line: number; error: string }> = [];
  rawItems.forEach((item, index) => {
    const title = item?.title?.trim() ?? "";
    const externalDramaId = item?.externalDramaId?.trim() ?? "";
    const dramaType = normalizeDramaIntakeType(item?.dramaType);
    if (!title || !externalDramaId) {
      errors.push({ line: index + 1, error: "剧名和短剧 ID 均不能为空" });
      return;
    }
    if (!dramaType) {
      errors.push({
        line: index + 1,
        error: "短剧类型无效，可选：漫剧、短剧、付费漫剧、付费短剧",
      });
      return;
    }
    items.push({ title, externalDramaId, dramaType });
  });
  if (!items.length) {
    return reply.code(400).send({ error: "no valid items", errors });
  }
  try {
    const result = await store.batchCreateDramaIntake(items);
    const autoQueued: Array<{ externalDramaId: string; taskId: string; sourceUrl: string }> = [];
    const noZipDuplicates: string[] = [];

    // 重复剧直接触发重跑：复用最近一次上传的 zip 地址创建新任务
    if (result.existingRecords.length > 0) {
      const linkedTaskIds = result.existingRecords
        .map((r) => r.linkedTaskId)
        .filter((id): id is string => Boolean(id));
      const sourceUrlMap = await store.findDramaPackageSourceUrlsByIds(linkedTaskIds);

      for (const intake of result.existingRecords) {
        const sourceUrl = intake.linkedTaskId ? sourceUrlMap.get(intake.linkedTaskId) : undefined;
        if (!sourceUrl) {
          // 没有可用 zip 地址，无法自动重跑
          noZipDuplicates.push(intake.externalDramaId);
          continue;
        }

        const objectKey = (() => {
          try {
            return decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\/+/, ""));
          } catch {
            return "";
          }
        })();
        const created = await createDramaPackageEntry({
          title: intake.title,
          sourceUrl,
          packageObjectKey: objectKey || undefined,
          packageName: packageNameFromUrl(sourceUrl) || undefined,
          dramaType: intake.dramaType,
          synopsis: intake.synopsis,
        });

        const queued = await store.updateDramaIntake(intake.intakeId, {
          status: "queued",
          linkedTaskId: created.taskId,
          linkedDramaId: created.task.dramaId ?? null,
        });
        if (queued) {
          autoQueued.push({
            externalDramaId: intake.externalDramaId,
            taskId: created.taskId,
            sourceUrl,
          });
        } else {
          noZipDuplicates.push(intake.externalDramaId);
        }
      }
    }

    return {
      ok: true,
      created: result.created,
      duplicates: [...result.duplicates, ...noZipDuplicates],
      autoQueued,
      errors: errors.length ? errors : undefined,
    };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch<{
  Body: { externalDramaId?: string; synopsis?: string };
}>("/admin/api/drama-intake/synopsis", async (req, reply) => {
  const externalDramaId = req.body?.externalDramaId?.trim() ?? "";
  // 简介可空：允许清空或未填
  const synopsis = req.body?.synopsis?.trim() ?? "";
  if (!externalDramaId) {
    return reply.code(400).send({ error: "externalDramaId required" });
  }
  try {
    const item = await store.updateDramaIntakeSynopsisByExternalId(externalDramaId, synopsis);
    return { ok: true, item };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "drama intake not found") {
      return reply.code(404).send({ error: msg });
    }
    return reply.code(400).send({ error: msg });
  }
});

/**
 * TOS 直传完成后的激活入口（Windows 上传工具调用，免登录）：
 * 1) 按短剧 ID 将待入库状态改为 uploaded
 * 2) 创建 drama_package 任务（Agent 领取后解压/ASR/混剪）
 * 3) 回写 linkedTaskId / linkedDramaId，状态改为 queued
 */
app.post<{
  Body: {
    externalDramaId?: string;
    title?: string;
    sourceUrl?: string;
    packageObjectKey?: string;
    packageName?: string;
    asrRuleSetId?: string;
    expectedEpisodeCount?: number;
  };
}>("/admin/api/drama-intake/activate-package", async (req, reply) => {
  const externalDramaId = req.body?.externalDramaId?.trim() ?? "";
  const sourceUrl = req.body?.sourceUrl?.trim() ?? "";
  const titleFromBody = req.body?.title?.trim() ?? "";
  if (!externalDramaId) {
    return reply.code(400).send({ error: "externalDramaId required" });
  }
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return reply.code(400).send({ error: "sourceUrl must be http(s) zip url" });
  }

  try {
    const intake = await store.findDramaIntakeByExternalId(externalDramaId);
    const title = titleFromBody || intake?.title?.trim() || "";
    if (!title) {
      return reply.code(400).send({ error: "title required (or intake record missing title)" });
    }

    // 1) 标记已上传
    let intakeAfterUpload = intake;
    if (intake) {
      intakeAfterUpload = await store.updateDramaIntakeByExternalId(externalDramaId, {
        status: "uploaded",
      });
    }

    const objectKey =
      req.body?.packageObjectKey?.trim() ||
      (() => {
        try {
          return decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\/+/, ""));
        } catch {
          return "";
        }
      })();
    const packageName =
      req.body?.packageName?.trim() ||
      (objectKey ? objectKey.split("/").pop() : undefined) ||
      undefined;

    // 2) 创建压缩包入库任务 → Agent 自动 ASR + 混剪
    const created = await createDramaPackageEntry({
      title,
      sourceUrl,
      packageObjectKey: objectKey || undefined,
      packageName,
      asrRuleSetId: req.body?.asrRuleSetId,
      expectedEpisodeCount: req.body?.expectedEpisodeCount,
      synopsis: intakeAfterUpload?.synopsis,
      dramaType: intakeAfterUpload?.dramaType,
    });

    // 3) 关联任务并标记已建任务
    let intakeQueued = intakeAfterUpload;
    if (intake) {
      intakeQueued = await store.updateDramaIntakeByExternalId(externalDramaId, {
        status: "queued",
        linkedTaskId: created.taskId,
        linkedDramaId: created.task.dramaId ?? null,
      });
      // 如果该 intake 有等待的复刻任务，自动创建复刻 clip_task 并关联本剧包
      if (created.task.dramaId) {
        await store.activateWaitingRemixReplicas(intake.intakeId, created.task.dramaId, created.taskId);
      }
    }

    return {
      ok: true,
      taskId: created.taskId,
      dramaId: created.task.dramaId,
      sourceUrl: created.sourceUrl,
      packageName: created.packageName,
      intake: intakeQueued ?? null,
      intakeFound: Boolean(intake),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "drama intake not found") {
      return reply.code(404).send({ error: msg });
    }
    return reply.code(400).send({ error: msg });
  }
});

app.patch<{
  Params: { id: string };
  Body: {
    status?: DramaIntakeStatus;
    dramaType?: DramaIntakeType;
    synopsis?: string | null;
    note?: string | null;
    linkedTaskId?: string | null;
    linkedDramaId?: string | null;
  };
}>("/admin/api/drama-intake/:id", async (req, reply) => {
  try {
    const item = await store.updateDramaIntake(req.params.id, req.body ?? {});
    return { ok: true, item };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete<{ Params: { id: string } }>("/admin/api/drama-intake/:id", async (req, reply) => {
  try {
    await store.deleteDramaIntake(req.params.id);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/admin/api/templates", async () => ({ templates: listTemplates() }));

if (existsSync(ADMIN_WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: ADMIN_WEB_DIST,
    prefix: "/admin/",
    wildcard: true,
    index: ["index.html"],
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    },
  });
  app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));

  app.setNotFoundHandler(async (req, reply) => {
    const pathname = (req.url.split("?")[0] ?? "").split("#")[0] ?? "";
    if (pathname.startsWith("/admin/") && !pathname.startsWith("/admin/api/")) {
      if (!/\.[a-zA-Z0-9]+$/.test(pathname)) {
        const index = readFileSync(join(ADMIN_WEB_DIST, "index.html"), "utf-8");
        return reply
          .header("Cache-Control", "no-cache, no-store, must-revalidate")
          .header("Pragma", "no-cache")
          .type("text/html; charset=utf-8")
          .send(index);
      }
    }
    return reply.code(404).send({
      message: `Route ${req.method}:${pathname} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (code === "EADDRINUSE") {
    console.error(
      `[clip-api] 端口 ${PORT} 已被占用。请先停掉旧进程再建，不要直接 start 叠一份：\n` +
        `  Linux:  ss -lptn 'sport = :${PORT}'   或  fuser -v ${PORT}/tcp\n` +
        `  停旧:   npm run api:stop   或  kill <pid>\n` +
        `  再启:   npm run api:restart\n` +
        `  换端口: PORT=8082 npm run api:start`,
    );
    process.exit(1);
  }
  throw err;
}
console.log(`clip-api bound on http://${HOST}:${PORT}`);
console.log(`clip-api public base: ${API_PUBLIC_BASE}`);
if (existsSync(ADMIN_WEB_DIST)) {
  console.log(`admin-web: ${API_PUBLIC_BASE}/admin/`);
}
