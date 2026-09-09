import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import type {
  AgentServicesConfig,
  AsrRules,
  AsrSegment,
  ClipPlan,
  ClipPlanBatch,
  ClipTask,
  ClipTaskDetail,
  ClipTaskKind,
  DramaPackageMeta,
  AsrResultRecord,
  AsrResultSummary,
  DeviceInfo,
  DeviceRegisterRequest,
  DramaEpisodeRecord,
  DramaInfo,
  DramaIntakeRecord,
  DramaIntakeStatus,
  DramaIntakeType,
  DramaMeta,
  EffectiveConfig,
  MixRenderRecord,
  RawAsrSegment,
  RenderConfig,
  TelemetryBatch,
} from "@clip/sdk";
import {
  formatDramaPackageName,
  normalizeAgentTaskQueue,
  resolveAgentServices,
  resolveResourcePolicy,
  sanitizeDramaPackageTitle,
  enrichEffectiveConfigForAgent,
} from "@clip/sdk";
import { ensureContinuousEpisodeAsrTimeline, backfillSpeechStartFromRaw, annotateAsrSegmentsWithLabels, resolveGenreProfile, sampleAsrTextsForGenreInfer, remapPlanAsrToOutputTimeline, mergeHumanHighlightMarkersIntoSegments, applyClientHumanMarkerOverrides, normalizeWorkstationMarkerType, isWorkstationOpeningMarker, isWorkstationClosingMarker } from "@clip/agent-core";
import { episodeIdFromNo, mergeDramaSegments, parseEpisodeNoFromMediaPath } from "./drama-segments.js";
import { resolveMysqlConfig } from "./mysql/config.js";
import { initMysqlPool } from "./mysql/pool.js";
import { toIso, toMysqlDate } from "./mysql/json.js";
import { AsrMysqlRepository } from "./mysql/asr-repository.js";
import { TaskMysqlRepository, type BoardTaskLite, type TaskRecord } from "./mysql/task-repository.js";
import { DeviceMysqlRepository } from "./mysql/device-repository.js";
import { ConfigMysqlRepository, type ProfileState } from "./mysql/config-repository.js";
import { DramaMysqlRepository } from "./mysql/drama-repository.js";
import { DramaIntakeMysqlRepository } from "./mysql/drama-intake-repository.js";
import { TelemetryMysqlRepository } from "./mysql/telemetry-repository.js";
import { PackageCacheMysqlRepository, type PackageCacheRecord } from "./mysql/package-cache-repository.js";
import { EditMarkerMysqlRepository, type EditMarker } from "./mysql/edit-marker-repository.js";
import {
  BgmMysqlRepository,
  stripBgmFromRender,
} from "./mysql/bgm-repository.js";
import type { BgmConfig } from "@clip/sdk";
import { RemixReplicaRepository, type RemixJob, type CreateRemixJobInput } from "./mysql/remix-replica-repository.js";
import type { LocalOss } from "./local-oss.js";

/** 任务看板：单剧聚合卡片 DTO */
export interface TaskBoardStageDto {
  key: "package" | "asr" | "mix";
  label: string;
  total: number;
  done: number;
  status: "pending" | "running" | "completed" | "failed";
  /** 剧包任务的粗阶段（downloading/extracting/...），仅剧包阶段有 */
  phase?: string;
  /** 该阶段代表任务 ID（首个），前端跳明细用 */
  taskId?: string;
  claimedBy?: string;
  claimedAt?: string;
  outputUrl?: string;
}

export interface TaskBoardGroupDto {
  dramaId: string;
  title: string;
  taskCount: number;
  lastActiveAt: string;
  aggStatus: "running" | "completed" | "failed";
  /** 参与执行的 deviceId 集合 */
  servers: string[];
  failMessage?: string;
  stages: TaskBoardStageDto[];
  /** 分集识别明细（按集号排序） */
  episodes: Array<{
    episodeNo?: number;
    status: string;
    taskId: string;
    server?: string;
    elapsed?: number;
  }>;
}

const HIGHLIGHT_TYPE_LABEL: Record<string, string> = {
  hook: "片头钩子",
  conflict: "冲突",
  twist: "反转",
  cliff: "悬念",
};

function formatManualMarkers(markers: EditMarker[]): string {
  const humanMarkers = markers.filter((m) => m.source !== "suppress");
  if (!humanMarkers.length) return "";

  const opening = humanMarkers.filter((m) =>
    isWorkstationOpeningMarker(m.highlightType, m.label),
  );
  const closing = humanMarkers.filter((m) =>
    isWorkstationClosingMarker(m.highlightType, m.label),
  );
  const other = humanMarkers.filter(
    (m) =>
      !isWorkstationOpeningMarker(m.highlightType, m.label) &&
      !isWorkstationClosingMarker(m.highlightType, m.label),
  );

  const lineOf = (m: EditMarker, role: string) => {
    const type = normalizeWorkstationMarkerType(m.highlightType, m.label);
    const typeName = HIGHLIGHT_TYPE_LABEL[type] || m.label || "标记";
    return `- ${role} · ${type}/${typeName} · **起点=${m.startMs}ms** **终点=${m.endMs}ms** · source=${m.sourcePath}`;
  };

  return [
    "## 人工标记（工位语义 · 最高优先级 · 软约束由你权衡叙事）",
    "工位约定：**高光=片头开场**，**钩子=片尾悬念**。选到重叠 ASR 段时：片头严格用起点 ms，片尾严格用终点 ms；segmentId 从 ASR 映射。",
    "每条成片优先各参考一处人工片头与一处人工片尾；叙事小弧/邻集/时长不合格时可换同主题备选，**禁止硬套无关标记**。",
    "",
    "### 人工片头（高光 · 尽量作 hook / 第一刀）",
    ...(opening.length ? opening.map((m) => lineOf(m, "片头")) : ["- （无）"]),
    "",
    "### 人工片尾（钩子 · 尽量作 cliff / 最后一刀收束）",
    ...(closing.length ? closing.map((m) => lineOf(m, "片尾")) : ["- （无）"]),
    ...(other.length
      ? [
          "",
          "### 其他人工标记",
          ...other.map((m) => lineOf(m, "参考")),
        ]
      : []),
  ].join("\n");
}

function inferHighlightTypeFromLabel(label: string): string {
  return normalizeWorkstationMarkerType(undefined, label);
}

function basenameOfPath(p: string): string {
  const s = String(p || "").replace(/\\/g, "/");
  const parts = s.split("/");
  return parts[parts.length - 1] || "";
}

