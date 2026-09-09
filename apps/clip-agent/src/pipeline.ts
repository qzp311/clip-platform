import { access, copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type {
  AgentHeartbeatResponse,
  AgentServicesConfig,
  AsrSegment,
  ClipPlan,
  ClipPlanBatch,
  ClipPlanDurationTier,
  ClipTask,
  DramaEpisodeRecord,
  DramaPackageMeta,
  EffectiveConfig,
  MixRenderRecord,
  RawAsrSegment,
  TelemetryBatch,
} from "@clip/sdk";
import { formatDurationSec, formatAutoclipOutputFilename, formatLocalOutputUrl, parseClipLocalSourceUrl, resolveActiveResourceLoad, resolveClipBatchNo, resolveClipDramaTitle, shouldUploadAfterRender } from "@clip/sdk";
import type { ResolvedResourceLoad } from "@clip/sdk";
import { basename } from "node:path";
import { readEffectiveAgentVersion } from "./effective-version.js";
import {
  RuleEngine,
  FfmpegRenderer,
  contiguityWarnings,
  validateClipPlan,
  expandClipBlockRanges,
  finalizeSkillsMechanicalBoundaries,
  MIN_PLAN_DURATION_SEC,
  MAX_PLAN_DURATION_SEC,
  prepareRenderClips,
  finalizeEpisodeAsrFromRaw,
  probeVideoDurationMs,
  probeVideoInfo,
  resolveAsrSourceDurationMs,
  applyEditFormToPlan,
  annotatePlanDurationMeta,
  evaluateSkillsPlanQuality,
  isSkillsPlanAcceptable,
  resetGpuPipelineSession,
  probeSegmentLoudnessBatch,
} from "@clip/agent-core";
import type { AsrSourceDurationInfo, VideoBasicInfo } from "@clip/agent-core";
import type { FunasrSidecar } from "./funasr-sidecar.js";
import { uploadOutputVideoAndDelete } from "./oss-client.js";
import { applyAgentProcessPriority, setWindowsProcessPriority } from "./process-priority.js";
import { resolveSourceVideo } from "./source-resolver.js";
import { listDramaEpisodes } from "./material-submit.js";
import { logClipPlanBatchToConsole, logClipPlanToConsole } from "./plan-log.js";
import {
  getDramaEpisodeSources,
  getTaskLocalSource,
} from "./local-source-registry.js";
import { resolveEpisodeFromPackageFallback } from "./package-fallback.js";
import { removeTaskWorkspace } from "./workspace-cleaner.js";
import { ensureTaskLocalOutputDir, resolveLocalOutputRoot, resolveTaskLocalOutputDir } from "./local-output.js";
import { humanMarkersByPath, loadHumanMarkers, mergeHumanMarkersIntoSegments } from "./human-markers.js";
import { processDramaPackageTask as runDramaPackageOrchestrator } from "./package-orchestrator.js";
import { runRemixReplica } from "./run-remix-replica.js";
import { resolveAgentPaths } from "./paths.js";
import { RenderJobQueue } from "./render-queue.js";
import {
  finishTaskProgress,
  startTaskProgress,
  updateTaskProgress,
} from "./task-progress.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function probeEpisodeSourceDurationsMs(
  sourceVideos: Record<string, string>,
  ffprobePath?: string,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  await Promise.all(
    Object.entries(sourceVideos).map(async ([episodeId, path]) => {
      try {
        result[episodeId] = await probeVideoDurationMs(path, ffprobePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  无法探测 ${episodeId} 视频时长: ${message}`);
      }
    }),
  );
  return result;
}

function logAsrDurationAudit(
  label: string,
  duration: AsrSourceDurationInfo,
  lastEndMs: number,
  tailRepairs: string[],
): void {
  const videoSec =
    duration.videoDurationMs != null ? (duration.videoDurationMs / 1000).toFixed(2) : "N/A";
  const audioSec =
    duration.audioDurationMs != null ? (duration.audioDurationMs / 1000).toFixed(2) : "N/A";
  const transcribeSec = (duration.transcribeDurationMs / 1000).toFixed(2);
  const sourceSec = (duration.sourceDurationMs / 1000).toFixed(2);
  const lastSec = (lastEndMs / 1000).toFixed(2);
  const gapMs = duration.sourceDurationMs - lastEndMs;
  const level = gapMs > 80 ? "WARN" : "OK";
  console.log(
    `ASR 时长 [${level}] ${label}: 视频=${videoSec}s 音轨=${audioSec}s 转写=${transcribeSec}s 采用=${sourceSec}s 末段=${lastSec}s` +
      (gapMs > 80 ? ` 仍未覆盖=${(gapMs / 1000).toFixed(2)}s` : "") +
      (tailRepairs.length ? ` | ${tailRepairs.join("; ")}` : ""),
  );
  if (gapMs > 80) {
    console.warn(
      `ASR 集尾仍未对齐视频时长 (${label})：请确认 ffprobe 可用且 Agent 已更新至最新版本`,
    );
  }
}

function resolveRenderPipelineSettings(config: EffectiveConfig): {
  maxConcurrentRenders: number;
  maxConcurrentUploads: number;
  llmRenderPipeline: boolean;
  resource: ResolvedResourceLoad;
} {
  const resource = resolveActiveResourceLoad(config.services?.resourcePolicy);
  const limits = config.render.limits;
  // 资源策略档位优先；未配置时回落 render.limits
  const maxConcurrentRenders = Math.max(
    1,
    Math.min(8, resource.profile.maxConcurrentRenders ?? limits?.maxConcurrentRenders ?? 2),
  );
  const maxConcurrentUploads = Math.max(
    1,
    Math.min(
      8,
      resource.profile.maxConcurrentUploads ?? limits?.maxConcurrentUploads ?? maxConcurrentRenders,
    ),
  );
  return {
    maxConcurrentRenders,
    maxConcurrentUploads,
    llmRenderPipeline: limits?.llmRenderPipeline !== false,
    resource,
  };
}

function createTaskRenderer(
  options: AgentClientOptions,
  workDir: string,
  resource: ResolvedResourceLoad,
): FfmpegRenderer {
  const threads = resource.profile.ffmpegThreads ?? 0;
  return new FfmpegRenderer({
    ffmpegPath: options.ffmpegPath ?? "ffmpeg",
    ffprobePath: options.ffprobePath,
    workDir,
    fontsDir: options.fontsDir,
    stickersDir: options.stickersDir,
    threads: threads > 0 ? threads : undefined,
    onSpawn: (pid) => {
      void setWindowsProcessPriority(pid, resource.profile.processPriority);
    },
  });
}

async function applyResourcePolicyForTask(config: EffectiveConfig): Promise<ResolvedResourceLoad> {
  const resource = resolveActiveResourceLoad(config.services?.resourcePolicy);
  await applyAgentProcessPriority(resource.profile.processPriority);
  console.log(
    `[resource] mode=${resource.mode} window=${resource.window} ` +
      `renders=${resource.profile.maxConcurrentRenders} uploads=${resource.profile.maxConcurrentUploads} ` +
      `priority=${resource.profile.processPriority} ffmpegThreads=${resource.profile.ffmpegThreads ?? 0}`,
  );
  return resource;
}

async function allocateAutoclipOutputName(
  outputDir: string,
  input: { dramaTitle: string; batch: number; outputSeqInBatch: number },
): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const now = new Date(Date.now() + attempt * 1000);
    const name = formatAutoclipOutputFilename({ ...input, now });
    try {
      await access(join(outputDir, name));
    } catch {
      return name;
    }
  }
  throw new Error("unable to allocate unique autoclip output filename");
}

interface MixPlanRenderResult {
  outputPath: string;
  outputName: string;
  round: number;
  outputIndex: number;
  planSeqInRound: number;
  plan: ClipPlan;
  strategy?: string;
  durationTier?: ClipPlanDurationTier;
  narrativeLine?: string;
  /** 成片 mp4 真实时长（ffprobe） */
  durationSec: number;
  /** 成片视频基本数据：宽/高/时长/文件字节数 */
  videoInfo?: VideoBasicInfo;
  /** 成片文件大小（字节） */
  fileSizeBytes?: number;
}

interface MixUploadContext {
  taskId: string;
  config: EffectiveConfig;
  dramaTitle: string;
  mixRenders: MixRenderRecord[];
  uploadJobs: Array<Promise<void>>;
}

export interface AgentCredentials {
  deviceId: string;
  deviceToken: string;
}

export interface AgentClientOptions {
  apiBase: string;
  credentials: AgentCredentials;
  ffmpegPath?: string;
  ffprobePath?: string;
  workspaceDir?: string;
  installDir?: string;
  fontsDir?: string;
  stickersDir?: string;
}

export class ClipApiClient {
  constructor(private readonly options: AgentClientOptions) {}

  updateCredentials(credentials: AgentCredentials): void {
    this.options.credentials = credentials;
  }

  authHeaders(): Record<string, string> {
    return {
      "x-device-id": this.options.credentials.deviceId,
      "x-device-token": this.options.credentials.deviceToken,
    };
  }

  jsonHeaders(): Record<string, string> {
    return {
      ...this.authHeaders(),
      "content-type": "application/json",
    };
  }

  /** @deprecated use authHeaders() or jsonHeaders() */
  headers(): Record<string, string> {
    return this.authHeaders();
  }

  get apiBase(): string {
    return this.options.apiBase;
  }

  async fetchConfig(ruleSetId?: string): Promise<EffectiveConfig> {
    const url = new URL(`/agent/devices/${this.options.credentials.deviceId}/config`, this.options.apiBase);
    if (ruleSetId) url.searchParams.set("ruleSetId", ruleSetId);
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`config failed: ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    return res.json() as Promise<EffectiveConfig>;
  }

  async claimTask(taskId?: string): Promise<{ task: ClipTask | null; effectiveConfig?: EffectiveConfig }> {
    const url = new URL("/agent/tasks/claim", this.options.apiBase);
    if (taskId) url.searchParams.set("taskId", taskId);
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`claim failed: ${res.status}`);
    return res.json() as Promise<{ task: ClipTask | null; effectiveConfig?: EffectiveConfig }>;
  }

  async claimRemixReplica(jobId: string, deviceId: string): Promise<void> {
    const res = await fetch(new URL(`/agent/remix-replica/${encodeURIComponent(jobId)}/claim`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error(`claim remix replica failed: ${res.status}`);
  }

  async updateRemixReplicaStatus(
    jobId: string,
    status: string,
    patch?: { timeline?: Record<string, unknown>; errorMessage?: string },
  ): Promise<void> {
    const res = await fetch(
      new URL(`/agent/remix-replica/${encodeURIComponent(jobId)}/status`, this.options.apiBase),
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ status, ...patch }),
      },
    );
    if (!res.ok) throw new Error(`update remix replica status failed: ${res.status}`);
  }

  async releaseRemixReplicaClaim(jobId: string): Promise<void> {
    const res = await fetch(
      new URL(`/agent/remix-replica/${encodeURIComponent(jobId)}/release`, this.options.apiBase),
      {
        method: "POST",
        headers: this.jsonHeaders(),
      },
    );
    if (!res.ok) throw new Error(`release remix replica claim failed: ${res.status}`);
  }

  async getRemixFeatureCache(dramaId: string): Promise<
    | { cached: false }
    | {
        cached: true;
        objectKey: string;
        fingerprint: string;
        sizeBytes: number;
        frameCount: number;
        sourceCount: number;
        updatedAt: string;
      }
  > {
    const res = await fetch(
      new URL(`/agent/remix-replica/${encodeURIComponent(dramaId)}/feature-cache`, this.options.apiBase),
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw new Error(`get remix feature cache failed: ${res.status}`);
    return res.json() as Promise<
      | { cached: false }
      | {
          cached: true;
          objectKey: string;
          fingerprint: string;
          sizeBytes: number;
          frameCount: number;
          sourceCount: number;
          updatedAt: string;
        }
    >;
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
    const res = await fetch(
      new URL(`/agent/remix-replica/${encodeURIComponent(dramaId)}/feature-cache`, this.options.apiBase),
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) throw new Error(`set remix feature cache failed: ${res.status}`);
  }

  async getTask(taskId: string): Promise<ClipTask> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}`, this.options.apiBase), {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`get task failed: ${res.status}`);
    const data = (await res.json()) as { task: ClipTask };
    return data.task;
  }

  async retryTask(taskId: string): Promise<void> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/retry`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: "{}",
    });
    if (!res.ok) throw new Error(`retry task failed: ${res.status}`);
  }

  async fetchMixSegments(taskId: string): Promise<AsrSegment[]> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/mix-segments`, this.options.apiBase), {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`mix-segments failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { segments: AsrSegment[] };
    const segs = data.segments ?? [];
    const hooks = segs.filter((s) => s.usableAsHook);
    const labeled = segs.filter((s) => s.highlightType);
    console.log(
      `  mix-segments 标签: 总${segs.length} · 高光${labeled.length} · 可作片头${hooks.length}` +
        (hooks[0] ? ` · 例 ${hooks[0].segmentId}/${hooks[0].highlightType}「${hooks[0].text?.slice(0, 20)}」` : ""),
    );
    return segs;
  }

  async submitAsrResult(
    taskId: string,
    segments: AsrSegment[],
    rawSegments: RawAsrSegment[],
    rawSegmentCount?: number,
  ): Promise<AsrSubmitResult> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/asr-result`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ segments, rawSegments, rawSegmentCount }),
    });
    if (!res.ok) throw new Error(`asr-result failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AsrSubmitResult>;
  }

  async requestPlan(taskId: string, segments: AsrSegment[]): Promise<ClipPlan> {
    const res = await fetch(new URL("/api/v1/clip/plan", this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ taskId, segments }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`plan failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as ClipPlan | ClipPlanBatch;
    if ("plans" in data && Array.isArray(data.plans)) {
      return data.plans[0]!;
    }
    return data as ClipPlan;
  }

  async requestPlanBatch(
    taskId: string,
    segments: AsrSegment[],
    round: number,
  ): Promise<ClipPlanBatch> {
    const url = new URL("/api/v1/clip/plan", this.options.apiBase);
    const body = JSON.stringify({ taskId, segments, round });
    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: this.jsonHeaders(),
          body,
          // 单条 plan 请求给 180s，避免服务端方案生成慢时 Agent 提前断开
          signal: AbortSignal.timeout(180_000),
        });
        if (res.ok) return (await res.json()) as ClipPlanBatch;
        const text = await res.text();
        // 5xx 或 429 才重试；业务 4xx 直接失败
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`plan batch failed: ${res.status} ${text.slice(0, 300)}`);
          if (attempt < maxAttempts) {
            const delay = 1000 * 2 ** (attempt - 1);
            console.warn(`[plan] 第 ${attempt}/${maxAttempts} 次请求失败，${delay}ms 后重试: ${res.status}`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        throw new Error(`plan batch failed: ${res.status} ${text.slice(0, 300)}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        lastErr = new Error(`plan batch request failed: ${detail}`);
        if (attempt < maxAttempts) {
          const delay = 1000 * 2 ** (attempt - 1);
          console.warn(`[plan] 第 ${attempt}/${maxAttempts} 次请求异常，${delay}ms 后重试: ${detail}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
    }
    throw lastErr ?? new Error("plan batch request failed");
  }

  async completeTask(
    taskId: string,
    outputUrl: string,
    timing?: TaskPipelineTiming,
    videoInfo?: VideoBasicInfo,
  ): Promise<TaskCompleteResult> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/complete`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ outputUrl, videoInfo, ...timing }),
    });
    if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<TaskCompleteResult>;
  }

  async completeMixTask(
    taskId: string,
    mixRenders: MixRenderRecord[],
    timing?: TaskPipelineTiming,
  ): Promise<TaskCompleteResult> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/complete`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ mixRenders, ...timing }),
    });
    if (!res.ok) throw new Error(`complete mix failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<TaskCompleteResult>;
  }

  /** 素材库推 TOS 后回写 clip_task_output（追加或本地 URL 升级为 https） */
  async appendTaskOutput(
    taskId: string,
    input: { outputUrl: string; localOutputPath?: string; filename?: string },
  ): Promise<{ ok: boolean; outputUrls: string[]; mixRenders?: MixRenderRecord[] }> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/outputs`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`append output failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: boolean; outputUrls: string[]; mixRenders?: MixRenderRecord[] }>;
  }

  /** 无父任务时新建已完成任务并写入产出 */
  async registerUploadedOutput(input: {
    outputUrl: string;
    localOutputPath?: string;
    filename?: string;
    dramaTitle?: string;
    dramaId?: string;
  }): Promise<{ ok: boolean; taskId: string; outputUrls: string[] }> {
    const res = await fetch(new URL(`/agent/outputs/register-upload`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`register upload failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: boolean; taskId: string; outputUrls: string[] }>;
  }

  async failTask(taskId: string, message: string): Promise<void> {
    const url = new URL(`/agent/tasks/${taskId}/fail`, this.options.apiBase);
    const body = JSON.stringify({ message });
    const maxAttempts = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: this.jsonHeaders(),
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return;
        const text = await res.text();
        lastErr = new Error(`fail report failed: ${res.status} ${text.slice(0, 200)}`);
        if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts) {
          const delay = 1000 * 2 ** (attempt - 1);
          console.warn(`[fail] 第 ${attempt}/${maxAttempts} 次上报失败，${delay}ms 后重试: ${res.status}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw lastErr;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        lastErr = new Error(`fail report failed: ${detail}`);
        if (attempt < maxAttempts) {
          const delay = 1000 * 2 ** (attempt - 1);
          console.warn(`[fail] 第 ${attempt}/${maxAttempts} 次上报异常，${delay}ms 后重试: ${detail}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
    }
    // failTask 是尽力而为：Agent 本地已经失败，服务端状态最终靠 claim 超时回收
    console.error(`[fail] 任务失败状态上报未成功，已本地丢弃: ${lastErr?.message ?? ""}`);
  }

  async updatePackagePhase(
    taskId: string,
    phase: string,
    extra?: { episodeCount?: number },
  ): Promise<void> {
    const res = await fetch(new URL(`/agent/tasks/${taskId}/package-phase`, this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ phase, ...extra }),
    });
    if (!res.ok) throw new Error(`package phase update failed: ${res.status}`);
  }

  async completePackageTask(
    packageTaskId: string,
    mixTaskId: string,
    timing?: TaskPipelineTiming,
  ): Promise<ClipTask> {
    const res = await fetch(
      new URL(`/agent/tasks/${packageTaskId}/package-complete`, this.options.apiBase),
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ mixTaskId, ...timing }),
      },
    );
    if (!res.ok) throw new Error(`package complete failed: ${res.status}`);
    const data = (await res.json()) as { task: ClipTask };
    return data.task;
  }

  async sendTelemetry(batch: TelemetryBatch): Promise<void> {
    const res = await fetch(new URL("/agent/telemetry/events", this.options.apiBase), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`telemetry failed: ${res.status}`);
  }

  async heartbeat(): Promise<AgentHeartbeatResponse> {
    const agentVersion = await readEffectiveAgentVersion(this.options.installDir);
    const res = await fetch(
      new URL(`/agent/devices/${this.options.credentials.deviceId}/heartbeat`, this.options.apiBase),
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ agentVersion }),
      },
    );
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
    return res.json() as Promise<AgentHeartbeatResponse>;
  }

  async reportPackageCache(input: Record<string, unknown>): Promise<void> {
    const res = await fetch(new URL("/agent/package-caches/heartbeat", this.options.apiBase), {
      method: "POST", headers: this.jsonHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`package cache heartbeat failed: ${res.status}`);
  }

  async checkUpdates(version: string): Promise<Record<string, unknown>> {
    const url = new URL("/agent/updates/check", this.options.apiBase);
    url.searchParams.set("version", version);
    url.searchParams.set("platform", "win-x64-4060");
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`updates check failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }
}

export interface AsrSubmitResult {
  ok: boolean;
  segmentCount: number;
  subtitleUrl?: string;
  subtitlesJsonUrl?: string;
}

export interface TaskCompleteResult {
  ok: boolean;
  outputUrl: string;
  outputUrls?: string[];
  mixRenders?: MixRenderRecord[];
}

export interface EpisodeBatchProgress {
  taskId?: string;
  title?: string;
  kind?: string;
  stepCurrent: number;
  stepTotal: number;
}

export interface RunTaskOptions {
  sourceVideo?: string;
  mockAsrFile?: string;
  /** 跨集混剪：episodeId -> 本地视频路径 */
  episodeSources?: Record<string, string>;
  /** 剧级包任务混剪时传入，用于成片命名批次号 */
  dramaPackage?: DramaPackageMeta;
  /** 桌面素材任务 jobId，用于进度面板关联 */
  progressJobId?: string;
  /** 整包/批量 ASR 时由外层传入，用于桌面进度条 */
  progress?: EpisodeBatchProgress;
  /** drama_package 子流程（混剪）时关联的整包 taskId */
  packageTaskId?: string;
}

export interface ProcessTaskOptions {
  mockAsrFile?: string;
}

export interface TaskPipelineTiming {
  processingStartedAt: string;
  totalWallTimeSec: number;
  /** 复刻任务裂变素材上传后的公网 URL 列表 */
  fissionUrls?: string[];
}

export interface TaskPipelineResult {
  timing: TaskPipelineTiming;
}

export class AgentPipeline {
  private ruleEngine = new RuleEngine();
  private sidecar: FunasrSidecar | null = null;

  constructor(private readonly client: ClipApiClient, private readonly options: AgentClientOptions) {}

  setSidecar(sidecar: FunasrSidecar | null): void {
    this.sidecar = sidecar;
  }

  async reportPackageCache(input: Record<string, unknown>): Promise<void> {
    await this.client.reportPackageCache(input);
  }

  /** daemon 启动补装 FFmpeg 后同步路径 */
  setMediaPaths(paths: { ffmpegPath: string; ffprobePath: string; fontsDir?: string; stickersDir?: string }): void {
    this.options.ffmpegPath = paths.ffmpegPath;
    this.options.ffprobePath = paths.ffprobePath;
    if (paths.fontsDir) this.options.fontsDir = paths.fontsDir;
    if (paths.stickersDir) this.options.stickersDir = paths.stickersDir;
  }

  async runOnce(input: RunTaskOptions): Promise<void> {
    const claim = await this.client.claimTask();
    if (!claim.task) {
      console.log("no pending task");
      return;
    }

    const config =
      claim.effectiveConfig ??
      (await this.client.fetchConfig(claim.task.asrRuleSetId));

    await this.processClaimedTask(claim.task, config, {
      sourceVideo: input.sourceVideo,
      mockAsrFile: input.mockAsrFile,
    });
  }

  async processTask(
    taskId: string,
    sourceVideo: string,
    mockAsrFile?: string,
    progressJobId?: string,
  ): Promise<void> {
    let claim = await this.client.claimTask(taskId);
    if (!claim.task) {
      await this.client.retryTask(taskId);
      claim = await this.client.claimTask(taskId);
    }
    if (!claim.task) {
      throw new Error(`cannot claim task ${taskId} (not pending or not found)`);
    }

    const config =
      claim.effectiveConfig ??
      (await this.client.fetchConfig(claim.task.asrRuleSetId));

    await this.processClaimedTask(claim.task, config, {
      sourceVideo,
      mockAsrFile,
      progressJobId,
    });
  }

  async processClaimedTask(
    task: ClipTask,
    config: EffectiveConfig,
    input: RunTaskOptions & ProcessTaskOptions = {},
  ): Promise<void> {
    await applyResourcePolicyForTask(config);
    const enriched: RunTaskOptions & ProcessTaskOptions = { ...input };

    if (!enriched.sourceVideo) {
      enriched.sourceVideo = await this.resolveTaskLocalSource(task);
    }

    if (task.taskKind === "drama_mix" && !enriched.episodeSources && task.dramaId) {
      enriched.episodeSources = await getDramaEpisodeSources(task.dramaId);
    }

    if (task.taskKind === "drama_package") {
      console.log(`[package] process taskId=${task.taskId} downloadUrl=${task.sourceUrl}`);
      return this.processDramaPackageTask(task, config, enriched);
    }
    if (task.taskKind === "episode_asr" || task.taskKind === "output_asr") {
      return this.processEpisodeAsr(task, config, enriched);
    }
    if (task.taskKind === "drama_mix") {
      return this.processDramaMixTask(task, config, enriched);
    }
    if (task.taskKind === "remix_replica") {
      const workspaceRoot =
        this.options.workspaceDir ?? join(homedir(), ".clip-agent", "workspace");
      const workspaceDir = join(workspaceRoot, "remix-replica", task.taskId);
      const outputDir = await ensureTaskLocalOutputDir(config, task.taskId);
      const paths = resolveAgentPaths({ installDir: this.options.installDir });
      // 复刻器使用独立 Python（engines/python），避免污染 FunASR venv；缺失时回退到 bundled Python
      const remixPython = paths.installDir && existsSync(join(paths.installDir, "engines", "python", "python.exe"))
        ? join(paths.installDir, "engines", "python", "python.exe")
        : paths.pythonPath;
      const { outputUrl, fissionUrls } = await runRemixReplica({
        task,
        client: this.client,
        deviceId: this.options.credentials.deviceId,
        workspaceDir,
        outputDir,
        config,
        workspaceRoot,
        ffmpegPath: this.options.ffmpegPath,
        ffprobePath: this.options.ffprobePath,
        pythonPath: remixPython,
      });
      console.log(
        `[remix-replica] 任务完成 task=${task.taskId} outputUrl=${outputUrl} fissionUrls=${fissionUrls.length}`,
      );
      return;
    }
    return this.processSingleVideoTask(task, config, enriched);
  }

  async processDramaPackageTask(
    task: ClipTask,
    config: EffectiveConfig,
    input: RunTaskOptions & ProcessTaskOptions = {},
  ): Promise<void> {
    const workspaceRoot =
      this.options.workspaceDir ?? join(homedir(), ".clip-agent", "workspace");
    await runDramaPackageOrchestrator(task, config, {
      client: this.client,
      pipeline: this,
      apiBase: this.options.apiBase,
      headers: this.client.jsonHeaders(),
      workspaceRoot,
      deviceId: this.options.credentials.deviceId,
      mockAsrFile: input.mockAsrFile,
    });
  }

  private async resolveTaskLocalSource(task: ClipTask): Promise<string | undefined> {
    const fromUrl = parseClipLocalSourceUrl(task.sourceUrl);
    if (fromUrl) return fromUrl;

    const fromRegistry = await getTaskLocalSource(task.taskId);
    if (fromRegistry) return fromRegistry;

    if (task.taskKind === "episode_asr" && task.dramaId && task.episodeId) {
      const episodes = await getDramaEpisodeSources(task.dramaId);
      return episodes[task.episodeId];
    }

    return undefined;
  }

  private async processSingleVideoTask(
    task: ClipTask,
    config: EffectiveConfig,
    input: RunTaskOptions & ProcessTaskOptions = {},
  ): Promise<void> {
    const workspaceRoot =
      this.options.workspaceDir ?? join(homedir(), ".clip-agent", "workspace");
    const workspace = join(workspaceRoot, task.taskId);
    const pipelineStartedAt = Date.now();

    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(workspace, "meta.json"),
        JSON.stringify(
          {
            taskId: task.taskId,
            configVersion: config.configVersion,
            ruleSetId: config.asr.rules.ruleSetId,
            ruleSetVersion: config.asr.rules.ruleSetVersion,
          },
          null,
          2,
        ),
      );

      const sourceVideo =
        input.sourceVideo ?? (await resolveSourceVideo(task.sourceUrl, workspace));
      const dramaTitle = resolveClipDramaTitle(task);
      const displayTitle =
        dramaTitle !== "drama" && dramaTitle !== task.dramaId
          ? dramaTitle
          : basename(sourceVideo);
      await startTaskProgress({
        taskId: task.taskId,
        jobId: input.progressJobId,
        title: displayTitle,
        kind: "single",
        phaseCode: "asr",
        phase: "语音识别中…",
        stepCurrent: 1,
        stepTotal: 3,
      });

      const resource = resolveActiveResourceLoad(config.services?.resourcePolicy);
      const renderer = createTaskRenderer(this.options, join(workspace, "ffmpeg"), resource);

      const audioPath = join(workspace, "audio.wav");
      const asrStarted = Date.now();
      await renderer.extractAudio(sourceVideo, audioPath);

      const transcribeResult = await this.transcribe(audioPath, config, input.mockAsrFile);
      const rawSegments = transcribeResult.rawSegments;
      const durationInfo = await resolveAsrSourceDurationMs(
        sourceVideo,
        transcribeResult.durationMs,
        { ffprobePath: this.options.ffprobePath, audioPath },
      );
      const { segments, stats, tailRepairs } = finalizeEpisodeAsrFromRaw(
        this.ruleEngine,
        rawSegments,
        config.asr.rules,
        {
          sourceDurationMs: durationInfo.sourceDurationMs,
          episodeId: task.episodeId,
        },
      );
      logAsrDurationAudit(
        task.episodeId ?? task.taskId,
        durationInfo,
        segments.at(-1)?.endMs ?? 0,
        tailRepairs,
      );

      const asrSaved = await this.client.submitAsrResult(
        task.taskId,
        segments,
        rawSegments,
        stats.rawCount,
      );
      console.log(
        `ASR saved to server: ${asrSaved.segmentCount} segments` +
          (asrSaved.subtitleUrl ? `, subtitle=${asrSaved.subtitleUrl}` : ""),
      );
      await this.client.sendTelemetry({
        deviceId: this.options.credentials.deviceId,
        taskId: task.taskId,
        configVersion: config.configVersion,
        asrRuleSetId: config.asr.rules.ruleSetId,
        asrRuleSetVersion: config.asr.rules.ruleSetVersion,
        events: [
          {
            type: "asr.completed",
            metrics: {
              audioDurationSec: (durationInfo.sourceDurationMs || segments.at(-1)?.endMs || 0) / 1000,
              wallTimeSec: (Date.now() - asrStarted) / 1000,
              rawSegmentCount: stats.rawCount,
              finalSegmentCount: stats.finalCount,
              filteredSegmentCount: stats.filteredCount,
              deviceUsed: config.asr.runtime.device,
              success: true,
            },
          },
        ],
      });

      await updateTaskProgress({
        active: true,
        taskId: task.taskId,
        jobId: input.progressJobId,
        title: displayTitle,
        kind: "single",
        phaseCode: "mix_plan",
        phase: "智能选段中…",
        stepCurrent: 2,
        stepTotal: 3,
      });

      const plan = await this.client.requestPlan(task.taskId, segments);
      logClipPlanToConsole(plan, "大模型选段结果（单集）");
      const validation = validateClipPlan(plan, segments, config.render);
      if (validation.warnings.length) {
        console.log(`clip plan warnings: ${validation.warnings.join("; ")}`);
      }
      if (!validation.valid) {
        throw new Error(`invalid plan: ${validation.errors.join("; ")}`);
      }

      const uploadEnabled = shouldUploadAfterRender(config);
      console.log(
        `[upload] 单集上传开关: ${uploadEnabled}, uploadAfterRender=${config.render?.limits?.uploadAfterRender}, tosEnabled=${config.render?.storage?.tos?.enabled}`,
      );
      const outputDir = uploadEnabled
        ? workspace
        : await ensureTaskLocalOutputDir(config, task.taskId);
      const outputName = await allocateAutoclipOutputName(outputDir, {
        dramaTitle: resolveClipDramaTitle(task),
        batch: resolveClipBatchNo(1),
        outputSeqInBatch: 1,
      });
      const outputPath = join(outputDir, outputName);
      await updateTaskProgress({
        active: true,
        taskId: task.taskId,
        jobId: input.progressJobId,
        title: displayTitle,
        kind: "single",
        phaseCode: "render",
        phase: "渲染成片中…",
        stepCurrent: 3,
        stepTotal: 3,
      });
      const renderResult = await renderer.render({
        sourceVideo,
        plan,
        segments,
        config,
        outputPath,
        dramaTitle,
      });
      const outputBytes = renderResult.fileSizeBytes ?? (await stat(outputPath)).size;
      const outputUrl = uploadEnabled
        ? (
            await uploadOutputVideoAndDelete({
              apiBase: this.options.apiBase,
              headers: this.client.jsonHeaders(),
              taskId: task.taskId,
              outputPath,
              filename: outputName,
              config,
              folderSegment: resolveClipDramaTitle(task),
              ffmpegPath: this.options.ffmpegPath ?? "ffmpeg",
              ffprobePath: this.options.ffprobePath ?? "ffprobe",
            })
          ).url
        : formatLocalOutputUrl(outputPath);
      const timing = this.buildTaskTiming(pipelineStartedAt);
      const completed = await this.client.completeTask(task.taskId, outputUrl, timing, renderResult.videoInfo);
      this.logPipelineComplete(task.taskId, timing, "single");
      if (uploadEnabled) {
        console.log(`output uploaded to server: ${completed.outputUrl}`);
      } else {
        console.log(`output kept locally (upload skipped): ${outputPath}`);
      }

      await this.client.sendTelemetry({
        deviceId: this.options.credentials.deviceId,
        taskId: task.taskId,
        configVersion: config.configVersion,
        asrRuleSetId: config.asr.rules.ruleSetId,
        asrRuleSetVersion: config.asr.rules.ruleSetVersion,
        events: [
          {
            type: "render.completed",
            metrics: {
              outputDurationSec: validation.totalDurationMs / 1000,
              wallTimeSec: renderResult.wallTimeSec,
              codec: renderResult.codec,
              outputBytes,
              success: true,
            },
          },
          {
            type: "task.completed",
            metrics: {
              success: true,
              totalWallTimeSec: timing.totalWallTimeSec,
              processingStartedAt: timing.processingStartedAt,
            },
          },
        ],
      });

      console.log(
        uploadEnabled
          ? `task ${task.taskId} completed (local output removed after upload)`
          : `task ${task.taskId} completed (local output preserved at ${outputPath})`,
      );
      if (uploadEnabled) {
        await this.pruneTaskWorkspace(workspace);
        await this.pruneTaskLocalOutputs(task.taskId, config);
      } else {
        console.log(
          `local output preserved at ${outputPath} (workspace cleaned, root=${resolveLocalOutputRoot(config)})`,
        );
        await this.pruneTaskWorkspace(workspace);
      }
      await finishTaskProgress({ phase: "剪辑已完成" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`task ${task.taskId} failed: ${message}`);
      await finishTaskProgress({ phase: "剪辑失败", error: message });
      await this.client.failTask(task.taskId, message);
      await this.client.sendTelemetry({
        deviceId: this.options.credentials.deviceId,
        taskId: task.taskId,
        configVersion: config.configVersion,
        asrRuleSetId: config.asr.rules.ruleSetId,
        asrRuleSetVersion: config.asr.rules.ruleSetVersion,
        events: [{ type: "task.failed", metrics: { success: false, error: message } }],
      });
      throw err;
    }
  }

  async processEpisodeAsr(
    task: ClipTask,
    config: EffectiveConfig,
    input: RunTaskOptions & ProcessTaskOptions = {},
  ): Promise<void> {
    const workspaceRoot =
      this.options.workspaceDir ?? join(homedir(), ".clip-agent", "workspace");
    const workspace = join(workspaceRoot, task.taskId);
    const batch = input.progress;
    const isOutputAsr = task.taskKind === "output_asr";
    const sourceHint =
      input.sourceVideo ||
      (task.sourceUrl ? parseClipLocalSourceUrl(task.sourceUrl) : null) ||
      task.sourceUrl ||
      task.taskId;
    const episodeLabel = isOutputAsr
      ? basename(String(sourceHint))
      : (task.episodeId ?? task.taskId);
    const progressKind = isOutputAsr ? "output_asr" : "episode_asr";

    const pushAsrProgress = async (phase: string, subStep?: "extract" | "transcribe" | "save") => {
      if (!batch) return;
      const sub =
        subStep === "extract"
          ? " · 提取音轨"
          : subStep === "transcribe"
            ? " · 转写中"
            : subStep === "save"
              ? " · 入库"
              : "";
      await updateTaskProgress({
        active: true,
        taskId: batch.taskId ?? task.taskId,
        title: batch.title,
        kind: batch.kind ?? progressKind,
        phaseCode: "asr",
        phase: `${phase}${sub}`,
        stepCurrent: batch.stepCurrent,
        stepTotal: batch.stepTotal,
      });
    };

    try {
      if (batch) {
        await pushAsrProgress(
          isOutputAsr
            ? `成片语音识别（${episodeLabel}）`
            : `语音识别 第 ${batch.stepCurrent}/${batch.stepTotal} 集（${episodeLabel}）`,
          "extract",
        );
      } else {
        await startTaskProgress({
          taskId: task.taskId,
          title: episodeLabel,
          kind: progressKind,
          phaseCode: "asr",
          phase: isOutputAsr ? `成片语音识别（${episodeLabel}）…` : `语音识别（${episodeLabel}）…`,
          stepCurrent: 1,
          stepTotal: 1,
        });
      }

      await mkdir(workspace, { recursive: true });
      resetGpuPipelineSession();

      // 解析 episode 视频源：优先使用显式传入的 sourceVideo；
      // clip-local 路径若在当前机器不存在，且任务属于剧包子任务，
      // 则回退到从父 drama_package 任务重新下载 zip 并解压对应分集。
      let sourceVideo: string | undefined = input.sourceVideo;
      if (!sourceVideo) {
        const localPath = parseClipLocalSourceUrl(task.sourceUrl);
        if (localPath && (await fileExists(localPath))) {
          sourceVideo = localPath;
        } else if (
          localPath &&
          task.taskKind === "episode_asr" &&
          task.parentPackageTaskId
        ) {
          console.log(
            `[episode-asr] clip-local 路径在当前机器不存在，尝试从父剧包回退下载: taskId=${task.taskId} episodeNo=${task.episodeNo} parent=${task.parentPackageTaskId}`,
          );
          sourceVideo = await resolveEpisodeFromPackageFallback(
            { client: this.client, workspaceRoot },
            task,
          );
        } else {
          sourceVideo = await resolveSourceVideo(task.sourceUrl, workspace);
        }
      }

      const renderer = createTaskRenderer(
        this.options,
        join(workspace, "ffmpeg"),
        resolveActiveResourceLoad(config.services?.resourcePolicy),
      );

      const audioPath = join(workspace, "audio.wav");
      await renderer.extractAudio(sourceVideo, audioPath);

      if (batch) {
        await pushAsrProgress(
          isOutputAsr
            ? `成片语音识别（${episodeLabel}）`
            : `语音识别 第 ${batch.stepCurrent}/${batch.stepTotal} 集（${episodeLabel}）`,
          "transcribe",
        );
      } else {
        await updateTaskProgress({
          active: true,
          taskId: task.taskId,
          kind: progressKind,
          phaseCode: "asr",
          phase: isOutputAsr ? `成片转写中（${episodeLabel}）…` : `转写中（${episodeLabel}）…`,
          stepCurrent: 1,
          stepTotal: 1,
        });
      }

      const transcribeResult = await this.transcribe(audioPath, config, input.mockAsrFile);
      const durationInfo = await resolveAsrSourceDurationMs(
        sourceVideo,
        transcribeResult.durationMs,
        { ffprobePath: this.options.ffprobePath, audioPath },
      );
      // 声学响度探测：按 raw 段时间戳跑 ffmpeg astats，回填 rmsDb/peakDb/speechRate。
      // 失败静默跳过（不影响主流程）；标签层据此加分，让"吼出来的冲突"可被识别。
      let rawSegmentsWithLoudness = transcribeResult.rawSegments;
      if (!input.mockAsrFile && transcribeResult.rawSegments.length) {
        try {
          rawSegmentsWithLoudness = await probeSegmentLoudnessBatch(
            audioPath,
            transcribeResult.rawSegments,
            { ffmpegPath: this.options.ffmpegPath },
          );
        } catch (err) {
          console.warn(
            `声学探测失败（已跳过，不影响转写）: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // 成片台词要对着画面：只跑规则引擎，不做片头/空隙/片尾连续化（那是分集选段用的）
      let segments;
      let stats;
      let tailRepairs: string[] = [];
      if (isOutputAsr) {
        const ruled = this.ruleEngine.apply(rawSegmentsWithLoudness, config.asr.rules);
        segments = ruled.segments.map((seg) => ({
          ...seg,
          speechStartMs: seg.speechStartMs ?? seg.startMs,
          ...(task.episodeId ? { episodeId: task.episodeId } : {}),
        }));
        stats = { ...ruled.stats, finalCount: segments.length };
        console.log(
          `[output-asr] 保留真实时间轴（跳过连续化）segments=${segments.length}`,
        );
      } else {
        const finalized = finalizeEpisodeAsrFromRaw(
          this.ruleEngine,
          rawSegmentsWithLoudness,
          config.asr.rules,
          {
            sourceDurationMs: durationInfo.sourceDurationMs,
            episodeId: task.episodeId,
          },
        );
        segments = finalized.segments;
        stats = finalized.stats;
        tailRepairs = finalized.tailRepairs;
      }
      logAsrDurationAudit(
        task.episodeId ?? task.taskId,
        durationInfo,
        segments.at(-1)?.endMs ?? 0,
        tailRepairs,
      );

      const asrSaved = await this.client.submitAsrResult(
        task.taskId,
        segments,
        transcribeResult.rawSegments,
        stats.rawCount,
      );
      const lastEndMs = segments.at(-1)?.endMs ?? 0;
      const videoSec =
        durationInfo.videoDurationMs != null
          ? (durationInfo.videoDurationMs / 1000).toFixed(1)
          : "N/A";
      const sourceSec = (durationInfo.sourceDurationMs / 1000).toFixed(1);
      const lastSec = (lastEndMs / 1000).toFixed(1);
      console.log(
        `${isOutputAsr ? "output" : "episode"} ASR saved: ${episodeLabel} -> ${asrSaved.segmentCount} segments` +
          ` | 视频=${videoSec}s 采用=${sourceSec}s 末段=${lastSec}s` +
          (tailRepairs.length ? ` | ${tailRepairs.join("; ")}` : ""),
      );

      if (batch) {
        await pushAsrProgress(
          isOutputAsr
            ? `成片语音识别（${episodeLabel}）`
            : `语音识别 第 ${batch.stepCurrent}/${batch.stepTotal} 集（${episodeLabel}）`,
          "save",
        );
      } else {
        await finishTaskProgress({
          phase: isOutputAsr ? `成片识别完成（${episodeLabel}）` : `识别完成（${episodeLabel}）`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${isOutputAsr ? "output" : "episode"} asr ${task.taskId} failed: ${message}`);
      await this.client.failTask(task.taskId, message);
      if (!batch) {
        await finishTaskProgress({ phase: isOutputAsr ? "成片识别失败" : "识别失败", error: message });
      }
      throw err;
    }
  }

  async processDramaMixTask(
    task: ClipTask,
    config: EffectiveConfig,
    input: RunTaskOptions & ProcessTaskOptions = {},
  ): Promise<void> {
    const workspaceRoot =
      this.options.workspaceDir ?? join(homedir(), ".clip-agent", "workspace");
    const workspace = join(workspaceRoot, task.taskId);
    const pipelineStartedAt = Date.now();

    try {
      await mkdir(workspace, { recursive: true });

      if (!task.dramaId) {
        throw new Error("混剪任务缺少 dramaId");
      }

      const episodes = await listDramaEpisodes(
        this.options.apiBase,
        this.client.authHeaders(),
        task.dramaId,
      );
      const mixEpisodes = task.mixEpisodeIds?.length
        ? episodes.filter((ep) => task.mixEpisodeIds!.includes(ep.episodeId))
        : episodes.filter((ep) => ep.status === "asr_done");

      if (!mixEpisodes.length) {
        throw new Error("没有可用于混剪的已识别集数");
      }

      let mergedSegments = await this.client.fetchMixSegments(task.taskId);

      // 合并桌面端人工高光标记：按分集路径匹配（归一化后比对），人工标记权重高于 ASR 自动高光
      const humanMarkers = loadHumanMarkers();
      if (humanMarkers.length && input.episodeSources) {
        const markersByPath = humanMarkersByPath(humanMarkers);
        const norm = (p: string) => String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
        const wantedKeys = new Set(Object.values(input.episodeSources!).map(norm));
        mergedSegments = mergeHumanMarkersIntoSegments(
          mergedSegments,
          Array.from(markersByPath.entries())
            .filter(([key]) => wantedKeys.has(key))
            .flatMap(([, list]) => list),
        );
      }

      for (const ep of mixEpisodes) {
        const count = mergedSegments.filter((s) => s.episodeId === ep.episodeId).length;
        const epSegs = mergedSegments.filter((s) => s.episodeId === ep.episodeId);
        const durSec = epSegs.length ? Math.ceil((epSegs.at(-1)!.endMs) / 1000) : 0;
        console.log(
          `  集 ${ep.episodeId} (第${ep.episodeNo}集): ${count} 段, 约 ${durSec}s`,
        );
      }
      const humanCount = mergedSegments.filter((s) => (s.labelSource ?? "").includes("human_marker")).length;
      console.log(
        `drama mix: ${task.dramaId}, episodes=${mixEpisodes.length}, segments=${mergedSegments.length}` +
          (humanCount > 0 ? `, 含人工高光 ${humanCount} 段` : ""),
      );
      resetGpuPipelineSession();

      if (!mergedSegments.length) {
        throw new Error("服务端未返回可用的混剪 ASR 片段，请确认各集 ASR 已写入 MySQL");
      }

      const sourceVideos = await this.resolveEpisodeSources(mixEpisodes, workspace, input.episodeSources);

    const totalRounds = Math.max(1, config.llm?.mixRoundsPerDrama ?? 2);
    const plansPerRound = Math.max(1, config.llm?.plansPerRound ?? 6);
    const totalOutputsExpected = totalRounds * plansPerRound;
    // 整剧总成片数传给渲染层，用于花字按整剧比例出现
    const totalOutputs = totalOutputsExpected;
      const pipelineSettings = resolveRenderPipelineSettings(config);
      const renderQueue = new RenderJobQueue(pipelineSettings.maxConcurrentRenders);
      const uploadQueue = new RenderJobQueue(pipelineSettings.maxConcurrentUploads);
      const uploadEnabled = shouldUploadAfterRender(config);
      console.log(
        `drama mix: ${totalRounds} 批 × 每批 1 次大模型调用（一次返回 ${plansPerRound} 条方案）≈ ${totalRounds * plansPerRound} 成片` +
          (uploadEnabled ? "" : "；上传已关闭，成片保留 Agent 本地"),
      );
      console.log(
        `[pipeline] 方案预取并行=${pipelineSettings.llmRenderPipeline ? "开" : "关"}，` +
          `FFmpeg并发=${pipelineSettings.maxConcurrentRenders}，上传并发=${pipelineSettings.maxConcurrentUploads}，` +
          `资源档=${pipelineSettings.resource.mode}/${pipelineSettings.resource.window}`,
      );

      const mixRenders: MixRenderRecord[] = [];
      const uploadJobs: Array<Promise<void>> = [];
      let totalRenderWallSec = 0;
      let outputIndexSeq = 1;
      const allocOutputIndex = () => outputIndexSeq++;
      const dramaTitle = resolveClipDramaTitle(task);
      const uploadCtx: MixUploadContext = {
        taskId: task.taskId,
        config,
        dramaTitle,
        mixRenders,
        uploadJobs,
      };
      const dramaPackage = input.dramaPackage ?? task.dramaPackage;
      let rendersDone = 0;
      const mixProgressBase = {
        taskId: input.packageTaskId ?? task.taskId,
        title: dramaTitle,
        kind: input.dramaPackage ? "drama_package" : (task.taskKind ?? "drama_mix"),
      };
      if (input.dramaPackage) {
        await updateTaskProgress({
          active: true,
          ...mixProgressBase,
          phaseCode: "mix_plan",
          phase: "跨集混剪选段…",
          stepCurrent: 0,
          stepTotal: totalOutputsExpected,
        });
      } else {
        await startTaskProgress({
          taskId: task.taskId,
          title: dramaTitle,
          kind: task.taskKind ?? "drama_mix",
          phaseCode: "mix_plan",
          phase: "准备跨集混剪…",
          stepCurrent: 0,
          stepTotal: totalOutputsExpected,
        });
      }
      const renderCtx = {
        mergedSegments,
        sourceVideos,
        config,
        workspace,
        taskId: task.taskId,
        dramaId: task.dramaId,
        dramaTitle,
        dramaPackage,
        uploadQueue,
        uploadCtx,
        onWallTime: (sec: number) => {
          totalRenderWallSec += sec;
        },
        onRenderDone: () => {
          rendersDone += 1;
          void updateTaskProgress({
            active: true,
            taskId: input.dramaPackage ? mixProgressBase.taskId : task.taskId,
            title: dramaTitle,
            kind: mixProgressBase.kind,
            phaseCode: "render",
            phase: `渲染成片 ${rendersDone}/${totalOutputsExpected}`,
            stepCurrent: rendersDone,
            stepTotal: totalOutputsExpected,
          });
        },
      };

      let nextBatchPromise: Promise<ClipPlanBatch> | null = null;

      for (let round = 1; round <= totalRounds; round++) {
        console.log(
          `\n--- 混剪第 ${round}/${totalRounds} 批：1 次大模型调用，一次返回 ${plansPerRound} 条方案 ---`,
        );

        const batch = nextBatchPromise
          ? await nextBatchPromise
          : await this.client.requestPlanBatch(task.taskId, mergedSegments, round);
        nextBatchPromise = null;

        logClipPlanBatchToConsole(
          batch,
          `大模型选段结果（跨集混剪 ${mixEpisodes.length} 集，第 ${round}/${totalRounds} 轮）`,
        );

        await updateTaskProgress({
          active: true,
          taskId: input.dramaPackage ? mixProgressBase.taskId : task.taskId,
          title: dramaTitle,
          kind: mixProgressBase.kind,
          phaseCode: "mix_plan",
          phase: `混剪选段 第 ${round}/${totalRounds} 批`,
          stepCurrent: round,
          stepTotal: totalRounds,
        });

        const roundJobs: Promise<boolean>[] = [];
        for (let planIdx = 0; planIdx < batch.plans.length; planIdx++) {
          const sourcePlan = batch.plans[planIdx]!;
          const planNo = planIdx + 1;
          const outputIndex = allocOutputIndex();
          console.log(`渲染 R${round}-P${planNo}: ${sourcePlan.strategy ?? "-"} / ${sourcePlan.durationTier ?? "-"}`);
          roundJobs.push(
            renderQueue.enqueue(() =>
              this.renderAndScheduleMixOutput({
                plan: sourcePlan,
                round,
                outputIndex,
                batchOutputSeq: planNo,
                uploadEnabled,
                totalOutputs,
                ...renderCtx,
              }),
            ),
          );
        }

        const roundResults = await Promise.all(roundJobs);
        for (let i = 0; i < roundResults.length; i++) {
          if (!roundResults[i]) {
            console.warn(`  跳过 R${round}-P${i + 1}: 方案未通过校验或时长不足`);
          }
        }

        if (pipelineSettings.llmRenderPipeline && round < totalRounds) {
          nextBatchPromise = this.client.requestPlanBatch(task.taskId, mergedSegments, round + 1);
          console.log(
            `[pipeline] 已预取第 ${round + 1}/${totalRounds} 轮方案（本轮渲染完成后）`,
          );
        }
      }

      await renderQueue.onIdle();
      if (uploadEnabled) {
        await Promise.all(uploadJobs);
        await uploadQueue.onIdle();
      }

      if (!mixRenders.length) {
        throw new Error("混剪未产出任何成片：所有方案均未通过校验或修复");
      }

      const timing = this.buildTaskTiming(pipelineStartedAt);
      const completed = await this.client.completeMixTask(task.taskId, mixRenders, timing);

      this.logPipelineComplete(task.taskId, timing, "drama_mix");
      console.log(
        `drama mix completed: ${mixRenders.length} outputs, first=${completed.outputUrl}`,
      );

      await this.client.sendTelemetry({
        deviceId: this.options.credentials.deviceId,
        taskId: task.taskId,
        configVersion: config.configVersion,
        asrRuleSetId: config.asr.rules.ruleSetId,
        asrRuleSetVersion: config.asr.rules.ruleSetVersion,
        events: [
          {
            type: "render.completed",
            metrics: {
              wallTimeSec: totalRenderWallSec,
              codec: "h264",
              episodeCount: mixEpisodes.length,
              outputCount: mixRenders.length,
              mixRounds: totalRounds,
              plansPerRound,
              maxConcurrentRenders: pipelineSettings.maxConcurrentRenders,
              maxConcurrentUploads: pipelineSettings.maxConcurrentUploads,
              llmRenderPipeline: pipelineSettings.llmRenderPipeline,
              success: true,
            },
          },
          {
            type: "task.completed",
            metrics: {
              success: true,
              taskKind: "drama_mix",
              outputCount: mixRenders.length,
              totalWallTimeSec: timing.totalWallTimeSec,
              processingStartedAt: timing.processingStartedAt,
            },
          },
        ],
      });
      if (uploadEnabled) {
        await this.pruneTaskWorkspace(workspace);
        await this.pruneTaskLocalOutputs(task.taskId, config);
      } else {
        console.log(
          `drama mix local outputs at ${resolveTaskLocalOutputDir(config, task.taskId)} (root=${resolveLocalOutputRoot(config)})`,
        );
        await this.pruneTaskWorkspace(workspace);
      }
      if (!input.dramaPackage) {
        await finishTaskProgress({
          phase: `混剪完成，共 ${mixRenders.length} 条成片`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`drama mix ${task.taskId} failed: ${message}`);
      if (!input.dramaPackage) {
        await finishTaskProgress({ phase: "混剪失败", error: message });
      }
      await this.client.failTask(task.taskId, message);
      throw err;
    }
  }

  private buildMixRenderRecord(
    rendered: MixPlanRenderResult,
    outputUrl: string,
    uploaded: boolean,
  ): MixRenderRecord {
    const plan = rendered.plan;
    return {
      round: rendered.round,
      planIndex: rendered.outputIndex,
      planSeqInRound: rendered.planSeqInRound,
      outputUrl,
      uploaded,
      // 即使已上传也保留本地路径，便于本地复用
      localOutputPath: rendered.outputPath,
      strategy: rendered.strategy ?? plan.strategy,
      durationTier: rendered.durationTier ?? plan.durationTier,
      narrativeLine: rendered.narrativeLine ?? plan.narrativeLine,
      editForm: plan.editForm,
      genreProfile: plan.genreProfile,
      targetDurationLabel: plan.targetDurationLabel,
      durationStatus: plan.durationStatus,
      hookType: plan.hookType,
      cliffType: plan.cliffType,
      // 入库用成片真实时长，不用 ASR 预计
      durationSec: rendered.durationSec,
      estimatedDurationSec: rendered.durationSec,
      videoInfo: rendered.videoInfo,
      fileSizeBytes: rendered.fileSizeBytes,
      skillsQuality: plan.skillsQuality,
    };
  }

  private async renderAndScheduleMixOutput(input: {
    plan: ClipPlan;
    round: number;
    outputIndex: number;
    batchOutputSeq: number;
    mergedSegments: AsrSegment[];
    sourceVideos: Record<string, string>;
    config: EffectiveConfig;
    workspace: string;
    taskId: string;
    dramaId?: string;
    dramaTitle: string;
    dramaPackage?: DramaPackageMeta;
    uploadQueue: RenderJobQueue;
    uploadCtx: MixUploadContext;
    onWallTime: (sec: number) => void;
    onRenderDone?: () => void;
    uploadEnabled: boolean;
    totalOutputs?: number;
  }): Promise<boolean> {
    const rendered = await this.renderMixPlan(input);
    if (!rendered) return false;
    if (input.uploadEnabled) {
      this.scheduleMixUpload(input.uploadQueue, input.uploadCtx, rendered);
    } else {
      this.registerLocalMixOutput(input.uploadCtx, rendered);
    }
    input.onRenderDone?.();
    return true;
  }

  private registerLocalMixOutput(uploadCtx: MixUploadContext, rendered: MixPlanRenderResult): void {
    const outputUrl = formatLocalOutputUrl(rendered.outputPath);
    uploadCtx.mixRenders.push(this.buildMixRenderRecord(rendered, outputUrl, false));
    console.log(`  local only (upload skipped): ${rendered.outputPath}`);
  }

  private scheduleMixUpload(
    uploadQueue: RenderJobQueue,
    uploadCtx: MixUploadContext,
    rendered: MixPlanRenderResult,
  ): void {
    // 上传成功后直接删除本地临时成片
    const job = uploadQueue.enqueue(async () => {
      const uploaded = await uploadOutputVideoAndDelete({
        apiBase: this.options.apiBase,
        headers: this.client.jsonHeaders(),
        taskId: uploadCtx.taskId,
        outputPath: rendered.outputPath,
        filename: rendered.outputName,
        config: uploadCtx.config,
        folderSegment: uploadCtx.dramaTitle,
        ffmpegPath: this.options.ffmpegPath ?? "ffmpeg",
        ffprobePath: this.options.ffprobePath ?? "ffprobe",
        keepLocalAfterUpload: false,
      });
      // 混剪成片上传后本地已删除，后续从 TOS URL 下载
      rendered.outputPath = uploaded.localPath;
      uploadCtx.mixRenders.push(this.buildMixRenderRecord(rendered, uploaded.url, true));
      console.log(`  uploaded: ${uploaded.url} (local removed)`);
    });
    uploadCtx.uploadJobs.push(job);
  }

  /** @deprecated use renderAndScheduleMixOutput */
  private async renderAndScheduleMixUpload(input: {
    plan: ClipPlan;
    round: number;
    outputIndex: number;
    batchOutputSeq: number;
    mergedSegments: AsrSegment[];
    sourceVideos: Record<string, string>;
    config: EffectiveConfig;
    workspace: string;
    taskId: string;
    dramaTitle: string;
    dramaPackage?: DramaPackageMeta;
    uploadQueue: RenderJobQueue;
    uploadCtx: MixUploadContext;
    onWallTime: (sec: number) => void;
    totalOutputs?: number;
  }): Promise<boolean> {
    return this.renderAndScheduleMixOutput({ ...input, uploadEnabled: true });
  }

  private async renderMixPlan(input: {
    plan: ClipPlan;
    round: number;
    outputIndex: number;
    batchOutputSeq: number;
    mergedSegments: AsrSegment[];
    sourceVideos: Record<string, string>;
    config: EffectiveConfig;
    workspace: string;
    onWallTime: (sec: number) => void;
    taskId: string;
    dramaId?: string;
    dramaTitle: string;
    dramaPackage?: DramaPackageMeta;
    totalOutputs?: number;
  }): Promise<MixPlanRenderResult | null> {
    const softDuration = input.config.llm?.durationPolicy !== "strict";
    const workingPlan = applyEditFormToPlan(input.plan, input.mergedSegments);
    const { plan: blockExpanded, repairs: blockRepairs } = expandClipBlockRanges(
      workingPlan,
      input.mergedSegments,
    );
    const { plan: bounded, repairs: boundaryRepairs, warnings } = finalizeSkillsMechanicalBoundaries(
      blockExpanded,
      input.mergedSegments,
    );
    let plan = annotatePlanDurationMeta(bounded, input.mergedSegments);
    const repairs = [...blockRepairs, ...boundaryRepairs];
    if (warnings.length) {
      console.log(`  skills 合规提示: ${warnings.join("; ")}`);
    }
    plan.durationStatus = annotatePlanDurationMeta(plan, input.mergedSegments).durationStatus;
    if (repairs.length) {
      console.log(`  plan 后处理: ${repairs.join("; ")}`);
    }
    if (plan.clips.length < 2) return null;

    const gapWarnings = contiguityWarnings(plan, input.mergedSegments);
    if (gapWarnings.length) {
      console.log(`  plan 连贯性警告: ${gapWarnings.join("; ")}`);
    }

    if (plan.editForm) {
      console.log(
        `  plan: editForm=${plan.editForm} target=${plan.targetDurationLabel ?? "-"} durationStatus=${plan.durationStatus ?? "-"}`,
      );
    }

    console.log(`  渲染 plan clips: ${plan.clips.map((c) => c.segmentId).join(" → ")}`);
    const episodeSourceDurationMs = await probeEpisodeSourceDurationsMs(
      input.sourceVideos,
      this.options.ffprobePath,
    );
    const { clips: renderClips, repairs: renderPrepRepairs, durationSec: renderDurationSec } =
      prepareRenderClips(plan, input.mergedSegments, { episodeSourceDurationMs });
    console.log(`  ASR 估算成片时长: ${renderDurationSec}s`);

    // 不再按 3min/10min 槽位下限硬跳过（如 479s vs 480s）；时长由 skills 评分软约束
    if (!softDuration && renderDurationSec < MIN_PLAN_DURATION_SEC) {
      console.warn(
        `  成片时长 ${renderDurationSec}s 不足最短 ${MIN_PLAN_DURATION_SEC}s，跳过`,
      );
      return null;
    }
    if (softDuration && plan.durationStatus === "under_preferred") {
      console.log(
        `  时长偏短（${renderDurationSec}s，目标 ${plan.targetDurationLabel ?? plan.targetDurationSec ?? "?"}），仍渲染`,
      );
    }

    // skills 不合格（过短 / 隔集 / 稀疏单段等）禁止成片
    const skillsQuality =
      plan.skillsQuality ??
      evaluateSkillsPlanQuality(plan, input.mergedSegments, {
        scoringClips: plan.llmSourceClips?.length ? plan.llmSourceClips : undefined,
      });
    if (!isSkillsPlanAcceptable(skillsQuality)) {
      console.warn(
        `  skills 不合格 (${skillsQuality.grade}/${skillsQuality.score})，跳过: ${skillsQuality.issues.slice(0, 4).join("; ")}`,
      );
      return null;
    }

    if (renderPrepRepairs.length) {
      console.log(`  切条去重: ${renderPrepRepairs.join("; ")}`);
    }
    console.log(
      `  实际切条 (${renderClips.length} 刀): ${renderClips.map((c) => `${c.segmentId}[${c.startMs}-${c.endMs}ms]`).join(" | ")}`,
    );
    if (renderClips.length < 1) return null;

    const validation = validateClipPlan(plan, input.mergedSegments, input.config.render);
    if (validation.warnings.length) {
      console.log(`  plan warnings: ${validation.warnings.join("; ")}`);
    }
    if (!validation.valid) {
      const fatal = validation.errors.filter((e) => !/exceeds max|duration/i.test(e));
      if (fatal.length) {
        console.warn(`  校验失败: ${fatal.join("; ")}`);
        return null;
      }
      console.log(`  plan 时长超限（仍渲染）: ${validation.errors.join("; ")}`);
    }

      const uploadEnabled = shouldUploadAfterRender(input.config);
      console.log(
        `[upload] 混剪上传开关: ${uploadEnabled}, uploadAfterRender=${input.config.render?.limits?.uploadAfterRender}, tosEnabled=${input.config.render?.storage?.tos?.enabled}`,
      );
      const outputDir = uploadEnabled
        ? input.workspace
        : await ensureTaskLocalOutputDir(input.config, input.taskId);
    const outputName = await allocateAutoclipOutputName(outputDir, {
      dramaTitle: input.dramaTitle,
      batch: resolveClipBatchNo(input.round),
      outputSeqInBatch: input.batchOutputSeq,
    });
    const outputPath = join(outputDir, outputName);
    const renderer = createTaskRenderer(
      this.options,
      join(input.workspace, "ffmpeg", `r${input.round}-p${input.outputIndex}`),
      resolveActiveResourceLoad(input.config.services?.resourcePolicy),
    );

    const renderResult = await renderer.render({
      sourceVideos: input.sourceVideos,
      plan,
      segments: input.mergedSegments,
      config: input.config,
      outputPath,
      renderClips,
      episodeSourceDurationMs,
      dramaTitle: input.dramaTitle,
      outputIndex: input.outputIndex,
      totalOutputs: input.totalOutputs,
    });
    input.onWallTime(renderResult.wallTimeSec);
    console.log(`  渲染完成，本地成片: ${outputPath}`);

    // 入库时长用 ffprobe 真实成片秒数，不用 ASR 预计
    const videoInfo = renderResult.videoInfo ?? {
      durationSec: Math.max(1, Math.round(renderDurationSec)),
    };
    const durationSec = videoInfo.durationSec ?? Math.max(1, Math.round(renderDurationSec));
    console.log(
      `  成片真实时长: ${durationSec}s（ASR 估算 ${renderDurationSec}s）`,
    );

    return {
      outputPath,
      outputName,
      round: input.round,
      outputIndex: input.outputIndex,
      planSeqInRound: input.batchOutputSeq,
      plan,
      strategy: plan.strategy,
      durationTier: plan.durationTier,
      narrativeLine: plan.narrativeLine,
      durationSec,
      videoInfo,
      fileSizeBytes: renderResult.fileSizeBytes,
    };
  }

  private async resolveEpisodeSources(
    episodes: DramaEpisodeRecord[],
    workspace: string,
    localMap?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    for (const ep of episodes) {
      if (localMap?.[ep.episodeId]) {
        sources[ep.episodeId] = localMap[ep.episodeId]!;
        continue;
      }
      sources[ep.episodeId] = await resolveSourceVideo(ep.sourceUrl, join(workspace, ep.episodeId));
    }
    return sources;
  }

  private async transcribe(
    audioPath: string,
    config: EffectiveConfig,
    mockAsrFile?: string,
  ): Promise<{ rawSegments: RawAsrSegment[]; durationMs: number }> {
    if (mockAsrFile) {
      const content = await readFile(mockAsrFile, "utf-8");
      const rawSegments = JSON.parse(content) as RawAsrSegment[];
      return {
        rawSegments,
        durationMs: rawSegments.at(-1)?.endMs ?? 0,
      };
    }

    if (!this.sidecar) {
      throw new Error(
        "FunASR sidecar not started; use `clip-agent run` daemon or pass --mock-asr for development",
      );
    }

    return this.sidecar.transcribe(audioPath, config);
  }

  private buildTaskTiming(startedAtMs: number): TaskPipelineTiming {
    const totalWallTimeSec = (Date.now() - startedAtMs) / 1000;
    return {
      processingStartedAt: new Date(startedAtMs).toISOString(),
      totalWallTimeSec: Math.round(totalWallTimeSec * 10) / 10,
    };
  }

  private logPipelineComplete(taskId: string, timing: TaskPipelineTiming, kind: string): void {
    console.log(
      `[clip-agent] 任务 ${taskId} 全流程耗时（识别→剪辑完成）: ${formatDurationSec(timing.totalWallTimeSec)} (${timing.totalWallTimeSec}s) [${kind}]`,
    );
  }

  private async pruneTaskWorkspace(workspace: string): Promise<void> {
    const { removed } = await removeTaskWorkspace(workspace);
    if (removed) {
      console.log(`workspace removed: ${workspace}`);
    }
  }

  private async pruneTaskLocalOutputs(taskId: string, config: EffectiveConfig): Promise<void> {
    const localDir = resolveTaskLocalOutputDir(config, taskId);
    try {
      await rm(localDir, { recursive: true, force: true });
      console.log(`local outputs removed: ${localDir}`);
    } catch {
      // 目录可能不存在或已被清理，忽略
    }
  }
}