function normalizePathKey(p: string): string {
  return String(p || "")
    .trim()
    .replace(/^clip-local:\/\//i, "")
    .replace(/^local:/i, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** 旧文件名 output-r01-p02.mp4 → { round:1, plan:2 } */
function parseLegacyOutputRp(fileName: string): { round: number; plan: number } | null {
  const m = /^output-r(\d+)-p(\d+)\.mp4$/i.exec(basenameOfPath(fileName));
  if (!m) return null;
  return { round: Number(m[1]), plan: Number(m[2]) };
}

function matchMixRender(
  renders: MixRenderRecord[],
  pathHint: string,
  fileHint: string,
): { render: MixRenderRecord; matchedBy: string } | null {
  if (!renders.length) return null;
  if (renders.length === 1) {
    return { render: renders[0]!, matchedBy: "single-render" };
  }

  const pathKey = normalizePathKey(pathHint);
  const fileKey = (fileHint || basenameOfPath(pathHint)).toLowerCase();

  if (pathKey) {
    for (const r of renders) {
      const local = normalizePathKey(r.localOutputPath || "");
      if (local && (local === pathKey || local.endsWith(pathKey) || pathKey.endsWith(local))) {
        return { render: r, matchedBy: "localOutputPath" };
      }
      const url = normalizePathKey(r.outputUrl || "");
      if (url && (url === pathKey || url.endsWith("/" + fileKey) || url.endsWith(fileKey))) {
        return { render: r, matchedBy: "outputUrl" };
      }
    }
  }

  if (fileKey) {
    for (const r of renders) {
      const localName = basenameOfPath(r.localOutputPath || "").toLowerCase();
      const urlName = basenameOfPath(r.outputUrl || "").toLowerCase();
      if (localName === fileKey || urlName === fileKey) {
        return { render: r, matchedBy: "fileName" };
      }
    }
  }

  const legacy = parseLegacyOutputRp(fileKey || pathHint);
  if (legacy) {
    const hit = renders.find(
      (r) =>
        r.round === legacy.round &&
        (r.planSeqInRound ?? r.planIndex) === legacy.plan,
    );
    if (hit) return { render: hit, matchedBy: "output-rXpY" };
  }

  return null;
}
import { hydrateFromMysql, ensureMysqlDefaults } from "./mysql/bootstrap.js";
import { resolveAgentUpdate } from "./agent-release.js";
import {
  packageCacheKeyFromSourcePath,
  sourcePathsMatch,
} from "./source-path-match.js";
import { snapshotDramaMetaForTask, warnIfMissingSynopsis } from "./drama-meta.js";
import { normalizeDramaMeta, DRAMA_INTAKE_TYPE_LABELS } from "@clip/sdk";
import type { TaskWakeService } from "./redis/task-wake.js";
import { DEFAULT_PAGE_LIMIT } from "./pagination.js";

const schemaRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/clip-schema");
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const TASK_CLAIM_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** 列表/入库用东八区墙钟，与 MySQL DATETIME 一致，避免 toISOString 带 Z */
function nowWallClock(): string {
  return toIso(new Date())!;
}

function loadDefault<T>(file: string): T {
  return JSON.parse(readFileSync(join(schemaRoot, file), "utf-8")) as T;
}

const defaultRules = loadDefault<AsrRules>("defaults/asr-rules-drama-default-v1.json");
const defaultProfile = loadDefault<
  Omit<EffectiveConfig, "asr" | "services"> & {
    asr: Omit<EffectiveConfig["asr"], "rules">;
    services?: AgentServicesConfig;
  }
>("defaults/profile-windows-standard.json");

interface DeviceRecord {
  deviceId: string;
  deviceToken: string;
  machineId: string;
  gpuName: string;
  vramMb: number;
  os: string;
  agentVersion: string;
  lastSeenAt: string;
  createdAt: string;
  boundUser?: string;
}

interface RuntimeCache {
  devices: DeviceRecord[];
  ruleSets: Record<string, AsrRules>;
  dramas: Record<string, DramaInfo>;
  deviceOverrides: Record<
    string,
    { render?: RenderConfig; asrRuleSetId?: string; services?: AgentServicesConfig }
  >;
  profile: Omit<EffectiveConfig, "asr" | "services"> & {
    asr: Omit<EffectiveConfig["asr"], "rules">;
    services?: AgentServicesConfig;
  };
  dramaEpisodes: Record<string, DramaEpisodeRecord[]>;
  updateManifest: {
    version: string;
    platform: string;
    downloadUrl: string;
    sha256: string;
    mandatory: boolean;
    releaseNotes: string;
  };
}

export function buildEffectiveConfig(
  ruleSetId = "drama-default-v1",
  profile = defaultProfile,
): EffectiveConfig {
  const rules =
    ruleSetId === defaultRules.ruleSetId
      ? defaultRules
      : { ...defaultRules, ruleSetId, ruleSetVersion: "1.0.0" };

  return {
    configVersion: profile.configVersion,
    profile: profile.profile,
    asr: { ...profile.asr, rules },
    render: profile.render,
    };
}

/**
 * 本地方案生成（不依赖任何外部 LLM）：按 ASR 顺序把片段拼成块，
 * 每轮从不同起点错开，保证各轮产出素材不完全重叠的可用方案。
 */
function buildLocalPlanBatch(segments: AsrSegment[], round: number): ClipPlanBatch {
  const usable = segments.filter(
    (s) => s.segmentId && (s.endMs ?? 0) > (s.startMs ?? 0),
  );
  if (!usable.length) {
    throw new Error("无可用 ASR 片段，无法生成剪辑方案");
  }

  const maxClips = 20;
  const plans: ClipPlan[] = [];
  const plansPerRound = 3;
  for (let p = 0; p < plansPerRound; p++) {
    const offset = ((round - 1) * plansPerRound + p) * 3;
    const picked = usable.slice(offset % usable.length).slice(0, maxClips);
    if (picked.length < 2) continue;
    const clips = picked.map((s) => ({
      segmentId: s.segmentId,
      throughSegmentId: s.segmentId,
      reason: "本地顺序拼接",
      role: "context" as const,
      episodeId: s.episodeId,
      trimStartMs: s.startMs,
      trimEndMs: s.endMs,
    }));
    const estimatedDurationSec = Math.round(
      clips.reduce((acc, c) => acc + ((c.trimEndMs ?? 0) - (c.trimStartMs ?? 0)), 0) / 1000,
    );
    plans.push({
      version: "2.0",
      strategy: "sequential_local",
      narrativeLine: "本地顺序拼接方案（无 LLM）",
      confidence: 0.3,
      clips,
      estimatedDurationSec,
      output: {
        ratio: "auto",
        maxDurationSec: 1200,
        subtitle: true,
      },
    });
  }

  if (!plans.length) {
    // 片段过少时至少产出一条
    const picked = usable.slice(0, maxClips);
    plans.push({
      version: "2.0",
      strategy: "sequential_local",
      narrativeLine: "本地顺序拼接方案（无 LLM）",
      confidence: 0.3,
      clips: picked.map((s) => ({
        segmentId: s.segmentId,
        throughSegmentId: s.segmentId,
        reason: "本地顺序拼接",
        role: "context" as const,
        episodeId: s.episodeId,
        trimStartMs: s.startMs,
        trimEndMs: s.endMs,
      })),
      output: { ratio: "auto", maxDurationSec: 1200, subtitle: true },
    });
  }

  return {
    version: "2.0",
    round,
    totalRounds: round,
    plansPerRound: plans.length,
    clipSelectionMode: "local",
    plans,
  };
}

/** 按集补全 ASR 时间轴：片头并入首段、中间无空洞、末段接到源时长；保留真实开口 */
function ensureAsrTimelineContinuous(
  segments: AsrSegment[],
  episodeId?: string,
  rawSegments?: RawAsrSegment[],
): { segments: AsrSegment[]; repairs: string[] } {
  if (!segments.length) return { segments, repairs: [] };
  const sourceDurationMs = Math.max(...segments.map((s) => s.endMs), 0);
  const filled = ensureContinuousEpisodeAsrTimeline(segments, sourceDurationMs, { episodeId });
  return {
    segments: backfillSpeechStartFromRaw(filled.segments, rawSegments),
    repairs: filled.repairs,
  };
}

function defaultUpdateManifest(): RuntimeCache["updateManifest"] {
  return {
    version: "0.3.0",
    platform: "win-x64",
    downloadUrl: "https://clip-cdn.example.com/agent/ClipAgent-0.3.0-x64.msi",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    mandatory: false,
    releaseNotes: "MVP 完整功能版本",
  };
}

function emptyRuntimeCache(): RuntimeCache {
  return {
    devices: [],
    ruleSets: {},
    dramas: {},
    deviceOverrides: {},
    profile: defaultProfile,
    dramaEpisodes: {},
    updateManifest: defaultUpdateManifest(),
  };
}

/** 判断 Agent 上报的错误是否属于可恢复外部依赖故障（如 funasr-gpu CUDA 错误）。
 * 这类错误不应把任务直接置为 failed，而是释放回 pending 等待其他 Agent/时机重试。 */
function isRecoverableAgentError(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "cuda error",
    "funasr-gpu transcribe failed",
    "funasr transcribe failed: 500",
  ].some((keyword) => lower.includes(keyword));
}

export class ClipStore {
  private state: RuntimeCache;
  private readonly apiPublicBase: string;
  private demoSourceAvailable = false;
  private asrRepo: AsrMysqlRepository | null = null;
  private taskRepo: TaskMysqlRepository | null = null;
  private deviceRepo: DeviceMysqlRepository | null = null;
  private configRepo: ConfigMysqlRepository | null = null;
  private dramaRepo: DramaMysqlRepository | null = null;
  private dramaIntakeRepo: DramaIntakeMysqlRepository | null = null;
  private telemetryRepo: TelemetryMysqlRepository | null = null;
  private packageCacheRepo: PackageCacheMysqlRepository | null = null;
  private editMarkerRepo: EditMarkerMysqlRepository | null = null;
  private bgmRepo: BgmMysqlRepository | null = null;
  /** 内存中的 BGM（来自 clip_bgm_* 表，不进 profile_json） */
  private bgmConfig: BgmConfig = {
    enabled: false,
    tracks: [],
    volume: 0.25,
    fadeInSec: 1,
    fadeOutSec: 2,
    loop: true,
  };
  private remixRepo: RemixReplicaRepository | null = null;
  private ossArtifactExists: ((objectKey: string) => boolean) | null = null;
  private localOss: LocalOss | null = null;
  private taskWake: TaskWakeService | null = null;
  private lastMysqlTouch = new Map<string, number>();
  private static readonly MYSQL_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

  constructor(apiPublicBase = "http://127.0.0.1:8081") {
    this.apiPublicBase = apiPublicBase.replace(/\/$/, "");
    this.state = emptyRuntimeCache();
  }

  setOssArtifactChecker(checker: (objectKey: string) => boolean): void {
    this.ossArtifactExists = checker;
  }

  /** 绑定本地 OSS，用于持久化 TTS 口播（避免方舟临时 URL 过期） */
  setLocalOss(oss: LocalOss): void {
    this.localOss = oss;
  }

  setTaskWake(taskWake: TaskWakeService): void {
    this.taskWake = taskWake;
  }

  async countTopLevelPendingTasks(): Promise<number> {
    return this.requireTaskRepo().countTopLevelPending();
  }

  async initTaskWakeFromDb(): Promise<void> {
    if (!this.taskWake?.isEnabled) return;
    const count = await this.countTopLevelPendingTasks();
    await this.taskWake.syncPendingFromDb(count);
    if (count > 0) {
      console.log(`[clip-api] Redis task wake synced: ${count} pending top-level task(s)`);
    }
  }

  async reconcileTaskWake(): Promise<void> {
    if (!this.taskWake?.isEnabled) return;
    const count = await this.countTopLevelPendingTasks();
    await this.taskWake.setPendingCount(count);
    if (count > 0) {
      await this.taskWake.notifyWake(1);
    }
  }

  private async notifyTopLevelPending(count = 1): Promise<void> {
    if (!this.taskWake?.isEnabled) return;
    await this.taskWake.incrementPending(count);
    await this.taskWake.notifyWake(count);
  }

  /** Agent 长轮询 claim：Stream 唤醒 → MySQL 领取 → XACK（客户端无感） */
  async pollClaimTask(
    deviceId: string,
    taskWake: TaskWakeService,
    taskId?: string,
  ): Promise<ClipTask | null> {
    if (taskId) {
      return this.claimTask(deviceId, taskId);
    }

    await taskWake.touchOnline(deviceId);
    this.touchAgentPresence(deviceId);

    // 先查 MySQL 再等待 Redis：Redis 唤醒消息可能因服务重启、手工写库或
    // 历史计数过期而缺失，不能让 pending 任务被阻塞在队列外。
    let task = await this.claimTask(deviceId);
    if (task) return task;

    const wakeMsg = await taskWake.waitForWake(deviceId);
    task = await this.claimTask(deviceId);

    if (!task) {
      const pending = await taskWake.getPendingCount();
      if (pending != null && pending > 0) {
        const wakeRetry = await taskWake.waitForWake(deviceId, 2);
        task = await this.claimTask(deviceId);
        if (wakeRetry) {
          await taskWake.ackWake(wakeRetry.id);
        }
      }
    }

    if (wakeMsg) {
      await taskWake.ackWake(wakeMsg.id);
    }
    return task;
  }

  private resolveAgentUpdateForDevice(deviceVersion: string): {
    updateAvailable: boolean;
    agentUpdate: import("@clip/sdk").AgentUpdateInfo;
  } {
    const checker = this.ossArtifactExists ?? (() => false);
    return resolveAgentUpdate({
      manifest: this.state.updateManifest,
      deviceVersion,
      apiPublicBase: this.apiPublicBase,
      ossExists: checker,
    });
  }

  private requireTaskRepo(): TaskMysqlRepository {
    if (!this.taskRepo) {
      throw new Error("MySQL is required for task storage (set CLIP_MYSQL_HOST or CLIP_MYSQL_URL)");
    }
    return this.taskRepo;
  }

  private async saveTask(task: TaskRecord): Promise<void> {
    await this.requireTaskRepo().save(task);
  }

  private async getTaskRecord(taskId: string): Promise<TaskRecord | null> {
    return this.requireTaskRepo().findById(taskId);
  }

  async initMysql(): Promise<void> {
    const config = resolveMysqlConfig();
    if (!config) {
      throw new Error(
        "[clip-api] MySQL is required. Set CLIP_MYSQL_HOST or CLIP_MYSQL_URL in environment.",
      );
    }

    const pool = await initMysqlPool(config);
    if (!pool) {
      throw new Error("[clip-api] Failed to connect to MySQL");
    }

    this.asrRepo = new AsrMysqlRepository(pool);
    this.taskRepo = new TaskMysqlRepository(pool);
    this.deviceRepo = new DeviceMysqlRepository(pool);
    this.configRepo = new ConfigMysqlRepository(pool);
    this.dramaRepo = new DramaMysqlRepository(pool);
    this.dramaIntakeRepo = new DramaIntakeMysqlRepository(pool);
    this.telemetryRepo = new TelemetryMysqlRepository(pool);
    this.packageCacheRepo = new PackageCacheMysqlRepository(pool);
    this.editMarkerRepo = new EditMarkerMysqlRepository(pool);
    this.bgmRepo = new BgmMysqlRepository(pool);
    this.remixRepo = new RemixReplicaRepository(pool);
    console.log(`[clip-api] MySQL connected: ${config.host}:${config.port}/${config.database}`);

    const repos = {
      device: this.deviceRepo,
      config: this.configRepo,
      drama: this.dramaRepo,
      telemetry: this.telemetryRepo,
      asr: this.asrRepo,
    };

    await ensureMysqlDefaults(repos, this.buildMysqlDefaults());
    this.applyHydrated(await hydrateFromMysql(repos));
    await this.initBgmFromMysql();

    if (this.ensureLongMixRuntimeLimits()) {
      await this.configRepo.saveActiveProfile(this.stripProfileBgm(this.state.profile));
    }
    if (this.ensureHardCutByDefault()) {
      await this.configRepo.saveActiveProfile(this.stripProfileBgm(this.state.profile));
    }
  }

  async upsertPackageCache(input: Omit<PackageCacheRecord,"cacheId"|"createdAt"|"updatedAt">): Promise<PackageCacheRecord> { if (!this.packageCacheRepo) throw new Error("MySQL package cache repository not initialized"); const item=await this.packageCacheRepo.upsert(input); await this.packageCacheRepo.event(item.cacheId,"heartbeat",{status:item.status}); return item; }
  async listPackageCaches(input:{dramaId?:string;deviceId?:string;status?:string;limit:number;offset:number}) { if (!this.packageCacheRepo) throw new Error("MySQL package cache repository not initialized"); return this.packageCacheRepo.listPage(input); }
  async createEditMarker(
    input: Omit<EditMarker, "markerId" | "createdAt" | "updatedAt">,
  ): Promise<EditMarker> {
    if (!this.editMarkerRepo) throw new Error("MySQL edit marker repository not initialized");
    const taskId = await this.resolveEditMarkerTaskId(input.taskId, input.sourcePath);
    return this.editMarkerRepo.create({ ...input, taskId });
  }
  async listEditMarkers(input: {
    sourcePath?: string;
    sourcePaths?: string[];
    sourcePathContains?: string[];
    taskId?: string;
    taskIds?: string[];
    deviceId?: string;
  }): Promise<EditMarker[]> {
    if (!this.editMarkerRepo) throw new Error("MySQL edit marker repository not initialized");
    return this.editMarkerRepo.list(input);
  }
  async deleteEditMarkerByRange(input:{deviceId?:string;sourcePath:string;startMs:number;endMs:number}):Promise<number>{if(!this.editMarkerRepo)throw new Error("MySQL edit marker repository not initialized");return this.editMarkerRepo.deleteByRange(input);}
  async updateEditMarkerByRange(input:{deviceId?:string;sourcePath:string;oldStartMs:number;oldEndMs:number;startMs:number;endMs:number;label?:string;highlightType?:import("./mysql/edit-marker-repository.js").EditMarkerHighlightType;usableAsHook?:boolean}):Promise<EditMarker|null>{if(!this.editMarkerRepo)throw new Error("MySQL edit marker repository not initialized");return this.editMarkerRepo.updateByRange(input);}
  async deleteEditMarkerById(markerId:number):Promise<number>{if(!this.editMarkerRepo)throw new Error("MySQL edit marker repository not initialized");return this.editMarkerRepo.deleteById(markerId);}
  /** 按 taskId（分集 ASR / 剧包 / 混剪）拉全部人工标记，跨设备共享 */
  async listEditMarkersByTaskId(taskId: string): Promise<EditMarker[]> {
    if (!this.editMarkerRepo) throw new Error("MySQL edit marker repository not initialized");
    const task = await this.getTaskRecord(taskId);
    if (task) return this.listEditMarkersForMixTask(task);
    // 任务可能已清理：退化为仅按 taskId 直查
    return this.editMarkerRepo.list({ taskId });
  }

  /** 桌面端音频轨：直接查 clip_bgm_track（实时读库） */
  async listAgentBgmTracks(): Promise<Array<{ trackId: number; name: string; url: string }>> {
    if (!this.bgmRepo) return [];
    try {
      const tracks = await this.bgmRepo.listAgentTracks();
      // 顺带刷新内存，保证 Agent 渲染侧 config.render.bgm 一致
      this.bgmConfig = await this.bgmRepo.getBgmConfig();
      return tracks;
    } catch (err) {
      console.warn(
        "[clip-api] listAgentBgmTracks 失败（请确认已执行 20260721_bgm.sql）:",
        err instanceof Error ? err.message : err,
      );
      // 表未建时回落内存/旧配置
      const fromMem = (this.bgmConfig.tracks || [])
        .map((t, i) => ({
          trackId: i + 1,
          name: String(t.name || "").trim() || "音频",
          url: String(t.url || "").trim(),
        }))
        .filter((t) => t.url);
      return fromMem;
    }
  }

  /** 剧目展示名（素材库筛选用） */
  dramaTitleById(dramaId?: string | null): string {
    const id = String(dramaId || "").trim();
    if (!id) return "";
    return String(this.state.dramas[id]?.title || "").trim() || id;
  }

  /** 混剪方案：按混剪/剧包/分集 ASR taskId + 规范化源路径聚合人工标记 */
  async listEditMarkersForMixTask(task: TaskRecord): Promise<EditMarker[]> {
    const taskIds = new Set<string>([task.taskId]);
    if (task.parentPackageTaskId) taskIds.add(task.parentPackageTaskId);

    const episodeRefs = await this.resolveMixEpisodeRefsForMarkers(task);
    const sourceUrls: string[] = [];
    const cacheKeys = new Set<string>();
    for (const ep of episodeRefs) {
      if (ep.taskId) taskIds.add(ep.taskId);
      if (ep.sourceUrl) {
        sourceUrls.push(ep.sourceUrl);
        const key = packageCacheKeyFromSourcePath(ep.sourceUrl);
        if (key) cacheKeys.add(key);
      }
    }

    const byId = new Map<number, EditMarker>();
    const merge = (rows: EditMarker[]) => {
      for (const m of rows) byId.set(m.markerId, m);
    };
    if (taskIds.size) merge(await this.listEditMarkers({ taskIds: [...taskIds] }));
    if (sourceUrls.length) merge(await this.listEditMarkers({ sourcePaths: sourceUrls }));
    if (cacheKeys.size) {
      merge(
        await this.listEditMarkers({
          sourcePathContains: [...cacheKeys],
        }),
      );
    }

    const markers = [...byId.values()].sort((a, b) => a.startMs - b.startMs);
    await this.rebindOrphanMarkersForEpisodes(markers, episodeRefs);

    const human = markers.filter((m) => m.source !== "suppress");
    const opening = human.filter((m) =>
      isWorkstationOpeningMarker(m.highlightType, m.label),
    ).length;
    const closing = human.filter((m) =>
      isWorkstationClosingMarker(m.highlightType, m.label),
    ).length;
    console.log(
      `[edit-marker] mix task=${task.taskId} drama=${task.dramaId ?? "-"} ` +
        `episodes=${episodeRefs.length} markers=${human.length} opening=${opening} closing=${closing} ` +
        `cacheKeys=${cacheKeys.size}`,
    );
    return markers;
  }

  /** 分集引用：内存分集 + ASR 库回填（避免 clip_drama_episode 空导致匹配失败） */
  private async resolveMixEpisodeRefsForMarkers(
    task: TaskRecord,
  ): Promise<
    Array<{ episodeId: string; episodeNo?: number; taskId?: string; sourceUrl?: string }>
  > {
    const byEp = new Map<
      string,
      { episodeId: string; episodeNo?: number; taskId?: string; sourceUrl?: string }
    >();
    if (task.dramaId && task.mixEpisodeIds?.length) {
      for (const ep of this.listDramaEpisodes(task.dramaId)) {
        if (!task.mixEpisodeIds.includes(ep.episodeId)) continue;
        byEp.set(ep.episodeId, {
          episodeId: ep.episodeId,
          episodeNo: ep.episodeNo,
          taskId: ep.taskId,
          sourceUrl: ep.sourceUrl,
        });
      }
    }
    if (this.asrRepo && task.dramaId && task.mixEpisodeIds?.length) {
      try {
        const { results } = await this.asrRepo.listSummaries({
          dramaId: task.dramaId,
          taskKind: "episode_asr",
          limit: 200,
          offset: 0,
        });
        for (const row of results) {
          const epId =
            row.episodeId ||
            (row.episodeNo != null ? episodeIdFromNo(row.episodeNo) : undefined);
          if (!epId || !task.mixEpisodeIds.includes(epId)) continue;
          const prev = byEp.get(epId);
          byEp.set(epId, {
            episodeId: epId,
            episodeNo: row.episodeNo ?? prev?.episodeNo,
            taskId: row.taskId ?? prev?.taskId,
            sourceUrl: row.sourceUrl || prev?.sourceUrl,
          });
        }
      } catch (err) {
        console.warn(
          `[edit-marker] ASR 回填分集失败 drama=${task.dramaId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return [...byEp.values()];
  }

  /** 按规范化路径把孤儿 task_id 回绑到当前分集 ASR */
  private async rebindOrphanMarkersForEpisodes(
    markers: EditMarker[],
    episodeRefs: Array<{ episodeId: string; taskId?: string; sourceUrl?: string }>,
  ): Promise<void> {
    if (!this.editMarkerRepo || !episodeRefs.length) return;
    for (const m of markers) {
      if (m.source === "suppress") continue;
      const ep = episodeRefs.find(
        (e) => e.sourceUrl && e.taskId && sourcePathsMatch(m.sourcePath, e.sourceUrl),
      );
      if (!ep?.taskId || m.taskId === ep.taskId) continue;
      const ok = await this.editMarkerRepo.updateTaskId(m.markerId, ep.taskId);
      if (ok) {
        m.taskId = ep.taskId;
        console.log(
          `[edit-marker] 回绑 marker=${m.markerId} task_id→${ep.taskId} ep=${ep.episodeId} ` +
            `path=${m.sourcePath.slice(0, 80)}`,
        );
      }
    }
  }

  /** 写入标记时校正 taskId（避免 ASR 入库前打的临时 task 成为孤儿） */
  private async resolveEditMarkerTaskId(
    taskId: string | undefined,
    sourcePath: string,
  ): Promise<string | undefined> {
    if (taskId && this.requireTaskRepo()) {
      const row = await this.requireTaskRepo().findById(taskId);
      if (row) return taskId;
    }
    if (!this.asrRepo || !sourcePath) return taskId;
    try {
      const { results } = await this.asrRepo.listSummaries({ limit: 500, offset: 0 });
      for (const row of results) {
        if (row.sourceUrl && sourcePathsMatch(sourcePath, row.sourceUrl)) {
          return row.taskId;
        }
      }
    } catch {
      /* ignore */
    }
    return taskId;
  }

  private editMarkerMatchesEpisode(
    marker: EditMarker,
    ep: { taskId?: string; sourceUrl?: string },
  ): boolean {
    if (marker.taskId && ep.taskId && marker.taskId === ep.taskId) return true;
    if (marker.sourcePath && ep.sourceUrl && sourcePathsMatch(marker.sourcePath, ep.sourceUrl)) {
      return true;
    }
    return false;
  }

  /** 关闭跨集 xfade 转场，硬切拼接更快、更稳 */
  private ensureHardCutByDefault(): boolean {
    const transition = this.state.profile.render.transition ?? {};
    if (transition.enabled === false) return false;
    this.state.profile.render.transition = { ...transition, enabled: false };
    this.state.profile.configVersion = `cfg-hardcut-${nowWallClock().slice(0, 10).replace(/-/g, "")}`;
    console.log("[clip-api] disabled cross-episode xfade transitions (hard cut)");
    return true;
  }

  private buildMysqlDefaults() {
    return {
      profile: defaultProfile,
      ruleSets: { [defaultRules.ruleSetId]: defaultRules },
      dramas: [
        {
          dramaId: "drama-demo",
          title: "演示短剧",
          asrRuleSetId: defaultRules.ruleSetId,
        },
      ],
      updateManifest: defaultUpdateManifest(),
    };
  }

  private applyHydrated(h: Awaited<ReturnType<typeof hydrateFromMysql>>): void {
    this.state.devices = h.devices;
    this.state.ruleSets = h.ruleSets;
    this.state.dramas = h.dramas;
    this.state.deviceOverrides = h.deviceOverrides;
    this.state.profile = h.profile;
    this.state.dramaEpisodes = h.dramaEpisodes;
    this.state.updateManifest = h.updateManifest;
  }

  private async persistProfile(): Promise<void> {
    // BGM 只落 clip_bgm_* 表，禁止回写 profile_json
    this.state.profile.render = stripBgmFromRender(this.state.profile.render ?? {}) as RenderConfig;
    await this.configRepo!.saveActiveProfile(this.state.profile);
  }

  /** 将表内 BGM 注入 render，供管理台展示与 Agent 下发 */
  private renderWithBgm(render?: RenderConfig): RenderConfig {
    const base = (render ?? this.state.profile.render) as RenderConfig;
    return { ...base, bgm: { ...this.bgmConfig } };
  }

  private stripProfileBgm(profile: ProfileState): ProfileState {
    return {
      ...profile,
      render: stripBgmFromRender(profile.render as RenderConfig & { bgm?: BgmConfig }) as RenderConfig,
    };
  }

  /** 启动时加载 BGM 表；若表空且 profile 仍有旧数据则一次性迁移 */
  private async initBgmFromMysql(): Promise<void> {
    if (!this.bgmRepo || !this.configRepo) return;
    const legacy = this.state.profile.render?.bgm;
    try {
      const migrated = await this.bgmRepo.migrateFromLegacy(legacy);
      this.bgmConfig = await this.bgmRepo.getBgmConfig();
      if (legacy != null || migrated) {
        this.state.profile.render = stripBgmFromRender(this.state.profile.render ?? {}) as RenderConfig;
        if (migrated) {
          console.log("[clip-api] BGM 已从 profile_json 迁移到 clip_bgm_settings / clip_bgm_track");
        }
        await this.configRepo.saveActiveProfile(this.state.profile);
      }
    } catch (err) {
      console.warn(
        "[clip-api] BGM 表未就绪，暂回落 profile.render.bgm（请重新执行 deploy/mysql/init.sql）:",
        err instanceof Error ? err.message : err,
      );
      if (legacy) this.bgmConfig = legacy;
    }
  }

  private async persistRuleSet(ruleSetId: string, rules: AsrRules): Promise<void> {
    await this.configRepo!.saveRuleSet(ruleSetId, rules);
    this.state.ruleSets[ruleSetId] = rules;
  }

  private async persistDeviceOverride(
    deviceId: string,
    override: (typeof this.state.deviceOverrides)[string],
  ): Promise<void> {
    await this.deviceRepo!.saveConfigOverride(deviceId, override);
    this.state.deviceOverrides[deviceId] = override;
  }

  private async persistDrama(drama: DramaInfo): Promise<void> {
    await this.dramaRepo!.saveDrama(drama);
    this.state.dramas[drama.dramaId] = drama;
  }

  private async persistEpisode(episode: DramaEpisodeRecord): Promise<void> {
    await this.dramaRepo!.saveEpisode(episode);
    const list = (this.state.dramaEpisodes[episode.dramaId] ??= []);
    const idx = list.findIndex((e) => e.episodeId === episode.episodeId);
    if (idx >= 0) list[idx] = episode;
    else list.push(episode);
    list.sort((a, b) => a.episodeNo - b.episodeNo);
  }

  mysqlEnabled(): boolean {
    return this.asrRepo !== null && this.taskRepo !== null;
  }

  /** 启动时标记 demo 源是否可用，并同步 demo 任务状态 */
  async reconcileDemoTask(demoSourceAvailable: boolean): Promise<void> {
    this.demoSourceAvailable = demoSourceAvailable;
    const repo = this.requireTaskRepo();
    const existing = await repo.findById("task-demo-001");

    if (!demoSourceAvailable) {
      if (existing && existing.status === "pending") {
        existing.status = "failed";
        existing.failMessage =
          "demo 源视频未安装（服务端缺少 oss/sources/demo.mp4，请放置 fixtures/test-source.mp4 后重启 api-server）";
        existing.updatedAt = nowWallClock();
        await repo.save(existing);
        console.warn("[clip-api] task-demo-001 disabled: demo source missing");
      }
      return;
    }

    await this.ensureDemoTask();
  }

  private async ensureDemoTask(): Promise<void> {
    if (!this.demoSourceAvailable) return;
    const repo = this.requireTaskRepo();
    const existing = await repo.findById("task-demo-001");
    if (existing) return;
    await repo.create({
      taskId: "task-demo-001",
      templateId: "vertical_hook_60s",
      asrRuleSetId: defaultRules.ruleSetId,
      configVersion: this.state.profile.configVersion,
      sourceUrl: `${this.apiPublicBase}/oss/sources/demo.mp4`,
      dramaId: "drama-demo",
      dramaMeta: { title: "演示短剧" },
      taskKind: "single",
      status: "pending",
    });
  }

  /** 长混剪（2~3 分钟）运行时参数：自动升级旧版 60s/90s 上限 */
  private ensureLongMixRuntimeLimits(): boolean {
    let changed = false;

    const limits = this.state.profile.render.limits;
    if (limits && (limits.maxDurationSec ?? 0) < 1200) {
      limits.maxDurationSec = 1200;
      changed = true;
    }

    if (changed) {
      this.state.profile.configVersion = `cfg-longmix-${nowWallClock().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-3)}`;
    }

    return changed;
  }

  private resolveRuleSetId(
    taskRuleSetId?: string,
    dramaId?: string,
    deviceId?: string,
  ): string {
    const override = deviceId ? this.state.deviceOverrides[deviceId] : undefined;
    if (override?.asrRuleSetId) return override.asrRuleSetId;
    if (taskRuleSetId) return taskRuleSetId;
    if (dramaId && this.state.dramas[dramaId]) return this.state.dramas[dramaId]!.asrRuleSetId;
    return defaultRules.ruleSetId;
  }

  async registerDevice(req: DeviceRegisterRequest): Promise<{ deviceId: string; deviceToken: string }> {
    const existing = await this.deviceRepo?.findByMachineId(req.machineId);
    if (existing) {
      const updated = {
        ...existing,
        gpuName: req.gpuName,
        vramMb: req.vramMb,
        os: req.os,
        agentVersion: req.agentVersion,
        lastSeenAt: nowWallClock(),
      };
      await this.deviceRepo!.upsert(updated);
      const idx = this.state.devices.findIndex((d) => d.deviceId === existing.deviceId);
      if (idx >= 0) this.state.devices[idx] = updated;
      else this.state.devices.push(updated);
      return { deviceId: updated.deviceId, deviceToken: updated.deviceToken };
    }

    const deviceId = randomUUID();
    const deviceToken = randomUUID();
    const now = nowWallClock();
    const device = {
      deviceId,
      deviceToken,
      machineId: req.machineId,
      gpuName: req.gpuName,
      vramMb: req.vramMb,
      os: req.os,
      agentVersion: req.agentVersion,
      lastSeenAt: now,
      createdAt: now,
    };
    await this.deviceRepo!.upsert(device);
    this.state.devices.push(device);
    return { deviceId, deviceToken };
  }

  authDevice(deviceId: string, token: string): boolean {
    return this.state.devices.some((d) => d.deviceId === deviceId && d.deviceToken === token);
  }

  async authDeviceAsync(deviceId: string, token: string): Promise<boolean> {
    if (this.authDevice(deviceId, token)) return true;
    if (!this.deviceRepo) return false;

    const ok = await this.deviceRepo.auth(deviceId, token);
    if (!ok) return false;

    const row = await this.deviceRepo.findById(deviceId);
    if (row && !this.state.devices.some((d) => d.deviceId === deviceId)) {
      this.state.devices.push(row);
    }
    return true;
  }

  touchAgentPresence(deviceId: string): void {
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    if (device) {
      device.lastSeenAt = nowWallClock();
    }
    const now = Date.now();
    const last = this.lastMysqlTouch.get(deviceId) ?? 0;
    if (now - last >= ClipStore.MYSQL_TOUCH_INTERVAL_MS) {
      this.lastMysqlTouch.set(deviceId, now);
      void this.deviceRepo?.touch(deviceId);
    }
  }

  touchDevice(deviceId: string): void {
    this.touchAgentPresence(deviceId);
  }

  syncAgentVersion(deviceId: string, agentVersion: string): void {
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    if (!device || device.agentVersion === agentVersion) return;
    device.agentVersion = agentVersion;
    device.lastSeenAt = nowWallClock();
    void this.deviceRepo!.upsert(device);
  }

  heartbeat(deviceId: string, agentVersion?: string): {
    configVersion: string;
    ruleSetVersion: string;
    updateAvailable: boolean;
    agentUpdate: import("@clip/sdk").AgentUpdateInfo;
    services: ReturnType<typeof resolveAgentServices>;
  } {
    if (agentVersion) this.syncAgentVersion(deviceId, agentVersion);
    this.touchAgentPresence(deviceId);
    void this.taskWake?.touchOnline(deviceId, agentVersion);
    const config = this.getDeviceConfig(deviceId);
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    const deviceVersion = device?.agentVersion ?? agentVersion ?? "0.0.0";
    const resolved = this.resolveAgentUpdateForDevice(deviceVersion);
    return {
      configVersion: config.configVersion,
      ruleSetVersion: config.asr.rules.ruleSetVersion,
      updateAvailable: resolved.updateAvailable,
      agentUpdate: resolved.agentUpdate,
      services: config.services ?? resolveAgentServices(),
    };
  }

  getAgentReleaseManifest() {
    return { ...this.state.updateManifest };
  }

  async publishAgentRelease(input: {
    version: string;
    downloadUrl: string;
    sha256: string;
    mandatory?: boolean;
    releaseNotes?: string;
    platform?: string;
    incrementalUrl?: string;
    incrementalSha256?: string;
  }): Promise<typeof this.state.updateManifest> {
    const manifest = {
      platform: input.platform ?? "win-x64",
      version: input.version,
      downloadUrl: input.downloadUrl,
      sha256: input.sha256,
      mandatory: input.mandatory ?? false,
      releaseNotes: input.releaseNotes ?? "",
      incrementalUrl: input.incrementalUrl,
      incrementalSha256: input.incrementalSha256,
    };
    this.state.updateManifest = manifest;
    await this.configRepo!.saveUpdateManifest(manifest);
    console.log(`[clip-api] agent release published: v${manifest.version} -> ${manifest.downloadUrl}`);
    return manifest;
  }

  getDeviceConfig(deviceId: string, ruleSetId?: string, dramaId?: string): EffectiveConfig {
    this.touchAgentPresence(deviceId);
    const id = this.resolveRuleSetId(ruleSetId, dramaId, deviceId);
    const rules = this.state.ruleSets[id] ?? defaultRules;
    const config = buildEffectiveConfig(id, this.state.profile);
    config.asr.rules = rules;
    config.render = this.renderWithBgm(config.render);

    const override = this.state.deviceOverrides[deviceId];
    if (override?.render) {
      // 设备覆盖若未带 bgm，保留全局表内 BGM
      const merged = { ...config.render, ...override.render };
      if (!override.render.bgm) merged.bgm = this.bgmConfig;
      config.render = merged;
    }

    config.services = resolveAgentServices(this.state.profile.services, override?.services);
    const enriched = enrichEffectiveConfigForAgent(config);
    const profileUpload = this.state.profile.render?.limits?.uploadAfterRender;
    const profileTosEnabled = this.state.profile.render?.storage?.tos?.enabled;
    const overrideUpload = override?.render?.limits?.uploadAfterRender;
    const overrideTosEnabled = override?.render?.storage?.tos?.enabled;
    console.log(
      `[getDeviceConfig] deviceId=${deviceId} ` +
        `profileUpload=${profileUpload} profileTos=${profileTosEnabled} ` +
        `overrideUpload=${overrideUpload ?? "<none>"} overrideTos=${overrideTosEnabled ?? "<none>"} ` +
        `finalUpload=${enriched.render?.limits?.uploadAfterRender} finalTos=${enriched.render?.storage?.tos?.enabled}`,
    );
    return enriched;
  }

  async claimTask(deviceId: string, taskId?: string): Promise<ClipTask | null> {
    const override = this.state.deviceOverrides[deviceId]?.services;
    if (override?.agentEnabled === false) {
      return null;
    }
    const taskQueue = normalizeAgentTaskQueue(override?.taskQueue);

    const repo = this.requireTaskRepo();
    const released = await repo.releaseStaleClaims(TASK_CLAIM_TIMEOUT_MS);
    if (released > 0) {
      void this.notifyTopLevelPending(released);
    }
    const task = await repo.claim(deviceId, taskId, taskQueue);
    if (task) {
      void this.taskWake?.decrementPending();
    }
    if (task && task.taskId === "task-demo-001" && !this.demoSourceAvailable) {
      await this.failTask(
        task.taskId,
        "demo 源视频不存在，跳过该任务（请上传 demo.mp4 或在 Admin 重置 demo 前准备源文件）",
      );
      if (taskId) return null;
      return this.claimTask(deviceId);
    }
    return task ? this.toTask(task) : null;
  }

  async getTaskForAgent(taskId: string): Promise<ClipTask | null> {
    const task = await this.getTaskRecord(taskId);
    return task ? this.toTask(task) : null;
  }

  async saveAsrResult(
    taskId: string,
    segments: AsrSegment[],
    rawCount?: number,
    extras?: {
      rawSegments?: RawAsrSegment[];
      subtitleUrl?: string;
      subtitlesJsonUrl?: string;
    },
  ): Promise<AsrResultRecord> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    // 入库前：分集 ASR 强制时间轴连续（兼容旧 Agent）；成片 ASR 必须保留真实开口，否则字幕对不上画面
    if (task.taskKind !== "output_asr") {
      const continuous = ensureAsrTimelineContinuous(segments, task.episodeId, extras?.rawSegments);
      if (continuous.repairs.length) {
        console.log(
          `[clip-api] ASR 时间轴补连续 task=${taskId}: ${continuous.repairs.slice(0, 5).join("; ")}` +
            (continuous.repairs.length > 5 ? ` …共${continuous.repairs.length}条` : ""),
        );
      }
      segments = continuous.segments;
    } else {
      // 成片：仅固化 speechStartMs，便于客户端字幕对齐
      segments = segments.map((seg) => ({
        ...seg,
        speechStartMs: seg.speechStartMs ?? seg.startMs,
      }));
    }
    // 持久化高光/情绪/场面标签（说话人仅透传上游声纹结果；高光按题材词表+开场 ASR）
    const genreOpts = this.resolveDramaGenreAnnotateOptions(
      task.dramaId,
      sampleAsrTextsForGenreInfer(segments),
    );
    segments = annotateAsrSegmentsWithLabels(segments, {
      rawSegments: extras?.rawSegments,
      ...genreOpts,
    });
    if (genreOpts.genreProfile) {
      console.log(
        `[clip-api] ASR 高光题材 task=${taskId} genre=${genreOpts.genreProfile}`,
      );
    }

    if (task.taskKind === "episode_asr" && task.dramaId && task.episodeId) {
      await this.updateEpisodeAsr(task.dramaId, task.episodeId, segments, rawCount, extras);
      task.status = "completed";
      task.updatedAt = nowWallClock();
      const record = await this.buildAsrResultRecord(task, segments, rawCount, extras);
      await this.persistAsrToMysql(task, record);
      return record;
    }

    // 成片仅 ASR：入库后直接完成，不进入选段/渲染
    if (task.taskKind === "output_asr") {
      task.status = "completed";
      task.updatedAt = nowWallClock();
      const record = await this.buildAsrResultRecord(task, segments, rawCount, extras);
      await this.persistAsrToMysql(task, record);
      return record;
    }

    task.status = "processing";
    task.updatedAt = nowWallClock();
    const record = await this.buildAsrResultRecord(task, segments, rawCount, extras);
    await this.persistAsrToMysql(task, record);
    return record;
  }

  private async persistAsrToMysql(task: TaskRecord, record: AsrResultRecord): Promise<void> {
    await this.saveTask(task);
    if (!this.asrRepo) return;
    try {
      await this.asrRepo.save(record);
    } catch (err) {
      console.error("[clip-api] mysql asr save failed", record.taskId, err);
      throw err;
    }
  }

  async getAsrResult(taskId: string): Promise<AsrResultRecord | null> {
    if (!this.asrRepo) {
      throw new Error("[clip-api] MySQL ASR repository not initialized");
    }
    try {
      return await this.asrRepo.findByTaskId(taskId);
    } catch (err) {
      console.error("[clip-api] mysql asr read failed", taskId, err);
      throw err;
    }
  }

  /** Agent/桌面：本地 episode-asr-index 缺失时按剧目集号回落查库 */
  async resolveAsrResult(filter: {
    dramaId?: string;
    episodeId?: string;
    episodeNo?: number;
    deviceId?: string;
  }): Promise<AsrResultRecord | null> {
    if (!this.asrRepo) {
      throw new Error("[clip-api] MySQL ASR repository not initialized");
    }
    try {
      return await this.asrRepo.findLatestByEpisode(filter);
    } catch (err) {
      console.error("[clip-api] mysql asr resolve failed", filter, err);
      throw err;
    }
  }

  /** 成片真 ASR：按本地路径对应 sourceUrl，或父任务+文件名回落 */
  async resolveOutputAsrResult(filter: {
    sourceUrl?: string;
    parentTaskId?: string;
    fileName?: string;
  }): Promise<AsrResultRecord | null> {
    if (!this.asrRepo) {
      throw new Error("[clip-api] MySQL ASR repository not initialized");
    }
    try {
      return await this.asrRepo.findLatestOutputAsr(filter);
    } catch (err) {
      console.error("[clip-api] mysql output asr resolve failed", filter, err);
      throw err;
    }
  }

  async listAsrResults(filter?: {
    dramaId?: string;
    episodeId?: string;
    deviceId?: string;
    taskKind?: ClipTaskKind;
    limit?: number;
    offset?: number;
  }): Promise<{ results: AsrResultSummary[]; total: number; limit: number; offset: number }> {
    if (!this.asrRepo) {
      throw new Error("[clip-api] MySQL ASR repository not initialized");
    }
    try {
      return await this.asrRepo.listSummaries(filter);
    } catch (err) {
      console.error("[clip-api] mysql asr list failed", err);
      throw err;
    }
  }

  private async buildAsrResultRecord(
    task: TaskRecord,
    segments: AsrSegment[],
    rawCount?: number,
    extras?: {
      rawSegments?: RawAsrSegment[];
      subtitleUrl?: string;
      subtitlesJsonUrl?: string;
    },
  ): Promise<AsrResultRecord> {
    const ruleSetId = this.resolveRuleSetId(task.asrRuleSetId, task.dramaId, task.claimedBy);
    const rules = this.state.ruleSets[ruleSetId] ?? defaultRules;
    const now = nowWallClock();
    let savedAt = now;
    if (this.asrRepo) {
      const prevSavedAt = await this.asrRepo.findSavedAt(task.taskId);
      if (prevSavedAt) savedAt = prevSavedAt;
    }
    const record: AsrResultRecord = {
      taskId: task.taskId,
      dramaId: task.dramaId,
      episodeId: task.episodeId,
      episodeNo: task.episodeNo,
      taskKind: task.taskKind ?? "single",
      asrRuleSetId: task.asrRuleSetId ?? rules.ruleSetId,
      ruleSetVersion: rules.ruleSetVersion,
      deviceId: task.claimedBy,
      sourceUrl: task.sourceUrl,
      segments,
      rawSegments: extras?.rawSegments,
      rawSegmentCount: rawCount ?? extras?.rawSegments?.length ?? segments.length,
      finalSegmentCount: segments.length,
      subtitleUrl: extras?.subtitleUrl,
      subtitlesJsonUrl: extras?.subtitlesJsonUrl,
      fullText: segments.map((s) => s.text.trim()).filter(Boolean).join("\n"),
      savedAt,
      updatedAt: now,
    };
    return record;
  }

  private toAsrSummary(record: AsrResultRecord): AsrResultSummary {
    const { segments: _segments, rawSegments: _raw, ...summary } = record;
    return summary;
  }

  async asrResultSummary(taskId: string): Promise<AsrResultSummary | null> {
    const record = await this.getAsrResult(taskId);
    return record ? this.toAsrSummary(record) : null;
  }

  async generatePlan(taskId: string, segments: AsrSegment[]): Promise<ClipPlan> {
    const batch = await this.generatePlanBatch(taskId, segments, 1);
    return batch.plans[0]!;
  }

  async generatePlanBatch(
    taskId: string,
    segments: AsrSegment[],
    round: number,
  ): Promise<ClipPlanBatch> {
    const task = await this.getTaskRecord(taskId);
    let inputSegments =
      task?.taskKind === "drama_mix"
        ? await this.getMergedSegmentsForMixTask(task)
        : segments;

    if (task?.taskKind === "drama_mix" && segments.length) {
      inputSegments = applyClientHumanMarkerOverrides(inputSegments, segments);
    }

    const safeRound = Math.max(1, round);
    const batch = buildLocalPlanBatch(inputSegments, safeRound);

    if (task) {
      task.plan = batch.plans[0];
      if (!task.planBatches) task.planBatches = [];
      const existingIdx = task.planBatches.findIndex((b) => b.round === safeRound);
      if (existingIdx >= 0) {
        task.planBatches[existingIdx] = batch;
      } else {
        task.planBatches.push(batch);
        task.planBatches.sort((a, b) => a.round - b.round);
      }
      task.updatedAt = nowWallClock();
      await this.saveTask(task);
    }
    return batch;
  }

  async updateTaskPlan(taskId: string, plan: ClipPlan): Promise<ClipPlan> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error("task not found");
    task.plan = plan;
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
    return plan;
  }

  async completeTask(
    taskId: string,
    outputUrl: string,
    timing?: { processingStartedAt: string; totalWallTimeSec: number },
  ): Promise<void> {
    const task = await this.getTaskRecord(taskId);
    if (!task) return;
    task.status = "completed";
    task.outputUrl = outputUrl;
    task.outputUrls = [outputUrl];
    task.failMessage = undefined;
    this.applyTaskTiming(task, timing);
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
  }

  async completeMixTask(
    taskId: string,
    mixRenders: MixRenderRecord[],
    timing?: { processingStartedAt: string; totalWallTimeSec: number },
  ): Promise<void> {
    const task = await this.getTaskRecord(taskId);
    if (!task) return;
    task.status = "completed";
    task.mixRenders = mixRenders;
    task.outputUrls = mixRenders.map((r) => r.outputUrl);
    task.outputUrl = mixRenders[0]?.outputUrl;
    task.failMessage = undefined;
    this.applyTaskTiming(task, timing);
    task.updatedAt = nowWallClock();
    await this.clearEpisodeSubtitleRefs(task);
    await this.saveTask(task);
  }

  /**
   * 素材库手动推 TOS 后回写产出：追加 https URL，或把已有本地路径条目升级为 TOS。
   * 不整表替换、不清 ASR，避免覆盖同任务其它成片。
   */
  async appendTaskOutput(
    taskId: string,
    input: { outputUrl: string; localOutputPath?: string; filename?: string },
  ): Promise<{ outputUrls: string[]; mixRenders?: MixRenderRecord[] }> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const outputUrl = String(input.outputUrl || "").trim();
    if (!outputUrl) throw new Error("outputUrl required");

    const localPath = input.localOutputPath?.trim() || "";
    const filename = (
      input.filename ||
      basenameOfPath(localPath) ||
      basenameOfPath(outputUrl)
    ).trim();

    const useMix =
      task.taskKind === "drama_mix" || (task.mixRenders != null && task.mixRenders.length > 0);

    if (useMix) {
      const mixRenders = [...(task.mixRenders ?? [])];
      // 不走「仅 1 条就命中」：手动推送可能是新成片，避免误覆盖唯一条目
      const pathKey = normalizePathKey(localPath);
      const fileKey = filename.toLowerCase();
      let hitIdx = -1;
      for (let i = 0; i < mixRenders.length; i++) {
        const r = mixRenders[i]!;
        const local = normalizePathKey(r.localOutputPath || "");
        const url = normalizePathKey(r.outputUrl || "");
        const localName = basenameOfPath(r.localOutputPath || "").toLowerCase();
        const urlName = basenameOfPath(r.outputUrl || "").toLowerCase();
        if (
          (pathKey && local && (local === pathKey || local.endsWith(pathKey) || pathKey.endsWith(local))) ||
          (pathKey && url && (url === pathKey || url.endsWith("/" + fileKey) || url.endsWith(fileKey))) ||
          (fileKey && (localName === fileKey || urlName === fileKey))
        ) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        const prev = mixRenders[hitIdx]!;
        mixRenders[hitIdx] = {
          ...prev,
          outputUrl,
          localOutputPath: prev.localOutputPath || localPath || undefined,
          uploaded: true,
        };
      } else {
        const nextIndex = mixRenders.length + 1;
        mixRenders.push({
          round: 1,
          planIndex: nextIndex,
          planSeqInRound: nextIndex,
          outputUrl,
          localOutputPath: localPath || undefined,
          uploaded: true,
        });
      }
      task.mixRenders = mixRenders;
      task.outputUrls = mixRenders.map((r) => r.outputUrl);
      task.outputUrl = task.outputUrls[0];
    } else {
      const urls = [...(task.outputUrls ?? [])];
      if (task.outputUrl && !urls.includes(task.outputUrl)) urls.unshift(task.outputUrl);
      const fileKey = filename.toLowerCase();
      const pathKey = normalizePathKey(localPath);
      let replaced = false;
      for (let i = 0; i < urls.length; i++) {
        const cur = urls[i]!;
        const curKey = normalizePathKey(cur);
        const curBase = basenameOfPath(cur).toLowerCase();
        if (
          (pathKey && (curKey === pathKey || curKey.endsWith(pathKey) || pathKey.endsWith(curKey))) ||
          (fileKey && curBase === fileKey && !/^https?:\/\//i.test(cur))
        ) {
          urls[i] = outputUrl;
          replaced = true;
          break;
        }
      }
      if (!replaced && !urls.includes(outputUrl)) urls.push(outputUrl);
      task.outputUrls = urls;
      if (!task.outputUrl || !/^https?:\/\//i.test(task.outputUrl)) {
        task.outputUrl = outputUrl;
      }
    }

    if (task.status === "pending" || task.status === "processing") {
      task.status = "completed";
      task.failMessage = undefined;
    }
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
    return { outputUrls: task.outputUrls ?? [], mixRenders: task.mixRenders };
  }

  /**
   * 无父任务时：新建已完成任务并写入 clip_task_output（素材库孤儿成片推 TOS）
   */
  async registerUploadedOutput(input: {
    outputUrl: string;
    localOutputPath?: string;
    filename?: string;
    dramaTitle?: string;
    dramaId?: string;
    claimedBy?: string;
  }): Promise<{ taskId: string; outputUrls: string[] }> {
    const outputUrl = String(input.outputUrl || "").trim();
    if (!outputUrl) throw new Error("outputUrl required");
    const localPath =
      input.localOutputPath?.trim() ||
      input.filename?.trim() ||
      basenameOfPath(outputUrl) ||
      "upload.mp4";
    const { toClipLocalSourceUrl } = await import("@clip/sdk");
    const sourceUrl = toClipLocalSourceUrl(localPath);
    const title = (input.dramaTitle || "").trim() || "未分类";
    const dramaId =
      (input.dramaId || "").trim() ||
      `drama-lib-${createHash("sha1").update(title).digest("hex").slice(0, 16)}`;
    await this.ensureDramaStub(dramaId, { title });
    const created = await this.createTask({
      sourceUrl,
      dramaId,
      dramaMeta: { title },
      taskKind: "single",
      initialStatus: "processing",
      claimedBy: input.claimedBy,
    });
    await this.completeTask(created.taskId, outputUrl);
    return { taskId: created.taskId, outputUrls: [outputUrl] };
  }

  /** 创建短剧案例视频复刻任务：主任务复用 clip_task，扩展信息写入 clip_remix_job */
  async createRemixReplica(input: {
    dramaId?: string;
    caseVideoUrl: string;
    caseVideoUrls?: string[];
    episodeUrls?: string[];
    parentPackageTaskId?: string;
    intakeId?: string;
    externalDramaId?: string;
    fissionEnabled?: boolean;
    fissionOps?: string[];
    fissionCount?: number;
  }): Promise<{ task: ClipTask | null; remixJob: RemixJob }> {
    const { randomUUID } = await import("node:crypto");
    const jobId = randomUUID();
    if (!this.remixRepo) throw new Error("MySQL is required for remix replica");

    const caseVideoUrls = [
      ...new Set([...(input.caseVideoUrls ?? []).filter((url) => url.trim() !== ""), input.caseVideoUrl]),
    ];

    const fissionOptions = {
      fissionEnabled: input.fissionEnabled ?? false,
      fissionOps: input.fissionOps,
      fissionCount: input.fissionCount ?? 0,
    };

    // 新短剧复刻：先不写 clip_task，等短剧入库完成后再创建
    if (input.intakeId || input.externalDramaId) {
      const intakeId = input.intakeId ?? null;
      if (intakeId) {
        const existing = await this.remixRepo.findActiveByIntakeId(intakeId);
        if (existing) {
          return { task: null, remixJob: existing };
        }
      }
      const remixJob = await this.remixRepo.create({
        jobId,
        dramaId: null,
        intakeId,
        externalDramaId: input.externalDramaId ?? null,
        caseVideoUrl: input.caseVideoUrl,
        caseVideoUrls,
        episodeUrls: input.episodeUrls ?? [],
        parentPackageTaskId: null,
        status: "waiting_intake",
        ...fissionOptions,
      });
      return { task: null, remixJob };
    }

    if (!input.dramaId) throw new Error("dramaId 或 intakeId/externalDramaId 必填");
    const drama = await this.dramaRepo?.getDrama(input.dramaId);
    const task = await this.createTask({
      taskId: jobId,
      sourceUrl: input.caseVideoUrl,
      dramaId: input.dramaId,
      taskKind: "remix_replica",
      parentPackageTaskId: input.parentPackageTaskId,
      dramaMeta: {
        title: drama?.title ?? input.dramaId,
        remixCaseVideoUrl: input.caseVideoUrl,
        remixCaseVideoUrls: caseVideoUrls,
        remixEpisodeUrls: input.episodeUrls,
        remixParentPackageTaskId: input.parentPackageTaskId,
        remixFissionEnabled: fissionOptions.fissionEnabled,
        remixFissionOps: fissionOptions.fissionOps,
        remixFissionCount: fissionOptions.fissionCount,
      },
      initialStatus: "pending",
    });
    const remixJob = await this.remixRepo.create({
      jobId,
      dramaId: input.dramaId,
      caseVideoUrl: input.caseVideoUrl,
      caseVideoUrls,
      episodeUrls: input.episodeUrls ?? [],
      parentPackageTaskId: input.parentPackageTaskId ?? null,
      ...fissionOptions,
    });
    return { task, remixJob };
  }

  /** 短剧入库（activate-package）完成后，自动激活等待的复刻任务 */
  async activateWaitingRemixReplicas(intakeId: string, dramaId: string, parentPackageTaskId: string): Promise<void> {
    if (!this.remixRepo) return;
    const waiting = await this.remixRepo.listWaitingByIntakeId(intakeId);
    if (!waiting.length) return;

    for (const job of waiting) {
      const drama = await this.dramaRepo?.getDrama(dramaId);
      const task = await this.createTask({
        taskId: job.jobId,
        sourceUrl: job.caseVideoUrl,
        dramaId,
        taskKind: "remix_replica",
        parentPackageTaskId,
        dramaMeta: {
          title: drama?.title ?? dramaId,
          remixCaseVideoUrl: job.caseVideoUrl,
          remixCaseVideoUrls: job.caseVideoUrls,
          remixEpisodeUrls: job.episodeUrls,
          remixParentPackageTaskId: parentPackageTaskId,
          remixFissionEnabled: job.fissionEnabled,
          remixFissionOps: job.fissionOps,
          remixFissionCount: job.fissionCount,
        },
        initialStatus: "pending",
      });
      await this.remixRepo.activateWaiting(job.jobId, { dramaId, parentPackageTaskId });
      console.log(
        `[remix-replica] intake ${intakeId} 完成，激活复刻任务 ${job.jobId} -> dramaId=${dramaId} parent=${parentPackageTaskId}`,
      );
    }
  }

  async getRemixReplica(jobId: string): Promise<{ task: ClipTask | null; remixJob: RemixJob | null }> {
    const remixJob = await this.remixRepo?.findById(jobId) ?? null;
    if (!remixJob) return { task: null, remixJob: null };
    const task = remixJob.status === "waiting_intake" ? null : await this.getTaskForAgent(jobId);
    return { task, remixJob };
  }

  async listRemixReplicasByDrama(
    dramaId?: string,
  ): Promise<{ task: ClipTask | null; remixJob: RemixJob }[]> {
    if (!this.remixRepo) throw new Error("MySQL is required for remix replica");
    const jobs = dramaId ? await this.remixRepo.listByDrama(dramaId) : await this.remixRepo.listAll();
    const taskIds = jobs.filter((j) => j.status !== "waiting_intake").map((j) => j.jobId);
    const taskMap = new Map<string, ClipTask>();
    if (taskIds.length) {
      const tasks = await Promise.all(taskIds.map((id) => this.getTaskForAgent(id)));
      for (const task of tasks) {
        if (task) taskMap.set(task.taskId, task);
      }
    }
    return jobs.map((remixJob) => ({ remixJob, task: taskMap.get(remixJob.jobId) ?? null }));
  }

  /** 客户端 claim 复刻任务后更新扩展表状态 */
  async claimRemixReplica(jobId: string, deviceId: string): Promise<void> {
    if (!this.remixRepo) return;
    // 分工为 mix 的设备不允许认领复刻任务
    if (normalizeAgentTaskQueue(this.state.deviceOverrides[deviceId]?.services?.taskQueue) === "mix") {
      throw new Error("该设备已分工为混剪队列，不能领取案例复刻任务");
    }
    await this.remixRepo.claim(jobId, deviceId);
  }

  /** 父任务尚未完成时，把已领取的复刻任务恢复为 pending，等待后续重新领取 */
  async releaseRemixReplicaClaim(jobId: string): Promise<void> {
    if (!this.remixRepo) return;
    await this.remixRepo.releaseClaim(jobId);
    await this.requireTaskRepo().releaseRemixReplicaClaim(jobId);
  }

  /** 客户端上报复刻阶段状态 */
  async updateRemixReplicaStatus(
    jobId: string,
    status: RemixJob["status"],
    patch?: { timeline?: Record<string, unknown>; errorMessage?: string },
  ): Promise<void> {
    if (!this.remixRepo) return;
    await this.remixRepo.updateStatus(jobId, status, patch);
  }

  async getRemixFeatureCache(
    dramaId: string,
  ): Promise<{ objectKey: string; fingerprint: string; sizeBytes: number; frameCount: number; sourceCount: number; updatedAt: string } | null> {
    if (!this.dramaRepo) return null;
    return this.dramaRepo.getRemixFeatureCache(dramaId);
  }

  async setRemixFeatureCache(
    dramaId: string,
    input: {
      objectKey: string;
      fingerprint: string;
      sizeBytes: number;
      frameCount: number;
      sourceCount: number;
    },
  ): Promise<void> {
    if (!this.dramaRepo) throw new Error("MySQL is required for remix feature cache");
    await this.dramaRepo.setRemixFeatureCache({
      dramaId,
      objectKey: input.objectKey,
      fingerprint: input.fingerprint,
      sizeBytes: input.sizeBytes,
      frameCount: input.frameCount,
      sourceCount: input.sourceCount,
      updatedAt: new Date().toISOString(),
    });
  }

  private async releaseRemixReplicaAfterPackageComplete(packageTaskId: string): Promise<void> {
    const released = await this.requireTaskRepo().clearParentPackageTaskId(packageTaskId);
    if (released > 0) {
      console.log(`[remix-replica] 剧包 ${packageTaskId} 完成，释放 ${released} 个等待的复刻任务`);
      void this.notifyTopLevelPending(released);
    }
  }

  private applyTaskTiming(
    task: TaskRecord,
    timing?: { processingStartedAt: string; totalWallTimeSec: number },
  ): void {
    if (!timing) return;
    task.processingStartedAt = timing.processingStartedAt;
    task.processingCompletedAt = nowWallClock();
    task.totalWallTimeSec = Math.round(timing.totalWallTimeSec * 10) / 10;
  }

  /** 混剪完成时清除参与混剪各集的 ASR 字幕文件引用，返回对应 episode_asr 任务 ID */
  private async clearEpisodeSubtitleRefs(task: TaskRecord): Promise<string[]> {
    if (!task.dramaId || !task.mixEpisodeIds?.length) return [];

    const episodes = this.state.dramaEpisodes[task.dramaId] ?? [];
    const taskIds: string[] = [];
    for (const episodeId of task.mixEpisodeIds) {
      const episode = episodes.find((ep) => ep.episodeId === episodeId);
      if (!episode) continue;
      episode.subtitleUrl = undefined;
      episode.subtitlesJsonUrl = undefined;
      episode.updatedAt = nowWallClock();
      if (episode.taskId) taskIds.push(episode.taskId);
    }
    await this.dramaRepo!.clearEpisodeSubtitles(task.dramaId, task.mixEpisodeIds);
    return taskIds;
  }

  async getEpisodeAsrTaskIdsForMix(mixTaskId: string): Promise<string[]> {
    const task = await this.getTaskRecord(mixTaskId);
    if (!task) return [];
    return this.clearEpisodeSubtitleRefs(task);
  }

  async failTask(taskId: string, message: string): Promise<void> {
    const task = await this.getTaskRecord(taskId);
    if (!task) return;
    // 保护重跑：若任务已被用户/系统重置为 pending，说明旧执行流已被废弃，
    // 此时旧 Agent 的迟到 fail 上报不应覆盖新的 pending 状态，避免“重跑后立即失败”。
    if (task.status === "pending") {
      console.warn(`[failTask] 忽略对 pending 任务的迟到失败上报 task=${taskId} msg=${message.slice(0, 200)}`);
      return;
    }

    // 可恢复外部依赖故障（如 funasr-gpu CUDA 报错）：不把任务置为 failed，
    // 而是释放回 pending 并清空认领信息，让其他 Agent 在资源恢复后继续认领重试。
    if (isRecoverableAgentError(message)) {
      console.warn(`[failTask] 可恢复外部错误，任务回退 pending 等待重试 task=${taskId} msg=${message.slice(0, 200)}`);
      task.status = "pending";
      task.claimedBy = undefined;
      task.claimedAt = undefined;
      task.failMessage = message.slice(0, 500);
      task.updatedAt = nowWallClock();
      await this.saveTask(task);
      void this.notifyTopLevelPending(1);
      return;
    }

    task.status = "failed";
    task.failMessage = message;
    if (task.dramaPackage) task.dramaPackage.phase = "failed";
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
  }

  /** 删除任务及级联数据；drama_package 会同时删除其下所有 episode_asr / drama_mix 子任务 */
  async deleteTask(taskId: string): Promise<string[]> {
    const task = await this.getTaskRecord(taskId);
    if (!task) return [];

    const deletedIds = await this.requireTaskRepo().deleteTask(taskId);

    // 清理内存状态
    if (task.taskKind === "drama_package" && task.dramaId) {
      this.state.dramaEpisodes[task.dramaId] = [];
      await this.dramaRepo!.deleteEpisodesByDrama(task.dramaId);
    }

    return deletedIds;
  }

  async retryTask(taskId: string): Promise<ClipTask> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error("task not found");

    const asrTaskIds = new Set<string>();
    if (task.taskKind === "drama_package" && task.dramaId) {
      const childTaskIds = await this.requireTaskRepo().deleteByParentPackageTaskId(taskId);
      for (const id of childTaskIds) asrTaskIds.add(id);
      this.state.dramaEpisodes[task.dramaId] = [];
      await this.dramaRepo!.deleteEpisodesByDrama(task.dramaId);
    }

    if (task.taskKind === "episode_asr" && task.dramaId && task.episodeId) {
      asrTaskIds.add(taskId);
      await this.resetEpisodeForRetry(task.dramaId, task.episodeId);
    }

    if (task.taskKind === "single" || task.taskKind === "drama_mix") {
      asrTaskIds.add(taskId);
    }

    for (const id of asrTaskIds) {
      await this.asrRepo?.deleteByTaskId(id);
    }

    task.status = "pending";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.processingStartedAt = undefined;
    task.processingCompletedAt = undefined;
    task.totalWallTimeSec = undefined;
    task.plan = undefined;
    task.planBatches = undefined;
    task.outputUrl = undefined;
    task.outputUrls = [];
    task.mixRenders = [];
    task.failMessage = undefined;
    if (task.taskKind === "drama_package" && task.dramaPackage) {
      task.dramaPackage = {
        ...task.dramaPackage,
        phase: "pending",
        episodeCount: undefined,
      };
    }
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
    void this.notifyTopLevelPending(1);
    return this.toTask(task);
  }

  async setDramaPackagePriority(taskId: string, priority: boolean): Promise<ClipTask> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error("task not found");
    if (task.taskKind !== "drama_package") {
      throw new Error("only drama_package tasks support priority");
    }
    if (task.status !== "pending") {
      throw new Error("only pending tasks can change priority");
    }
    const updated = await this.requireTaskRepo().setDramaPackagePriority(taskId, priority);
    if (!updated) throw new Error("task is no longer pending");
    return this.toTask(updated);
  }

  private async resetEpisodeForRetry(dramaId: string, episodeId: string): Promise<void> {
    const episodes = this.state.dramaEpisodes[dramaId] ?? [];
    const episode = episodes.find((ep) => ep.episodeId === episodeId);
    if (!episode) return;

    episode.status = "pending_asr";
    episode.rawSegmentCount = undefined;
    episode.subtitleUrl = undefined;
    episode.subtitlesJsonUrl = undefined;
    episode.failMessage = undefined;
    episode.updatedAt = nowWallClock();

    await this.dramaRepo!.updateEpisodeAsr(dramaId, episodeId, {
      status: "pending_asr",
      rawSegmentCount: undefined,
      subtitleUrl: undefined,
      subtitlesJsonUrl: undefined,
      failMessage: null,
    });
  }

  async allocatePackageName(title: string): Promise<{ packageName: string; dedupSeq: number; safeTitle: string }> {
    const safeTitle = sanitizeDramaPackageTitle(title);
    const dedupSeq = await this.requireTaskRepo().allocatePackageSeq(safeTitle);
    return {
      safeTitle,
      dedupSeq,
      packageName: formatDramaPackageName(title, dedupSeq),
    };
  }

  async createDramaPackageTask(input: {
    title: string;
    sourceUrl: string;
    packageObjectKey: string;
    packageName: string;
    dedupSeq: number;
    templateId?: string;
    asrRuleSetId?: string;
    expectedEpisodeCount?: number;
    synopsis?: string;
    dramaType?: DramaIntakeType;
    dramaMeta?: import("@clip/sdk").DramaMeta;
  }): Promise<ClipTask> {
    const dramaId = `drama-pkg-${randomUUID().slice(0, 8)}`;
  const synopsis = input.synopsis?.trim() || input.dramaMeta?.synopsis?.trim();
  const dramaType = input.dramaType || input.dramaMeta?.dramaType;
  const dramaMetaSnapshot = normalizeDramaMeta({
    ...input.dramaMeta,
    title: input.title,
    synopsis: synopsis || undefined,
    synopsisSource: synopsis ? "manual" : undefined,
    packageName: input.packageName,
    dramaType,
  });

    if (!this.state.dramas[dramaId]) {
      const drama: DramaInfo = {
        dramaId,
        title: input.title,
        asrRuleSetId: input.asrRuleSetId ?? defaultRules.ruleSetId,
        meta: dramaMetaSnapshot,
      };
      await this.persistDrama(drama);
    }
    if (!this.state.dramaEpisodes[dramaId]) {
      this.state.dramaEpisodes[dramaId] = [];
    }

    const dramaPackage: DramaPackageMeta & { priority: number } = {
      title: input.title,
      dedupSeq: input.dedupSeq,
      packageObjectKey: input.packageObjectKey,
      packageName: input.packageName,
      expectedEpisodeCount: input.expectedEpisodeCount,
      phase: "pending",
      // 通过 JSON 元数据持久化，保持 Agent 任务协议兼容，无需客户端升级。
      priority: 0,
    };

    const task = await this.requireTaskRepo().create({
      templateId: input.templateId ?? "vertical_hook_60s",
      asrRuleSetId: input.asrRuleSetId ?? defaultRules.ruleSetId,
      configVersion: this.state.profile.configVersion,
      sourceUrl: input.sourceUrl,
      dramaId,
      dramaMeta: dramaMetaSnapshot as Record<string, unknown>,
      taskKind: "drama_package",
      dramaPackage,
      status: "pending",
    });
    void this.notifyTopLevelPending(1);
    warnIfMissingSynopsis("createDramaPackageTask", dramaMetaSnapshot as Record<string, unknown>, dramaId);
    return this.toTask(task);
  }

  async updateDramaMeta(
    dramaId: string,
    patch: Partial<DramaMeta> & { title?: string },
  ): Promise<DramaInfo> {
    const drama = this.state.dramas[dramaId];
    if (!drama) throw new Error("drama not found");
    const titlePatch = patch.title?.trim();
    if (titlePatch) {
      drama.title = titlePatch;
    }
    const nextMeta = normalizeDramaMeta({
      ...drama.meta,
      ...patch,
      title: titlePatch || patch.title || drama.meta?.title,
      synopsisSource: patch.synopsis !== undefined
        ? (patch.synopsis?.trim() ? "manual" : undefined)
        : drama.meta?.synopsisSource,
    });
    // 允许清空简介：显式传空字符串时去掉 synopsis
    if (patch.synopsis !== undefined && !String(patch.synopsis).trim()) {
      delete nextMeta.synopsis;
      delete nextMeta.synopsisSource;
    }
    drama.meta = Object.keys(nextMeta).length ? nextMeta : undefined;
    await this.persistDrama(drama);
    return drama;
  }

  async updatePackagePhase(
    taskId: string,
    phase: DramaPackageMeta["phase"],
    extra?: Partial<DramaPackageMeta>,
  ): Promise<void> {
    const task = await this.getTaskRecord(taskId);
    if (!task?.dramaPackage) return;
    task.dramaPackage = { ...task.dramaPackage, phase, ...extra };
    task.updatedAt = nowWallClock();
    await this.saveTask(task);
  }

  async completePackageTask(
    packageTaskId: string,
    mixTaskId: string,
    timing?: { processingStartedAt: string; totalWallTimeSec: number },
  ): Promise<ClipTask | null> {
    const pkg = await this.getTaskRecord(packageTaskId);
    const mix = await this.getTaskRecord(mixTaskId);
    if (!pkg || pkg.taskKind !== "drama_package") return null;

    pkg.status = "completed";
    pkg.outputUrl = mix?.outputUrl ?? mix?.outputUrls?.[0];
    pkg.outputUrls = mix?.outputUrls;
    pkg.mixRenders = mix?.mixRenders ?? [];
    if (pkg.dramaPackage) {
      pkg.dramaPackage.phase = "completed";
      pkg.dramaPackage.episodeCount = mix?.mixEpisodeIds?.length;
    }
    this.applyTaskTiming(pkg, timing);
    pkg.updatedAt = nowWallClock();
    await this.saveTask(pkg);

    // 剧包完成时，释放等待该剧包分集的复刻任务，使其进入可领取队列
    await this.releaseRemixReplicaAfterPackageComplete(packageTaskId);

    return this.toTask(pkg);
  }

  async createTask(input: {
    taskId?: string;
    sourceUrl: string;
    templateId?: string;
    dramaId?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
    taskKind?: ClipTaskKind;
    episodeNo?: number;
    episodeId?: string;
    mixEpisodeIds?: string[];
    parentPackageTaskId?: string;
    claimedBy?: string;
    initialStatus?: ClipTask["status"];
    dramaPackage?: DramaPackageMeta;
  }): Promise<ClipTask> {
    if (input.dramaId) {
      await this.ensureDramaStub(input.dramaId, input.dramaMeta, input.asrRuleSetId);
    }
    const drama = input.dramaId ? this.state.dramas[input.dramaId] : undefined;
    const task = await this.requireTaskRepo().create({
      taskId: input.taskId,
      templateId: input.templateId,
      asrRuleSetId: input.asrRuleSetId ?? drama?.asrRuleSetId,
      configVersion: this.state.profile.configVersion,
      sourceUrl: input.sourceUrl,
      dramaId: input.dramaId,
      dramaMeta: input.dramaMeta ?? (drama ? { title: drama.title } : undefined),
      taskKind: input.taskKind,
      episodeNo: input.episodeNo,
      episodeId: input.episodeId,
      mixEpisodeIds: input.mixEpisodeIds,
      parentPackageTaskId: input.parentPackageTaskId,
      dramaPackage: input.dramaPackage,
      status: input.initialStatus,
      claimedBy: input.claimedBy,
    });
    if (task.status === "pending" && !task.parentPackageTaskId) {
      void this.notifyTopLevelPending(1);
    }
    return this.toTask(task);
  }

  /** 登记分集前保证剧目行存在，否则重启 hydrate 会丢掉孤儿分集 */
  async ensureDramaStubForClient(
    dramaId: string,
    dramaMeta?: Record<string, unknown>,
    asrRuleSetId?: string,
  ): Promise<void> {
    return this.ensureDramaStub(dramaId, dramaMeta, asrRuleSetId);
  }

  private async ensureDramaStub(
    dramaId: string,
    dramaMeta?: Record<string, unknown>,
    asrRuleSetId?: string,
  ): Promise<void> {
    if (this.state.dramas[dramaId]) {
      if (!this.state.dramaEpisodes[dramaId]) this.state.dramaEpisodes[dramaId] = [];
      // 已有剧目时补全缺失的简介/题材（不覆盖已有非空值）
      if (dramaMeta) {
        const existing = this.state.dramas[dramaId]!;
        const incoming = normalizeDramaMeta(dramaMeta);
        const patch: Partial<import("@clip/sdk").DramaMeta> & { title?: string } = {};
        if (!existing.meta?.synopsis?.trim() && incoming.synopsis?.trim()) {
          patch.synopsis = incoming.synopsis.trim();
        }
        if (
          !(existing.meta?.genreTags?.length) &&
          incoming.genreTags?.length
        ) {
          patch.genreTags = incoming.genreTags;
        }
        if (Object.keys(patch).length) {
          await this.updateDramaMeta(dramaId, patch);
        }
      }
      return;
    }
    const title =
      (typeof dramaMeta?.title === "string" && dramaMeta.title.trim()) ||
      (typeof dramaMeta?.dramaTitle === "string" && String(dramaMeta.dramaTitle).trim()) ||
      dramaId;
    const drama: DramaInfo = {
      dramaId,
      title,
      asrRuleSetId: asrRuleSetId ?? defaultRules.ruleSetId,
      meta: dramaMeta ? normalizeDramaMeta(dramaMeta) : undefined,
    };
    await this.persistDrama(drama);
    if (!this.state.dramaEpisodes[dramaId]) this.state.dramaEpisodes[dramaId] = [];
  }

  /** 只读版本：查询接口不应触发写库；内存无该剧时直接返回不创建 stub */
  private requireDramaStub(dramaId: string): void {
    if (!this.state.dramaEpisodes[dramaId]) this.state.dramaEpisodes[dramaId] = [];
  }

  /**
   * 混剪对齐：按集号查 MySQL ASR；已有识别则回填/复用分集（asr_done），不再建新 ASR 任务。
   */
  async ensureEpisodesForMix(
    dramaId: string,
    items: Array<{ episodeNo: number; sourceUrl: string; title?: string; filename?: string }>,
    options?: { dramaMeta?: Record<string, unknown>; asrRuleSetId?: string; deviceId?: string },
  ): Promise<Array<{ episode: DramaEpisodeRecord; asrReady: boolean; reusedAsr: boolean }>> {
    await this.ensureDramaStub(dramaId, options?.dramaMeta, options?.asrRuleSetId);
    const out: Array<{ episode: DramaEpisodeRecord; asrReady: boolean; reusedAsr: boolean }> = [];

    for (const item of items) {
      const fromFilename =
        parseEpisodeNoFromMediaPath(item.filename ?? "") ??
        parseEpisodeNoFromMediaPath(item.sourceUrl);
      const episodeNo = fromFilename ?? item.episodeNo;
      const episodeId = episodeIdFromNo(episodeNo);
      let episode = this.listDramaEpisodes(dramaId).find(
        (ep) => ep.episodeNo === episodeNo || ep.episodeId === episodeId,
      );

      // 1) 优先按剧+集号查 ASR 表（分集行缺失时仍能命中）
      let asr = await this.resolveAsrResult({ dramaId, episodeNo });
      if (!asr?.segments?.length && episode?.episodeId) {
        asr = await this.resolveAsrResult({ episodeId: episode.episodeId });
      }
      if (!asr?.segments?.length && episode?.taskId) {
        asr = await this.getAsrResult(episode.taskId);
      }

      if (asr?.segments?.length) {
        const now = nowWallClock();
        if (!episode) {
          episode = {
            episodeId: asr.episodeId || episodeId,
            dramaId,
            episodeNo: asr.episodeNo ?? episodeNo,
            title: item.title ?? `第${episodeNo}集`,
            sourceUrl: item.sourceUrl,
            status: "asr_done",
            taskId: asr.taskId,
            rawSegmentCount: asr.finalSegmentCount ?? asr.segments.length,
            subtitleUrl: asr.subtitleUrl,
            subtitlesJsonUrl: asr.subtitlesJsonUrl,
            createdAt: now,
            updatedAt: now,
          };
          await this.persistEpisode(episode);
        } else {
          episode.status = "asr_done";
          episode.taskId = asr.taskId;
          episode.sourceUrl = item.sourceUrl || episode.sourceUrl;
          episode.rawSegmentCount = asr.finalSegmentCount ?? asr.segments.length;
          episode.failMessage = undefined;
          episode.updatedAt = now;
          await this.persistEpisode(episode);
        }
        out.push({ episode, asrReady: true, reusedAsr: true });
        continue;
      }

      // 2) 无 ASR：已有分集则待补识别；无分集则登记新 episode_asr 任务
      if (!episode) {
        const registered = await this.registerEpisode({
          dramaId,
          sourceUrl: item.sourceUrl,
          filename: item.filename,
          episodeNo,
          title: item.title,
          dramaMeta: options?.dramaMeta,
          asrRuleSetId: options?.asrRuleSetId,
          deviceId: options?.deviceId,
        });
        out.push({ episode: registered.episode, asrReady: false, reusedAsr: false });
      } else {
        out.push({
          episode,
          asrReady: episode.status === "asr_done",
          reusedAsr: false,
        });
      }
    }

    return out;
  }

  async registerEpisode(input: {
    dramaId: string;
    sourceUrl: string;
    filename?: string;
    episodeNo?: number;
    title?: string;
    dramaMeta?: Record<string, unknown>;
    asrRuleSetId?: string;
    packageTaskId?: string;
    deviceId?: string;
  }): Promise<{ episode: DramaEpisodeRecord; task: ClipTask }> {
    await this.ensureDramaStub(input.dramaId, input.dramaMeta, input.asrRuleSetId);
    if (!this.state.dramaEpisodes[input.dramaId]) {
      this.state.dramaEpisodes[input.dramaId] = [];
    }
    const existing = this.state.dramaEpisodes[input.dramaId]!;
    const fromFilename =
      parseEpisodeNoFromMediaPath(input.filename ?? "") ??
      parseEpisodeNoFromMediaPath(input.sourceUrl);
    let episodeNo = input.episodeNo;
    if (fromFilename != null) {
      if (episodeNo != null && episodeNo !== fromFilename) {
        console.warn(
          `[clip-api] registerEpisode ${input.dramaId}: agent episodeNo=${episodeNo} 与文件名集号=${fromFilename} 不一致，以文件名为准 (${input.filename ?? input.sourceUrl})`,
        );
      }
      episodeNo = fromFilename;
    } else {
      episodeNo = episodeNo ?? existing.length + 1;
    }
    const episodeId = episodeIdFromNo(episodeNo);

    const existingEpisode = existing.find((ep) => ep.episodeId === episodeId);
    if (existingEpisode) {
      // 幂等：同一剧集包重试或 Agent 重复注册时，复用/重建分集 ASR 任务，而非 500
      let taskRecord = existingEpisode.taskId
        ? await this.getTaskRecord(existingEpisode.taskId)
        : null;

      if (!taskRecord || taskRecord.status === "failed") {
        // 旧任务丢失或已失败：新建 episode_asr 任务
        taskRecord = await this.requireTaskRepo().create({
          templateId: "",
          asrRuleSetId: input.asrRuleSetId ?? this.state.dramas[input.dramaId]?.asrRuleSetId,
          configVersion: this.state.profile.configVersion,
          sourceUrl: input.sourceUrl,
          dramaId: input.dramaId,
          dramaMeta: input.dramaMeta ?? (this.state.dramas[input.dramaId]
            ? { title: this.state.dramas[input.dramaId]!.title }
            : undefined),
          taskKind: "episode_asr",
          episodeNo,
          episodeId,
          parentPackageTaskId: input.packageTaskId,
          claimedBy: input.packageTaskId ? input.deviceId : undefined,
          status: input.packageTaskId ? "processing" : "pending",
        });
        existingEpisode.taskId = taskRecord.taskId;
        existingEpisode.status = "pending_asr";
        existingEpisode.failMessage = undefined;
        existingEpisode.updatedAt = nowWallClock();
        await this.persistEpisode(existingEpisode);
      } else if (input.packageTaskId) {
        // 复用已有任务，挂到当前剧集包并由当前设备认领
        taskRecord.parentPackageTaskId = input.packageTaskId;
        if (input.deviceId) {
          taskRecord.claimedBy = input.deviceId;
        }
        taskRecord.updatedAt = nowWallClock();
        await this.saveTask(taskRecord);
      }

      return { episode: existingEpisode, task: this.toTask(taskRecord) };
    }

    const now = nowWallClock();
    const task = await this.createTask({
      sourceUrl: input.sourceUrl,
      dramaId: input.dramaId,
      dramaMeta: input.dramaMeta,
      asrRuleSetId: input.asrRuleSetId,
      taskKind: "episode_asr",
      episodeNo,
      episodeId,
      parentPackageTaskId: input.packageTaskId,
      claimedBy: input.packageTaskId ? input.deviceId : undefined,
      initialStatus: input.packageTaskId ? "processing" : "pending",
    });

    const episode: DramaEpisodeRecord = {
      episodeId,
      dramaId: input.dramaId,
      episodeNo,
      title: input.title ?? `第${episodeNo}集`,
      sourceUrl: input.sourceUrl,
      status: "pending_asr",
      taskId: task.taskId,
      createdAt: now,
      updatedAt: now,
    };
    existing.push(episode);
    existing.sort((a, b) => a.episodeNo - b.episodeNo);
    await this.persistEpisode(episode);
    return { episode, task };
  }

  listDramaEpisodes(dramaId: string): DramaEpisodeRecord[] {
    return [...(this.state.dramaEpisodes[dramaId] ?? [])].sort(
      (a, b) => a.episodeNo - b.episodeNo,
    );
  }

  /**
   * 列表用：以 MySQL clip_asr_result 为准回填分集 status。
   * 避免「ASR 还在库里，但分集行丢失/未 hydrate → 界面显示未识别」。
   * 注意：返回内存现有分集，reconcile 异步后台执行，避免查询接口被 DB 写入阻塞导致 502。
   */
  async listDramaEpisodesReconciled(dramaId: string): Promise<DramaEpisodeRecord[]> {
    // 查询路径只读，不隐式创建 drama stub 写库
    this.requireDramaStub(dramaId);
    const snapshot = this.listDramaEpisodes(dramaId);

    // 后台异步 reconcile：不阻塞 API 响应
    if (this.asrRepo) {
      this.reconcileDramaEpisodesAsync(dramaId).catch((err) => {
        console.error("[clip-api] async reconcile episodes failed", dramaId, err);
      });
    }

    return snapshot;
  }

  /**
   * 批量查询多部剧分集：一次返回，减少前端并发请求。
   * reconcile 仍在后台异步执行，不阻塞响应。
   */
  async listDramasEpisodesReconciledBatch(
    dramaIds: string[],
  ): Promise<Record<string, DramaEpisodeRecord[]>> {
    const uniqueIds = [...new Set(dramaIds.map((id) => String(id || "").trim()).filter(Boolean))];
    const result: Record<string, DramaEpisodeRecord[]> = {};
    for (const id of uniqueIds) {
      this.requireDramaStub(id);
      result[id] = this.listDramaEpisodes(id);
      if (this.asrRepo) {
        this.reconcileDramaEpisodesAsync(id).catch((err) => {
          console.error("[clip-api] async reconcile episodes failed", id, err);
        });
      }
    }
    return result;
  }

  private async reconcileDramaEpisodesAsync(dramaId: string): Promise<void> {
    const byNo = new Map(this.listDramaEpisodes(dramaId).map((ep) => [ep.episodeNo, ep]));
    try {
      const { results } = await this.asrRepo!.listSummaries({
        dramaId,
        taskKind: "episode_asr",
        limit: 200,
        offset: 0,
      });
      // 同集多条时 list 已按 updated_at DESC，先到先得
      const seenNo = new Set<number>();
      for (const row of results) {
        const episodeNo = row.episodeNo;
        if (episodeNo == null || !Number.isFinite(episodeNo)) continue;
        if (seenNo.has(episodeNo)) continue;
        const hasSegs = (row.finalSegmentCount ?? 0) > 0;
        if (!hasSegs) continue;
        seenNo.add(episodeNo);

        const existing = byNo.get(episodeNo);
        if (existing) {
          if (existing.status !== "asr_done" || existing.taskId !== row.taskId) {
            existing.status = "asr_done";
            existing.taskId = row.taskId;
            existing.rawSegmentCount = row.finalSegmentCount;
            existing.subtitleUrl = row.subtitleUrl;
            existing.subtitlesJsonUrl = row.subtitlesJsonUrl;
            existing.failMessage = undefined;
            existing.updatedAt = nowWallClock();
            await this.persistEpisode(existing);
          }
          continue;
        }

        const episode: DramaEpisodeRecord = {
          episodeId: row.episodeId || episodeIdFromNo(episodeNo),
          dramaId,
          episodeNo,
          title: `第${episodeNo}集`,
          sourceUrl: row.sourceUrl || "",
          status: "asr_done",
          taskId: row.taskId,
          rawSegmentCount: row.finalSegmentCount,
          subtitleUrl: row.subtitleUrl,
          subtitlesJsonUrl: row.subtitlesJsonUrl,
          createdAt: row.savedAt || nowWallClock(),
          updatedAt: nowWallClock(),
        };
        await this.persistEpisode(episode);
        byNo.set(episodeNo, episode);
      }
    } catch (err) {
      console.error("[clip-api] reconcile episodes from ASR failed", dramaId, err);
    }
  }

  /** 从剧目 meta/简介/开场 ASR 解析高光题材，供 ASR 标签与混剪预标 */
  private resolveDramaGenreAnnotateOptions(
    dramaId?: string | null,
    asrSampleTexts?: string[],
  ): {
    genreProfile?: import("@clip/sdk").GenreProfile;
    title?: string;
    synopsis?: string;
    genreTags?: string[];
  } {
    if (!dramaId) return {};
    const drama = this.state.dramas[dramaId];
    if (!drama) return {};
    const title = drama.title || drama.meta?.title || drama.meta?.dramaTitle;
    const synopsis = drama.meta?.synopsis;
    const genreTags = drama.meta?.genreTags;
    const genreProfile = resolveGenreProfile({
      genreProfile: drama.meta?.genreProfile,
      title,
      synopsis,
      genreTags,
      asrSampleTexts,
    });
    return { genreProfile, title, synopsis, genreTags };
  }

  async createDramaMixTask(
    dramaId: string,
    episodeIds?: string[],
    options?: { packageTaskId?: string; deviceId?: string },
  ): Promise<ClipTask> {
    const episodes = (await this.listDramaEpisodesReconciled(dramaId)).filter(
      (ep) => ep.status === "asr_done",
    );
    const selected = episodeIds?.length
      ? episodes.filter((ep) => episodeIds.includes(ep.episodeId))
      : episodes;

    if (selected.length === 0) {
      throw new Error(`drama ${dramaId} 没有已完成 ASR 的集数，无法创建混剪任务`);
    }

    const drama = this.state.dramas[dramaId];
    const first = selected[0]!;
    const episodeMeta = await Promise.all(
      selected.map(async (ep) => {
        let segmentCount = 0;
        let durationSec = 0;
        if (ep.taskId && this.asrRepo) {
          const asr = await this.asrRepo.findByTaskId(ep.taskId);
          segmentCount = asr?.finalSegmentCount ?? 0;
          durationSec = asr?.segments?.length
            ? Math.ceil((asr.segments.at(-1)?.endMs ?? 0) / 1000)
            : 0;
        }
        return {
          episodeId: ep.episodeId,
          episodeNo: ep.episodeNo,
          segmentCount,
          durationSec,
        };
      }),
    );
    const mixMeta = snapshotDramaMetaForTask(drama, {
      episodeCount: selected.length,
      episodes: episodeMeta,
    });
    warnIfMissingSynopsis("createDramaMixTask", mixMeta as Record<string, unknown>, dramaId);
    return this.createTask({
      sourceUrl: first.sourceUrl,
      dramaId,
      dramaMeta: mixMeta as Record<string, unknown>,
      asrRuleSetId: drama?.asrRuleSetId,
      taskKind: "drama_mix",
      mixEpisodeIds: selected.map((ep) => ep.episodeId),
      parentPackageTaskId: options?.packageTaskId,
      claimedBy: options?.packageTaskId ? options.deviceId : undefined,
      initialStatus: options?.packageTaskId ? "processing" : "pending",
    });
  }

  private async updateEpisodeAsr(
    dramaId: string,
    episodeId: string,
    segments: AsrSegment[],
    rawCount?: number,
    extras?: {
      rawSegments?: RawAsrSegment[];
      subtitleUrl?: string;
      subtitlesJsonUrl?: string;
    },
  ): Promise<void> {
    const episodes = this.state.dramaEpisodes[dramaId] ?? [];
    const episode = episodes.find((ep) => ep.episodeId === episodeId);
    if (!episode) throw new Error(`episode not found: ${episodeId}`);

    episode.rawSegmentCount = rawCount ?? segments.length;
    episode.subtitleUrl = extras?.subtitleUrl;
    episode.subtitlesJsonUrl = extras?.subtitlesJsonUrl;
    episode.status = "asr_done";
    episode.failMessage = undefined;
    episode.updatedAt = nowWallClock();

    await this.dramaRepo!.updateEpisodeAsr(dramaId, episodeId, {
      status: "asr_done",
      rawSegmentCount: episode.rawSegmentCount,
      subtitleUrl: episode.subtitleUrl,
      subtitlesJsonUrl: episode.subtitlesJsonUrl,
      failMessage: null,
    });
  }

  async getMixSegmentsForTask(taskId: string): Promise<AsrSegment[]> {
    const task = await this.getTaskRecord(taskId);
    if (!task) throw new Error("task not found");
    if (task.taskKind !== "drama_mix") {
      throw new Error("only drama_mix tasks have mix segments");
    }
    return this.getMergedSegmentsForMixTask(task);
  }

  /** 解析到实际存有 planBatches 的混剪子任务（剧包任务本身不存 planBatches） */
  private async resolveMixTaskWithPlans(task: TaskRecord): Promise<TaskRecord | null> {
    if (task.taskKind === "drama_mix" && task.planBatches?.length) return task;
    if (task.taskKind === "drama_package" && task.dramaId) {
      return this.requireTaskRepo().findLatestMixWithPlanBatches(task.dramaId, task.taskId);
    }
    if (task.dramaId) {
      return this.requireTaskRepo().findLatestMixWithPlanBatches(task.dramaId);
    }
    return null;
  }

  /**
   * 成片预览：匹配 mixRender + 方案，返回基本信息与映射到成片轴的台词/高光。
   */
  async inspectTaskOutput(
    taskId: string,
    opts: { path?: string; fileName?: string } = {},
  ): Promise<{
    taskId: string;
    sourceTaskId: string;
    taskKind: string;
    dramaId?: string;
    dramaTitle?: string;
    matchedBy: string;
    render: {
      round: number;
      planIndex: number;
      planSeqInRound?: number;
      strategy?: string;
      narrativeLine?: string;
      introReason?: string;
      editForm?: string;
      genreProfile?: string;
      durationSec?: number;
      durationTier?: string;
      targetDurationLabel?: string;
      hookType?: string;
      cliffType?: string;
      outputUrl?: string;
      localOutputPath?: string;
    };
    segments: Array<Record<string, unknown>>;
    highlights: Array<Record<string, unknown>>;
    durationSec: number;
    repairs: string[];
  }> {
    const requested = await this.getTaskRecord(taskId);
    if (!requested) throw new Error("task not found");

    const dramaTitle =
      typeof requested.dramaMeta?.title === "string" && requested.dramaMeta.title.trim()
        ? requested.dramaMeta.title.trim()
        : requested.dramaPackage?.title?.trim() || undefined;

    const pathHint = (opts.path || "").trim();
    const fileHint = (opts.fileName || "").trim() || basenameOfPath(pathHint);

    // output_asr：成片真 ASR 任务，无 mixRenders；直接用任务 ASR / 路径回落
    if (requested.taskKind === "output_asr") {
      const trueAsr = await this.tryLoadOutputAsrForInspect({
        pathHint,
        fileHint,
        parentTaskId: requested.parentPackageTaskId,
      });
      let segments: Array<Record<string, unknown>> = trueAsr?.segments ?? [];
      let highlights: Array<Record<string, unknown>> = trueAsr?.highlights ?? [];
      let durationSec = trueAsr?.durationSec ?? 0;
      if (!segments.length) {
        const asr = await this.getAsrResult(requested.taskId);
        if (!asr?.segments?.length) {
          throw new Error("成片 ASR 任务缺少识别结果，请重新识别");
        }
        segments = asr.segments as unknown as Array<Record<string, unknown>>;
        highlights = asr.segments
          .filter((s) => Boolean(s.highlightType) || Boolean(s.usableAsHook))
          .map((s) => s as unknown as Record<string, unknown>);
        const lastEnd = Math.max(...asr.segments.map((s) => Number(s.endMs) || 0), 0);
        durationSec = lastEnd / 1000;
      }
      return {
        taskId: requested.taskId,
        sourceTaskId: requested.parentPackageTaskId || requested.taskId,
        taskKind: "output_asr",
        dramaId: requested.dramaId,
        dramaTitle,
        matchedBy: "output-asr-task",
        render: {
          round: 1,
          planIndex: 1,
          planSeqInRound: 1,
          durationSec,
          outputUrl: requested.outputUrl,
          localOutputPath: pathHint || undefined,
        },
        segments,
        highlights,
        durationSec,
        repairs: [],
      };
    }

    // single：任务自身 plan + ASR
    if ((requested.taskKind ?? "single") === "single") {
      const plan = requested.plan;
      if (!plan?.clips?.length) {
        throw new Error("单集任务缺少剪辑方案");
      }
      // 优先成片真 ASR（手工对成片跑过识别）
      const trueAsr = await this.tryLoadOutputAsrForInspect({
        pathHint,
        fileHint,
        parentTaskId: requested.taskId,
      });
      if (trueAsr) {
        return {
          taskId: requested.taskId,
          sourceTaskId: requested.taskId,
          taskKind: "single",
          dramaId: requested.dramaId,
          dramaTitle,
          matchedBy: "single-plan+output-asr",
          render: {
            round: 1,
            planIndex: 1,
            planSeqInRound: 1,
            strategy: plan.strategy,
            narrativeLine: plan.narrativeLine,
            introReason: plan.introReason,
            editForm: plan.editForm,
            genreProfile: plan.genreProfile,
            durationSec: trueAsr.durationSec,
            durationTier: plan.durationTier,
            targetDurationLabel: plan.targetDurationLabel,
            hookType: plan.hookType,
            cliffType: plan.cliffType,
            outputUrl: requested.outputUrl,
          },
          segments: trueAsr.segments,
          highlights: trueAsr.highlights,
          durationSec: trueAsr.durationSec,
          repairs: [],
        };
      }
      const asr = await this.getAsrResult(requested.taskId);
      if (!asr?.segments?.length) {
        throw new Error("单集任务缺少 ASR 结果");
      }
      const mapped = remapPlanAsrToOutputTimeline(plan, asr.segments, {
        disableHookOpeningTrim: false,
      });
      return {
        taskId: requested.taskId,
        sourceTaskId: requested.taskId,
        taskKind: "single",
        dramaId: requested.dramaId,
        dramaTitle,
        matchedBy: "single-plan",
        render: {
          round: 1,
          planIndex: 1,
          planSeqInRound: 1,
          strategy: plan.strategy,
          narrativeLine: plan.narrativeLine,
          introReason: plan.introReason,
          editForm: plan.editForm,
          genreProfile: plan.genreProfile,
          durationSec: mapped.durationSec,
          durationTier: plan.durationTier,
          targetDurationLabel: plan.targetDurationLabel,
          hookType: plan.hookType,
          cliffType: plan.cliffType,
          outputUrl: requested.outputUrl,
        },
        segments: mapped.segments as unknown as Array<Record<string, unknown>>,
        highlights: mapped.highlights as unknown as Array<Record<string, unknown>>,
        durationSec: mapped.durationSec,
        repairs: mapped.repairs,
      };
    }

    // drama_package / drama_mix：解析到有 planBatches 的混剪任务
    let mixTask = requested;
    let matchedBy = "task";
    if (requested.taskKind === "drama_package" || !requested.planBatches?.length) {
      const resolved = await this.resolveMixTaskWithPlans(requested);
      if (resolved) {
        mixTask = resolved;
        matchedBy = requested.taskKind === "drama_package" ? "package→mix" : "resolved-mix";
      }
    }

    // 剧包上可能已挂 mixRenders，但 planBatches 在 mix 子任务
    const mixRenders = (mixTask.mixRenders?.length ? mixTask.mixRenders : requested.mixRenders) ?? [];
    const planBatches = mixTask.planBatches?.length ? mixTask.planBatches : requested.planBatches;

    // 无 mixRenders（孤儿成片 / 仅本地文件）：若已有成片真 ASR，仍可预览
    if (!mixRenders.length) {
      const trueAsr = await this.tryLoadOutputAsrForInspect({
        pathHint,
        fileHint,
        parentTaskId: requested.taskId,
        alsoParentTaskId: mixTask.taskId,
      });
      if (trueAsr?.segments?.length) {
        return {
          taskId: requested.taskId,
          sourceTaskId: mixTask.taskId,
          taskKind: requested.taskKind ?? mixTask.taskKind ?? "drama_mix",
          dramaId: requested.dramaId ?? mixTask.dramaId,
          dramaTitle,
          matchedBy: `${matchedBy}+output-asr-no-mix-render`,
          render: {
            round: 1,
            planIndex: 1,
            planSeqInRound: 1,
            durationSec: trueAsr.durationSec,
            localOutputPath: pathHint || undefined,
          },
          segments: trueAsr.segments,
          highlights: trueAsr.highlights,
          durationSec: trueAsr.durationSec,
          repairs: [],
        };
      }
      throw new Error("任务没有成片记录（mixRenders 为空），且无成片 ASR；请先对成本地成片重新识别");
    }

    const matched = matchMixRender(mixRenders, pathHint, fileHint);
    if (!matched) {
      throw new Error("无法匹配成片到 mixRender，请确认 path/fileName 与渲染输出一致");
    }
    const { render, matchedBy: renderMatch } = matched;
    matchedBy = `${matchedBy}+${renderMatch}`;

    const plans = planBatches?.find((b) => b.round === render.round)?.plans ?? [];
    const seq = Math.max(1, render.planSeqInRound ?? render.planIndex ?? 1);
    const plan = plans[seq - 1];
    if (!plan?.clips?.length) {
      throw new Error(`未找到 R${render.round}-P${seq} 的剪辑方案`);
    }

    const renderMeta = {
      round: render.round,
      planIndex: render.planIndex,
      planSeqInRound: render.planSeqInRound ?? seq,
      strategy: render.strategy ?? plan.strategy,
      narrativeLine: render.narrativeLine ?? plan.narrativeLine,
      introReason: plan.introReason,
      editForm: render.editForm ?? plan.editForm,
      genreProfile: render.genreProfile ?? plan.genreProfile,
      durationSec: render.durationSec,
      durationTier: render.durationTier ?? plan.durationTier,
      targetDurationLabel: render.targetDurationLabel ?? plan.targetDurationLabel,
      hookType: render.hookType ?? plan.hookType,
      cliffType: render.cliffType ?? plan.cliffType,
      outputUrl: render.outputUrl,
      localOutputPath: render.localOutputPath,
    };

    // 优先成片真 ASR（手工对成片跑过识别）；没有再 remap 分集 ASR
    const trueAsr = await this.tryLoadOutputAsrForInspect({
      pathHint,
      fileHint,
      parentTaskId: requested.taskId,
      alsoParentTaskId: mixTask.taskId,
    });
    if (trueAsr) {
      return {
        taskId: requested.taskId,
        sourceTaskId: mixTask.taskId,
        taskKind: requested.taskKind ?? mixTask.taskKind ?? "drama_mix",
        dramaId: requested.dramaId ?? mixTask.dramaId,
        dramaTitle,
        matchedBy: `${matchedBy}+output-asr`,
        render: {
          ...renderMeta,
          durationSec: render.durationSec ?? trueAsr.durationSec,
        },
        segments: trueAsr.segments,
        highlights: trueAsr.highlights,
        durationSec: render.durationSec ?? trueAsr.durationSec,
        repairs: [],
      };
    }

    const segments = await this.getMergedSegmentsForMixTask(mixTask);
    const mapped = remapPlanAsrToOutputTimeline(plan, segments);

    return {
      taskId: requested.taskId,
      sourceTaskId: mixTask.taskId,
      taskKind: requested.taskKind ?? mixTask.taskKind ?? "drama_mix",
      dramaId: requested.dramaId ?? mixTask.dramaId,
      dramaTitle,
      matchedBy,
      render: {
        ...renderMeta,
        durationSec: render.durationSec ?? mapped.durationSec,
      },
      segments: mapped.segments as unknown as Array<Record<string, unknown>>,
      highlights: mapped.highlights as unknown as Array<Record<string, unknown>>,
      durationSec: render.durationSec ?? mapped.durationSec,
      repairs: mapped.repairs,
    };
  }

  private async tryLoadOutputAsrForInspect(opts: {
    pathHint: string;
    fileHint: string;
    parentTaskId?: string;
    alsoParentTaskId?: string;
  }): Promise<{
    segments: Array<Record<string, unknown>>;
    highlights: Array<Record<string, unknown>>;
    durationSec: number;
  } | null> {
    const { toClipLocalSourceUrl } = await import("@clip/sdk");
    const candidates: Array<{ sourceUrl?: string; parentTaskId?: string; fileName?: string }> = [];
    if (opts.pathHint && !/^https?:\/\//i.test(opts.pathHint) && !/^local:/i.test(opts.pathHint)) {
      candidates.push({ sourceUrl: toClipLocalSourceUrl(opts.pathHint) });
    }
    if (opts.parentTaskId && opts.fileHint) {
      candidates.push({ parentTaskId: opts.parentTaskId, fileName: opts.fileHint });
    }
    if (opts.alsoParentTaskId && opts.alsoParentTaskId !== opts.parentTaskId && opts.fileHint) {
      candidates.push({ parentTaskId: opts.alsoParentTaskId, fileName: opts.fileHint });
    }
    for (const c of candidates) {
      const record = await this.resolveOutputAsrResult(c);
      if (!record?.segments?.length) continue;
      const segments = record.segments as unknown as Array<Record<string, unknown>>;
      const highlights = record.segments
        .filter((s) => Boolean(s.highlightType) || Boolean(s.usableAsHook))
        .map((s) => s as unknown as Record<string, unknown>);
      const lastEnd = Math.max(...record.segments.map((s) => Number(s.endMs) || 0), 0);
      return {
        segments,
        highlights,
        durationSec: lastEnd / 1000,
      };
    }
    return null;
  }

  private async getMergedSegmentsForMixTask(task: TaskRecord): Promise<AsrSegment[]> {
    if (!task.dramaId || !task.mixEpisodeIds?.length) {
      throw new Error("混剪任务缺少 dramaId 或 mixEpisodeIds");
    }
    let episodes = this.listDramaEpisodes(task.dramaId).filter((ep) =>
      task.mixEpisodeIds!.includes(ep.episodeId),
    );
    if (episodes.length < task.mixEpisodeIds!.length) {
      const refs = await this.resolveMixEpisodeRefsForMarkers(task);
      const byId = new Map(episodes.map((ep) => [ep.episodeId, ep]));
      for (const r of refs) {
        if (!r.taskId) continue;
        const prev = byId.get(r.episodeId);
        byId.set(r.episodeId, {
          episodeId: r.episodeId,
          dramaId: task.dramaId!,
          episodeNo: r.episodeNo ?? prev?.episodeNo ?? 0,
          title: prev?.title ?? `第${r.episodeNo ?? "?"}集`,
          sourceUrl: r.sourceUrl ?? prev?.sourceUrl ?? "",
          status: prev?.status ?? "asr_done",
          taskId: r.taskId,
          createdAt: prev?.createdAt ?? nowWallClock(),
          updatedAt: nowWallClock(),
        });
      }
      episodes = [...byId.values()].filter((ep) => task.mixEpisodeIds!.includes(ep.episodeId));
    }
    const withSegments: DramaEpisodeRecord[] = [];
    const allMarkers = await this.listEditMarkersForMixTask(task);
    for (const ep of episodes) {
      if (!ep.taskId || !this.asrRepo) continue;
      const asr = await this.asrRepo.findByTaskId(ep.taskId);
      if (asr?.segments?.length) {
        const continuous = ensureAsrTimelineContinuous(
          asr.segments,
          ep.episodeId,
          asr.rawSegments,
        );
        let labeled = annotateAsrSegmentsWithLabels(continuous.segments, {
          rawSegments: asr.rawSegments,
          ...this.resolveDramaGenreAnnotateOptions(
            task.dramaId,
            sampleAsrTextsForGenreInfer(continuous.segments),
          ),
        });
        // 合并人工高光标记：taskId 或规范化 source_path 匹配
        const epMarkers = allMarkers.filter((m) => this.editMarkerMatchesEpisode(m, ep));
        if (epMarkers.length) {
          labeled = this.mergeEditMarkersIntoSegments(labeled, epMarkers, ep.episodeId);
        }
        withSegments.push({ ...ep, segments: labeled });
      }
    }
    const merged = mergeDramaSegments(withSegments);
    if (!merged.length) {
      throw new Error("混剪任务没有可用的跨集 ASR 片段");
    }
    return merged;
  }

  /**
   * 将人工编辑标记合并到 ASR 片段：
   * - source="human"：提升权重，highlightScore=999，优先被选中。
   * - source="suppress"：清除重叠 ASR 片段的高光/钩子属性，避免被选到。
   */
  private mergeEditMarkersIntoSegments(
    segments: AsrSegment[],
    markers: EditMarker[],
    episodeId?: string,
  ): AsrSegment[] {
    const markerInputs = markers.map((m) => ({
      startMs: m.startMs,
      endMs: m.endMs,
      label: m.label,
      highlightType: m.highlightType,
      usableAsHook: m.usableAsHook,
      source: m.source === "suppress" ? "suppress" as const : "human" as const,
      markerId: m.markerId,
    }));
    return mergeHumanHighlightMarkersIntoSegments(segments, markerInputs, episodeId);
  }

  private inferHighlightTypeFromLabel(label: string): string {
    const t = (label || "").trim().toLowerCase();
    if (/hook|片头|钩子/.test(t)) return "hook";
    if (/twist|反转/.test(t)) return "twist";
    if (/cliff|悬念/.test(t)) return "cliff";
    if (/conflict|冲突/.test(t)) return "conflict";
    return "conflict";
  }

  private buildMixEpisodes(task: TaskRecord) {
    if (!task.dramaId || !task.mixEpisodeIds?.length) return undefined;
    return this.listDramaEpisodes(task.dramaId)
      .filter((ep) => task.mixEpisodeIds!.includes(ep.episodeId))
      .map((ep) => ({
        episodeId: ep.episodeId,
        episodeNo: ep.episodeNo,
        sourceUrl: ep.sourceUrl,
      }));
  }

  async listTasksPage(params: {
    status?: ClipTask["status"];
    taskKind?: ClipTaskKind;
    dramaId?: string;
    claimedBy?: string;
    limit: number;
    offset: number;
  }): Promise<{ tasks: ClipTask[]; total: number; limit: number; offset: number }> {
    const { rows, total } = await this.requireTaskRepo().listPage(params);
    return {
      tasks: rows.map((t) => this.toTask(t)),
      total,
      limit: params.limit,
      offset: params.offset,
    };
  }

  /**
   * 按剧聚合的任务看板：一次返回每剧的管线阶段（剧包→识别→混剪）、
   * 各阶段进度（完成/总数）、执行服务器集合与汇总状态。
   * 服务端固定 3+2 条 SQL（repo 3 条 + 剧名 1 条 + 设备名 1 条），无 N+1。
   */
  async taskBoard(params: {
    aggStatus?: "running" | "completed" | "failed";
    claimedBy?: string;
    limit: number;
    offset: number;
  }): Promise<{
    groups: TaskBoardGroupDto[];
    total: number;
    limit: number;
    offset: number;
    deviceNames: Record<string, string>;
  }> {
    const repo = this.requireTaskRepo();
    const { groups, total } = await repo.listTaskBoard({
      aggStatus: params.aggStatus,
      claimedBy: params.claimedBy,
      limit: params.limit,
      offset: params.offset,
    });
    if (!groups.length) {
      return { groups: [], total, limit: params.limit, offset: params.offset, deviceNames: {} };
    }
    // 批量取当前页各剧的轻量任务行（含 claimed_by / episode / phase 等），内存组装阶段进度
    const dramaIds = groups.map((g) => g.dramaId);
    const boardTasks = await repo.listTaskBoardTasks(dramaIds);
    // 剧名：一次 IN 查询
    const titles = await this.getBoardDramaTitles(dramaIds);
    // 设备名映射：一次 deviceRepo.list()
    const deviceIds = [...new Set(boardTasks.map((t) => t.claimedBy).filter((v): v is string => Boolean(v)))];
    const deviceNames = await this.getDeviceNameMap(deviceIds);

    const byDrama = new Map<string, typeof boardTasks>();
    for (const t of boardTasks) {
      const list = byDrama.get(t.dramaId);
      if (list) list.push(t);
      else byDrama.set(t.dramaId, [t]);
    }

    const dtos: TaskBoardGroupDto[] = groups.map((g) => {
      const tasks = byDrama.get(g.dramaId) ?? [];
      // 三段管线：剧包下载 / 分集识别 / 混剪成片
      const pkgTasks = tasks.filter((t) => t.taskKind === "drama_package");
      const asrTasks = tasks.filter((t) => t.taskKind === "episode_asr");
      const mixTasks = tasks.filter((t) => t.taskKind === "drama_mix");
      // 汇总状态：任一失败即 failed；全完成即 completed；否则 running
      const hasFailed = tasks.some((t) => t.status === "failed");
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === "completed");
      const aggStatus: "running" | "completed" | "failed" = hasFailed ? "failed" : allDone ? "completed" : "running";
      // 阶段进度：完成数/总数
      const stageDone = (list: typeof tasks) => list.filter((t) => t.status === "completed").length;
      const servers = [...new Set(tasks.map((t) => t.claimedBy).filter((v): v is string => Boolean(v)))];
      return {
        dramaId: g.dramaId,
        title: titles.get(g.dramaId) ?? g.dramaId,
        taskCount: g.taskCount,
        lastActiveAt: g.lastActiveAt,
        aggStatus,
        servers,
        failMessage: g.failMessage,
        stages: [
          {
            key: "package",
            label: "剧包下载",
            total: pkgTasks.length,
            done: stageDone(pkgTasks),
            status: this.stageStatusOf(pkgTasks),
            phase: pkgTasks[0]?.phase,
            taskId: pkgTasks[0]?.taskId,
            claimedBy: pkgTasks[0]?.claimedBy,
            claimedAt: pkgTasks[0]?.claimedAt,
          },
          {
            key: "asr",
            label: "分集识别",
            total: asrTasks.length,
            done: stageDone(asrTasks),
            status: this.stageStatusOf(asrTasks),
            phase: asrTasks[0]?.phase,
            taskId: asrTasks[0]?.taskId,
            claimedBy: asrTasks[0]?.claimedBy,
            claimedAt: asrTasks[0]?.claimedAt,
          },
          {
            key: "mix",
            label: "混剪成片",
            total: mixTasks.length,
            done: stageDone(mixTasks),
            status: this.stageStatusOf(mixTasks),
            phase: mixTasks[0]?.phase,
            taskId: mixTasks[0]?.taskId,
            claimedBy: mixTasks[0]?.claimedBy,
            claimedAt: mixTasks[0]?.claimedAt,
            outputUrl: mixTasks[0]?.outputUrl,
          },
        ],
        episodes: tasks
          .filter((t) => t.taskKind === "episode_asr")
          .map((t) => ({
            episodeNo: t.episodeNo,
            status: t.status,
            taskId: t.taskId,
            server: t.claimedBy ? (deviceNames[t.claimedBy] ?? t.claimedBy) : undefined,
            elapsed: this.elapsedSecOf(t),
          }))
          .sort((a, b) => (a.episodeNo ?? 0) - (b.episodeNo ?? 0)),
      };
    });
    return { groups: dtos, total, limit: params.limit, offset: params.offset, deviceNames };
  }

  /** 看板用：阶段状态归纳（pending/running/completed/failed） */
  private stageStatusOf(tasks: BoardTaskLite[]): "pending" | "running" | "completed" | "failed" {
    if (!tasks.length) return "pending";
    if (tasks.some((t) => t.status === "failed")) return "failed";
    if (tasks.every((t) => t.status === "completed")) return "completed";
    return "running";
  }

  /** 看板用：执行耗时（秒），运行中按 now - startedAt 动态算 */
  private elapsedSecOf(task: BoardTaskLite): number | undefined {
    // 时间字段是东八区墙钟串，用 toMysqlDate 转回 Date 再算差
    const started = toMysqlDate(task.processingStartedAt ?? null)?.getTime() ?? NaN;
    if (task.processingCompletedAt && !Number.isNaN(started)) {
      const ended = toMysqlDate(task.processingCompletedAt)?.getTime() ?? NaN;
      if (!Number.isNaN(ended)) return Math.round((ended - started) / 1000);
    }
    if (!Number.isNaN(started)) {
      return Math.round((Date.now() - started) / 1000);
    }
    const claimed = toMysqlDate(task.claimedAt ?? null)?.getTime() ?? NaN;
    if (!Number.isNaN(claimed)) {
      return Math.round((Date.now() - claimed) / 1000);
    }
    return undefined;
  }

  /** 看板用：批量取剧标题（IN 查询，仅当前页各剧） */
  private async getBoardDramaTitles(dramaIds: string[]): Promise<Map<string, string>> {
    if (!this.dramaRepo) return new Map();
    return this.dramaRepo.listTitlesByIds(dramaIds);
  }

  /** deviceId -> machineId 批量映射（任务列表展示执行服务器用） */
  async getDeviceNameMap(deviceIds: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(deviceIds)];
    if (!unique.length) return {};
    if (!this.deviceRepo) {
      return Object.fromEntries(unique.map((id) => [id, id]));
    }
    const all = await this.deviceRepo.list();
    const byId = new Map(all.map((d) => [d.deviceId, d.machineId || d.deviceId]));
    return Object.fromEntries(unique.map((id) => [id, byId.get(id) ?? id]));
  }

  /**
   * 桌面端成片库：同一 API 下全部 https 成片（跨设备共享，直接读 clip_task_output）。
   * deviceId 仅用于鉴权，不按认领设备过滤。
   */
  async listAgentMediaOutputs(_deviceId: string): Promise<Array<{ taskId: string; name: string; url: string; urls: string[]; updatedAt?: string; dramaTitle?: string }>> {
    const rows = await this.requireTaskRepo().listSharedHttpOutputs(500);
    const byTask = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTask.get(row.taskId) ?? [];
      list.push(row.url);
      byTask.set(row.taskId, list);
    }
    return rows.map((row) => {
      let fileName = row.url.split(/[?#]/)[0]?.split("/").pop() || "";
      try {
        fileName = decodeURIComponent(fileName);
      } catch {
        /* keep raw */
      }
      const urls = byTask.get(row.taskId) ?? [row.url];
      return {
        taskId: row.taskId,
        name: fileName || `${row.dramaTitle ?? row.taskId}.mp4`,
        url: row.url,
        urls,
        updatedAt: row.updatedAt,
        dramaTitle: row.dramaTitle,
      };
    });
  }

  /** @deprecated 请使用 listTasksPage */
  async listTasks(status?: ClipTask["status"]): Promise<ClipTaskDetail[]> {
    const tasks = await this.requireTaskRepo().list(status ? { status } : undefined);
    return tasks.map((t) => this.toTaskDetail(t));
  }

  async getTask(taskId: string): Promise<ClipTaskDetail | null> {
    const task = await this.getTaskRecord(taskId);
    if (!task) return null;
    const detail = this.toTaskDetail(task);
    if (task.taskKind === "drama_mix") {
      try {
        detail.segments = await this.getMergedSegmentsForMixTask(task);
      } catch {
        /* 混剪 ASR 尚未就绪 */
      }
    } else {
      const asr = await this.getAsrResult(taskId);
      if (asr) {
        detail.segments = asr.segments;
        detail.rawSegments = asr.rawSegments;
        detail.rawSegmentCount = asr.rawSegmentCount;
        detail.finalSegmentCount = asr.finalSegmentCount;
        detail.subtitleUrl = detail.subtitleUrl ?? asr.subtitleUrl;
        detail.subtitlesJsonUrl = detail.subtitlesJsonUrl ?? asr.subtitlesJsonUrl;
      }
    }
    return detail;
  }

  listDevicesPage(params: {
    limit: number;
    offset: number;
    q?: string;
    onlineOnly?: boolean;
  }): {
    devices: DeviceInfo[];
    total: number;
    limit: number;
    offset: number;
    stats: { total: number; online: number; agentOff: number; mixCount: number; replicaCount: number };
  } {
    const all = this.listDevices();
    const stats = {
      total: all.length,
      online: all.filter((d) => d.online).length,
      agentOff: all.filter((d) => !d.services?.agentEnabled).length,
      mixCount: all.filter((d) => d.services?.agentEnabled !== false && d.services?.taskQueue === "mix").length,
      replicaCount: all.filter((d) => d.services?.agentEnabled !== false && d.services?.taskQueue === "replica").length,
    };
    let devices = all;
    if (params.onlineOnly) {
      devices = devices.filter((d) => d.online);
    }
    const q = params.q?.trim().toLowerCase();
    if (q) {
      devices = devices.filter((d) => {
        const hay = [d.machineId, d.deviceId, d.gpuName, d.os, d.agentVersion]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    devices.sort(
      (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
    );
    const total = devices.length;
    const page = devices.slice(params.offset, params.offset + params.limit);
    return { devices: page, total, limit: params.limit, offset: params.offset, stats };
  }

  listDevices(): DeviceInfo[] {
    const now = Date.now();
    return this.state.devices.map((d) => ({
      deviceId: d.deviceId,
      machineId: d.machineId,
      gpuName: d.gpuName,
      vramMb: d.vramMb,
      os: d.os,
      agentVersion: d.agentVersion,
      lastSeenAt: d.lastSeenAt,
      online: now - new Date(d.lastSeenAt).getTime() < ONLINE_THRESHOLD_MS,
      boundUser: d.boundUser,
      services: resolveAgentServices(
        this.state.profile.services,
        this.state.deviceOverrides[d.deviceId]?.services,
      ),
      resourcePolicyOverride: Boolean(
        this.state.deviceOverrides[d.deviceId]?.services?.resourcePolicy,
      ),
    }));
  }

  async listDailyStatsPage(
    date: string,
    limit: number,
    offset: number,
  ): Promise<{
    devices: Record<string, unknown>[];
    total: number;
    limit: number;
    offset: number;
    summary: { taskCount: number; taskSuccess: number; taskFail: number; deviceCount: number };
  }> {
    if (this.telemetryRepo) {
      const all = await this.telemetryRepo.listDailyStats(date);
      const summary = {
        taskCount: all.reduce((a, d) => a + Number(d.task_count || 0), 0),
        taskSuccess: all.reduce((a, d) => a + Number(d.task_success || 0), 0),
        taskFail: all.reduce((a, d) => a + Number(d.task_fail || 0), 0),
        deviceCount: all.length,
      };
      const { rows, total } = await this.telemetryRepo.listDailyStatsPage(date, limit, offset);
      const devices = rows.map((row) => {
        const device = this.state.devices.find((d) => d.deviceId === row.device_id);
        return {
          device_id: row.device_id,
          machine_id: device?.machineId,
          gpu_name: device?.gpuName,
          stat_date: date,
          task_count: row.task_count,
          task_success: row.task_success,
          task_fail: row.task_fail,
          asr_audio_sec_total: Number(row.asr_audio_sec_total),
          asr_wall_sec_total: Number(row.asr_wall_sec_total),
          asr_job_count: row.asr_job_count,
          render_output_sec_total: Number(row.render_output_sec_total),
          render_wall_sec_total: Number(row.render_wall_sec_total),
          render_bytes_total: Number(row.render_bytes_total),
        };
      });
      return { devices, total, limit, offset, summary };
    }
    const all = await this.listDailyStats(date);
    const summary = {
      taskCount: all.reduce((a, d) => a + Number(d.task_count || 0), 0),
      taskSuccess: all.reduce((a, d) => a + Number(d.task_success || 0), 0),
      taskFail: all.reduce((a, d) => a + Number(d.task_fail || 0), 0),
      deviceCount: all.length,
    };
    const total = all.length;
    const devices = all.slice(offset, offset + limit);
    return { devices, total, limit, offset, summary };
  }

  async listDailyStats(date: string) {
    const rows = await this.telemetryRepo!.listDailyStats(date);
    return rows.map((row) => {
      const device = this.state.devices.find((d) => d.deviceId === row.device_id);
      return {
        device_id: row.device_id,
        machine_id: device?.machineId,
        gpu_name: device?.gpuName,
        stat_date: date,
        task_count: row.task_count,
        task_success: row.task_success,
        task_fail: row.task_fail,
        asr_audio_sec_total: Number(row.asr_audio_sec_total),
        asr_wall_sec_total: Number(row.asr_wall_sec_total),
        asr_job_count: row.asr_job_count,
        render_output_sec_total: Number(row.render_output_sec_total),
        render_wall_sec_total: Number(row.render_wall_sec_total),
        render_bytes_total: Number(row.render_bytes_total),
      };
    });
  }

  async getDeviceTimelinePage(
    deviceId: string,
    date: string,
    limit: number,
    offset: number,
  ) {
    const { rows, total } = await this.requireTaskRepo().listPage({
      claimedBy: deviceId,
      updatedDatePrefix: date,
      limit,
      offset,
    });
    const tasks = rows.map((t) => ({
      taskId: t.taskId,
      status: t.status,
      templateId: t.templateId,
      failMessage: t.failMessage,
      outputUrl: t.outputUrl,
      updatedAt: t.updatedAt,
    }));

    const telemetry = await this.telemetryRepo!.listBatchesByDeviceDate(deviceId, date);

    return { deviceId, date, tasks, total, limit, offset, telemetry };
  }

  /** Agent 历史表现：聚合任务数/成功率/耗时/活跃（days 缺省为全部历史） */
  async agentSummary(days?: number): Promise<
    Array<{
      deviceId: string;
      machineName: string;
      online: boolean;
      taskTotal: number;
      taskSuccess: number;
      taskFail: number;
      running: number;
      successRate: number | null;
      avgWallSec: number | null;
      p50WallSec: number | null;
      p95WallSec: number | null;
      firstSeenAt: string | null;
      lastActiveAt: string | null;
    }>
  > {
    const since = days && days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;
    const rows = await this.requireTaskRepo().aggregateAgentSummary(since);
    const devices = this.listDevices();
    const byId = new Map(devices.map((d) => [d.deviceId, d]));
    return rows.map((row) => {
      const device = byId.get(row.deviceId);
      const finished = row.taskSuccess + row.taskFail;
      return {
        ...row,
        machineName: device?.machineId || row.deviceId,
        online: device?.online ?? false,
        successRate: finished > 0 ? Math.round((row.taskSuccess / finished) * 100) : null,
      };
    });
  }

  /** 近 N 天任务趋势（每日总量/成功/失败） */
  async taskTrend(days = 14): Promise<Array<{ day: string; total: number; success: number; fail: number }>> {
    const n = Math.min(90, Math.max(1, days));
    const since = new Date(Date.now() - n * 86_400_000);
    return this.requireTaskRepo().aggregateTaskTrend(since);
  }

  listRuleSetsPage(limit: number, offset: number) {
    const all = this.listRuleSetSummaries();
    return {
      ruleSets: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    };
  }

  /** 列表/下拉框用：不含 rules 全文 */
  listRuleSetSummaries() {
    return Object.entries(this.state.ruleSets).map(([ruleSetId, rules]) => ({
      rule_set_id: ruleSetId,
      version: rules.ruleSetVersion,
    }));
  }

  listRuleSets() {
    return Object.entries(this.state.ruleSets).map(([ruleSetId, rules]) => ({
      rule_set_id: ruleSetId,
      version: rules.ruleSetVersion,
      rules,
    }));
  }

  getRuleSet(ruleSetId: string): AsrRules | null {
    return this.state.ruleSets[ruleSetId] ?? null;
  }

  createRuleSet(ruleSetId: string, rules: AsrRules): void {
    if (this.state.ruleSets[ruleSetId]) throw new Error("rule set already exists");
    const next = { ...rules, ruleSetId, ruleSetVersion: "1.0.0" };
    void this.persistRuleSet(ruleSetId, next);
  }

  updateRuleSet(ruleSetId: string, rules: AsrRules): void {
    const existing = this.state.ruleSets[ruleSetId];
    const prevVersion = existing?.ruleSetVersion ?? "1.0.0";
    const [major, minor, patch] = prevVersion.split(".").map(Number);
    const nextVersion = `${major}.${minor}.${(patch ?? 0) + 1}`;
    const next = {
      ...rules,
      ruleSetId,
      ruleSetVersion: rules.ruleSetVersion && rules.ruleSetVersion !== prevVersion
        ? rules.ruleSetVersion
        : nextVersion,
    };
    void this.persistRuleSet(ruleSetId, next);
  }

  async listDramasPage(limit: number, offset: number) {
    if (this.dramaRepo) {
      return this.dramaRepo.listDramasPage(limit, offset);
    }
    const all = this.listDramas();
    return {
      dramas: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    };
  }

  async listDramaIntakePage(
    limit: number,
    offset: number,
    opts?: { status?: DramaIntakeStatus; dramaType?: DramaIntakeType; externalDramaId?: string; q?: string },
  ) {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    return this.dramaIntakeRepo.listPage(limit, offset, opts);
  }

  async batchCreateDramaIntake(
    items: Array<{ title: string; externalDramaId: string; dramaType: DramaIntakeType }>,
  ) {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    return this.dramaIntakeRepo.batchCreate(items);
  }

  /** 批量查询 drama_package 任务的 source_url，用于重复剧自动复用 zip 地址 */
  async findDramaPackageSourceUrlsByIds(taskIds: string[]): Promise<Map<string, string>> {
    return this.requireTaskRepo().findDramaPackageSourceUrlsByIds(taskIds);
  }

  async updateDramaIntakeSynopsisByExternalId(externalDramaId: string, synopsis: string) {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    const updated = await this.dramaIntakeRepo.updateSynopsisByExternalId(externalDramaId, synopsis);
    if (!updated) throw new Error("drama intake not found");
    return updated;
  }

  async findDramaIntakeByExternalId(externalDramaId: string): Promise<DramaIntakeRecord | null> {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    return this.dramaIntakeRepo.findByExternalId(externalDramaId);
  }

  async findDramaIntakeByLinkedDramaId(linkedDramaId: string): Promise<DramaIntakeRecord | null> {
    if (!this.dramaIntakeRepo) return null;
    return this.dramaIntakeRepo.findByLinkedDramaId(linkedDramaId);
  }

  async findDramaIntakesByLinkedDramaIds(
    linkedDramaIds: string[],
  ): Promise<DramaIntakeRecord[]> {
    if (!this.dramaIntakeRepo) return [];
    return this.dramaIntakeRepo.findByLinkedDramaIds(linkedDramaIds);
  }

  /**
   * 桌面端批量展示用 meta + episodes：一次返回多部剧，减少前端并发请求。
   * 这里只做查询和轻量回写，不做重 reconcile；episodes 由调用方按需单独查或后续扩展。
   */
  async resolveAgentDramasBatch(
    dramaIds: string[],
  ): Promise<
    Array<{
      dramaId: string;
      title: string;
      synopsis: string;
      genre: string;
      genreTags: string[];
      dramaType: string;
      dramaTypeLabel: string;
      meta: import("@clip/sdk").DramaMeta;
    }>
  > {
    const uniqueIds = [...new Set(dramaIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    // 按 dramaId 一次查 intake，避免循环查库
    const intakes = await this.findDramaIntakesByLinkedDramaIds(uniqueIds);
    const intakeMap = new Map(intakes.map((i) => [i.linkedDramaId, i]));

    const results = [];
    for (const dramaId of uniqueIds) {
      const drama = this.state.dramas[dramaId];
      if (!drama) continue;
      const meta = { ...(drama.meta || {}) };
      const intake = intakeMap.get(dramaId);

      const synopsis =
        (typeof meta.synopsis === "string" && meta.synopsis.trim()) ||
        intake?.synopsis?.trim() ||
        "";
      const dramaType = meta.dramaType || intake?.dramaType || undefined;
      const genreTags = Array.isArray(meta.genreTags) ? meta.genreTags : [];
      const genre =
        (genreTags.find((t) => String(t || "").trim()) as string | undefined)?.trim() || "";

      const needBackfill =
        Boolean(intake) &&
        ((synopsis && !String(meta.synopsis || "").trim()) || (dramaType && !meta.dramaType));
      if (needBackfill) {
        try {
          await this.updateDramaMeta(dramaId, {
            synopsis: synopsis || undefined,
            dramaType,
          });
          Object.assign(meta, this.state.dramas[dramaId]?.meta || {});
        } catch (err) {
          console.warn(
            `[clip-api] backfill drama meta from intake failed drama=${dramaId}`,
            err,
          );
        }
      }

      const typeKey = dramaType as keyof typeof DRAMA_INTAKE_TYPE_LABELS | undefined;
      results.push({
        dramaId,
        title: drama.title,
        synopsis,
        genre,
        genreTags,
        dramaType: dramaType || "",
        dramaTypeLabel: typeKey ? DRAMA_INTAKE_TYPE_LABELS[typeKey] : "",
        meta: this.state.dramas[dramaId]?.meta || meta,
      });
    }
    return results;
  }

  /**
   * 桌面端展示用 meta：优先 clip_drama.meta_json，缺简介/类型时回落 clip_drama_intake。
   * 若 intake 有而 drama.meta 无，顺带回写 meta，避免以后再查错表。
   */
  async resolveAgentDramaMeta(dramaId: string): Promise<{
    dramaId: string;
    title: string;
    synopsis: string;
    genre: string;
    genreTags: string[];
    dramaType: string;
    dramaTypeLabel: string;
    meta: import("@clip/sdk").DramaMeta;
  } | null> {
    const batch = await this.resolveAgentDramasBatch([dramaId]);
    return batch[0] || null;
  }

  async updateDramaIntakeByExternalId(
    externalDramaId: string,
    patch: {
      status?: DramaIntakeStatus;
      dramaType?: DramaIntakeType;
      synopsis?: string | null;
      note?: string | null;
      linkedTaskId?: string | null;
      linkedDramaId?: string | null;
    },
  ): Promise<DramaIntakeRecord> {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    const updated = await this.dramaIntakeRepo.updateByExternalId(externalDramaId, patch);
    if (!updated) throw new Error("drama intake not found");
    return updated;
  }

  async updateDramaIntake(
    intakeId: string,
    patch: {
      status?: DramaIntakeStatus;
      dramaType?: DramaIntakeType;
      synopsis?: string | null;
      note?: string | null;
      linkedTaskId?: string | null;
      linkedDramaId?: string | null;
    },
  ): Promise<DramaIntakeRecord> {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    const updated = await this.dramaIntakeRepo.update(intakeId, patch);
    if (!updated) throw new Error("drama intake not found");
    return updated;
  }

  async deleteDramaIntake(intakeId: string): Promise<void> {
    if (!this.dramaIntakeRepo) {
      throw new Error("MySQL is required for drama intake");
    }
    const ok = await this.dramaIntakeRepo.delete(intakeId);
    if (!ok) throw new Error("drama intake not found");
  }

  listDramas(): DramaInfo[] {
    return Object.values(this.state.dramas);
  }

  bindDramaRuleSet(dramaId: string, asrRuleSetId: string): DramaInfo {
    const drama = this.state.dramas[dramaId];
    if (!drama) throw new Error("drama not found");
    drama.asrRuleSetId = asrRuleSetId;
    void this.persistDrama(drama);
    return drama;
  }

  getGlobalConfig() {
    return {
      profile: this.state.profile.profile,
      configVersion: this.state.profile.configVersion,
      render: this.renderWithBgm(this.state.profile.render),
      asrRuntime: this.state.profile.asr.runtime,
      asrModels: this.state.profile.asr.models,
      defaultRuleSetId: defaultRules.ruleSetId,
      ruleSets: this.listRuleSetSummaries(),
      dramaCount: Object.keys(this.state.dramas).length,
      services: resolveAgentServices(this.state.profile.services),
    };
  }

  async updateGlobalProfile(patch: {
    render?: RenderConfig;
    configVersion?: string;
    asrRuntime?: Partial<EffectiveConfig["asr"]["runtime"]>;
    services?: AgentServicesConfig;
  }): Promise<void> {
    if (patch.render) {
      const nextRender = { ...this.state.profile.render, ...patch.render };
      // BGM 写入独立表，不进 profile
      if (patch.render.bgm !== undefined && this.bgmRepo) {
        this.bgmConfig = await this.bgmRepo.saveBgmConfig(patch.render.bgm);
      } else if (patch.render.bgm !== undefined) {
        this.bgmConfig = patch.render.bgm;
      }
      this.state.profile.render = stripBgmFromRender(nextRender) as RenderConfig;
    }
    if (patch.asrRuntime) this.state.profile.asr.runtime = { ...this.state.profile.asr.runtime, ...patch.asrRuntime };
    if (patch.services) {
      const prev = this.state.profile.services ?? {};
      const nextServices: AgentServicesConfig = { ...prev, ...patch.services };
      if (patch.services.resourcePolicy !== undefined) {
        if (patch.services.resourcePolicy === null) {
          delete nextServices.resourcePolicy;
        } else {
          nextServices.resourcePolicy = resolveResourcePolicy({
            ...resolveResourcePolicy(prev.resourcePolicy),
            ...patch.services.resourcePolicy,
            profiles: {
              full: {
                ...resolveResourcePolicy(prev.resourcePolicy).profiles.full,
                ...patch.services.resourcePolicy.profiles?.full,
              },
              throttled: {
                ...resolveResourcePolicy(prev.resourcePolicy).profiles.throttled,
                ...patch.services.resourcePolicy.profiles?.throttled,
              },
            },
          });
        }
      }
      this.state.profile.services = nextServices;
    }
    if (patch.configVersion) this.state.profile.configVersion = patch.configVersion;
    else this.state.profile.configVersion = `cfg-${nowWallClock().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-3)}`;
    await this.persistProfile();
  }

  setDeviceOverride(
    deviceId: string,
    override: { render?: RenderConfig; asrRuleSetId?: string; services?: AgentServicesConfig },
  ): void {
    if (!this.state.devices.some((d) => d.deviceId === deviceId)) throw new Error("device not found");
    const prev = this.state.deviceOverrides[deviceId] ?? {};
    const next = { ...prev, ...override };
    if (override.services !== undefined) {
      const merged: AgentServicesConfig = { ...prev.services, ...override.services };
      if (override.services.resourcePolicy === null) {
        delete merged.resourcePolicy;
      } else if (override.services.resourcePolicy) {
        merged.resourcePolicy = resolveResourcePolicy({
          ...resolveResourcePolicy(prev.services?.resourcePolicy),
          ...override.services.resourcePolicy,
          profiles: {
            full: {
              ...resolveResourcePolicy(prev.services?.resourcePolicy).profiles.full,
              ...override.services.resourcePolicy.profiles?.full,
            },
            throttled: {
              ...resolveResourcePolicy(prev.services?.resourcePolicy).profiles.throttled,
              ...override.services.resourcePolicy.profiles?.throttled,
            },
          },
        });
      }
      if (Object.keys(merged).length === 0) delete next.services;
      else next.services = merged;
    }
    void this.persistDeviceOverride(deviceId, next);
  }

  getDeviceOverride(deviceId: string) {
    return this.state.deviceOverrides[deviceId] ?? null;
  }

  checkUpdates(version: string, platform: string) {
    const manifest = this.state.updateManifest;
    if (manifest.platform !== platform) return { updateAvailable: false };
    const resolved = this.resolveAgentUpdateForDevice(version);
    return {
      updateAvailable: resolved.updateAvailable,
      latestVersion: manifest.version,
      downloadUrl: resolved.agentUpdate.downloadUrl,
      sha256: resolved.agentUpdate.sha256,
      mandatory: manifest.mandatory,
      releaseNotes: manifest.releaseNotes,
    };
  }

  /** @deprecated use ModelCdn via /agent/models/manifest */
  getModelManifest() {
    return { version: "deprecated", models: [] };
  }

  async ingestTelemetry(batch: TelemetryBatch): Promise<void> {
    for (const event of batch.events) {
      if (!event.at) event.at = nowWallClock();
    }

    const statDate = nowWallClock().slice(0, 10);
    const delta = {
      task_count: 0,
      task_success: 0,
      task_fail: 0,
      asr_audio_sec_total: 0,
      asr_wall_sec_total: 0,
      asr_job_count: 0,
      render_output_sec_total: 0,
      render_wall_sec_total: 0,
      render_bytes_total: 0,
    };

    for (const event of batch.events) {
      const m = event.metrics;
      if (event.type === "asr.completed") {
        delta.asr_job_count += 1;
        delta.asr_audio_sec_total += Number(m.audioDurationSec ?? 0);
        delta.asr_wall_sec_total += Number(m.wallTimeSec ?? 0);
      }
      if (event.type === "render.completed") {
        delta.render_output_sec_total += Number(m.outputDurationSec ?? 0);
        delta.render_wall_sec_total += Number(m.wallTimeSec ?? 0);
        delta.render_bytes_total += Number(m.outputBytes ?? 0);
      }
      if (event.type === "task.completed") {
        delta.task_count += 1;
        delta.task_success += 1;
      }
      if (event.type === "task.failed") {
        delta.task_count += 1;
        delta.task_fail += 1;
      }
    }

    await this.telemetryRepo!.insertBatch(batch);
    await this.telemetryRepo!.upsertDailyStats(statDate, batch.deviceId, delta);
  }

  async resetDemoTask(sourceUrl?: string): Promise<void> {
    if (!this.demoSourceAvailable && !sourceUrl) {
      throw new Error("demo source not available; provide sourceUrl or install fixtures/test-source.mp4");
    }
    const repo = this.requireTaskRepo();
    const now = nowWallClock();
    const existing = await repo.findById("task-demo-001");
    if (existing) {
      existing.status = "pending";
      existing.claimedBy = undefined;
      existing.claimedAt = undefined;
      existing.plan = undefined;
      existing.planBatches = undefined;
      existing.outputUrl = undefined;
      existing.outputUrls = undefined;
      existing.failMessage = undefined;
      if (sourceUrl) existing.sourceUrl = sourceUrl;
      existing.updatedAt = now;
      await repo.save(existing);
      void this.notifyTopLevelPending(1);
      return;
    }
    await repo.create({
      taskId: "task-demo-001",
      templateId: "vertical_hook_60s",
      asrRuleSetId: defaultRules.ruleSetId,
      configVersion: this.state.profile.configVersion,
      sourceUrl: sourceUrl ?? `${this.apiPublicBase}/oss/sources/demo.mp4`,
      dramaId: "drama-demo",
      dramaMeta: { title: "演示短剧" },
      taskKind: "single",
      status: "pending",
    });
    void this.notifyTopLevelPending(1);
  }

  private toTask(task: TaskRecord): ClipTask {
    return {
      taskId: task.taskId,
      templateId: task.templateId,
      asrRuleSetId: task.asrRuleSetId,
      configVersion: task.configVersion,
      sourceUrl: task.sourceUrl,
      dramaId: task.dramaId,
      dramaMeta: task.dramaMeta,
      taskKind: task.taskKind ?? "single",
      dramaPackage: task.dramaPackage,
      packageUrl: task.taskKind === "drama_package" ? task.sourceUrl : undefined,
      episodeNo: task.episodeNo,
      episodeId: task.episodeId,
      mixEpisodeIds: task.mixEpisodeIds,
      mixEpisodes: this.buildMixEpisodes(task),
      status: task.status,
      claimedBy: task.claimedBy,
      claimedAt: task.claimedAt,
      outputUrl: task.outputUrl,
      outputUrls: task.outputUrls,
      mixRenders: task.mixRenders,
      failMessage: task.failMessage,
      processingStartedAt: task.processingStartedAt,
      processingCompletedAt: task.processingCompletedAt,
      totalWallTimeSec: task.totalWallTimeSec,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private toTaskDetail(task: TaskRecord): ClipTaskDetail {
    return {
      ...this.toTask(task),
      plan: task.plan,
      planBatches: task.planBatches,
    };
  }
}
