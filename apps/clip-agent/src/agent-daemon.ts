import {
  isAgentVersionNewer,
  resolveAgentServices,
  type AgentServicesConfig,
  type EffectiveConfig,
} from "@clip/sdk";
import { ensureAuthenticated } from "./auto-register.js";
import { maybeApplyAgentUpdate } from "./agent-updater.js";
import { readEffectiveAgentVersion } from "./effective-version.js";
import {
  clearFailedUpdate,
  recordFailedUpdate,
  shouldSkipUpdateAttempt,
} from "./failed-update-state.js";
import { ensureFunasrVenv } from "./ensure-funasr-venv.js";
import { FunasrSidecar } from "./funasr-sidecar.js";
import { ensureModels } from "./model-downloader.js";
import { join } from "node:path";
import { resolveAgentPaths, resolveFunasrLaunch } from "./paths.js";
import { ensureBundledFfmpegOnWindows, logAgentStartupEnvironment } from "./startup-env.js";
import { checkGpu4060 } from "./gpu-check.js";
import { AgentPipeline, ClipApiClient, type AgentClientOptions } from "./pipeline.js";
import { removeTaskWorkspace } from "./workspace-cleaner.js";
import { isPaused } from "./control.js";
import { waitForApiReachable } from "./api-connectivity.js";
import { acquireAgentLock } from "./agent-lock.js";
import { finishTaskProgress, readTaskProgress, startTaskProgress } from "./task-progress.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface AgentDaemonOptions extends AgentClientOptions {
  pollIntervalMs?: number;
  installDir?: string;
  funasrServerPath?: string;
  funasrModelsDir?: string;
  mockAsrFile?: string;
  sidecarHost?: string;
  sidecarPort?: number;
}

export class AgentDaemon {
  private running = false;
  private taskInProgress = false;
  private updateInProgress = false;
  private cachedConfig: EffectiveConfig | null = null;
  private agentEnabled = true;
  private sidecar: FunasrSidecar | null = null;
  private lastHeartbeat = Date.now();

  /** 同一目标版本只提示一次，避免心跳刷屏 */
  private lastUpdateNoticeVersion = "";

  constructor(
    private readonly client: ClipApiClient,
    private readonly pipeline: AgentPipeline,
    private readonly options: AgentDaemonOptions,
  ) {}

  async start(): Promise<void> {
    try {
      await acquireAgentLock();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[clip-agent] ${message}`);
      return;
    }
    this.running = true;
    let paths = resolveAgentPaths({
      installDir: this.options.installDir,
      ffmpegPath: this.options.ffmpegPath,
      funasrServerPath: this.options.funasrServerPath,
      funasrModelsDir: this.options.funasrModelsDir,
    });

    paths = await ensureBundledFfmpegOnWindows(paths);
    this.pipeline.setMediaPaths({ ffmpegPath: paths.ffmpegPath, ffprobePath: paths.ffprobePath, fontsDir: paths.fontsDir, stickersDir: paths.stickersDir });
    const gpu = await checkGpu4060();
    await logAgentStartupEnvironment(paths, gpu);

    await waitForApiReachable(
      async () => {
        const creds = await ensureAuthenticated(this.options.apiBase, async (nextCreds) => {
          this.client.updateCredentials(nextCreds);
          this.cachedConfig = await this.client.fetchConfig();
        });
        this.client.updateCredentials(creds);
        if (!this.cachedConfig) {
          this.cachedConfig = await this.client.fetchConfig();
        }
      },
      this.options.apiBase,
      { shouldContinue: () => this.running, intervalMs: 5000 },
    );

    await this.ensureConfigLoaded();
    await this.syncAgentEnabled(this.cachedConfig!.services);
    const effectiveVersion = await readEffectiveAgentVersion(this.options.installDir);
    console.log(
      `agent online v${effectiveVersion}, configVersion=${this.cachedConfig!.configVersion}, agentEnabled=${this.agentEnabled}`,
    );

    if (!this.options.mockAsrFile) {
      await ensureModels(this.options.apiBase, this.client.headers(), paths.funasrModelsDir);
      await this.ensureSidecar();
    }

    const startupBeat = await this.client.heartbeat();
    await this.syncAgentEnabled(startupBeat.services);
    await this.maybeApplyUpdateFromHeartbeat(startupBeat);

    while (this.running) {
      try {
        await this.maybeHeartbeat();

        if (!this.agentEnabled || await isPaused()) {
          await sleep(1000);
          continue;
        }

        const claim = await this.client.claimTask();
        if (!claim.task) {
          await sleep(this.options.pollIntervalMs ?? 5000);
          continue;
        }

        console.log(
          `[clip-agent] claimed task=${claim.task.taskId} kind=${claim.task.taskKind ?? "single"} ` +
            `status=${claim.task.status} source=${claim.task.sourceUrl}`,
        );

        if (claim.task.taskKind === "drama_package") {
          console.log(
            `[package] claimed taskId=${claim.task.taskId} downloadUrl=${claim.task.sourceUrl}`,
          );
        }

        const config = await this.resolveTaskConfig(
          claim.task.configVersion,
          claim.task.asrRuleSetId,
          claim.effectiveConfig,
        );
        await this.syncAgentEnabled(config.services);
        if (!this.agentEnabled) {
          // 已认领但本机被关掉：必须释放回 pending，否则任务会卡在 claimed/processing（剧包还显示 downloading）
          try {
            await this.client.retryTask(claim.task.taskId);
            console.warn(
              `[clip-agent] agentEnabled=false，已释放认领 task=${claim.task.taskId}`,
            );
          } catch (releaseErr) {
            console.error(
              `[clip-agent] 释放认领失败 task=${claim.task.taskId}:`,
              releaseErr instanceof Error ? releaseErr.message : releaseErr,
            );
          }
          await sleep(1000);
          continue;
        }

        this.taskInProgress = true;
        try {
          // 任务执行期间并行保活心跳，防止服务端判定离线
          const heartbeatLoop = this.startHeartbeatKeepAlive();
          try {
            await this.pipeline.processClaimedTask(claim.task, config, {
              mockAsrFile: this.options.mockAsrFile,
            });
          } finally {
            heartbeatLoop.stop();
          }

          const taskDir = join(paths.workspaceDir, `task-${claim.task.taskId}`);
          const removed = await removeTaskWorkspace(taskDir);
          if (removed.removed) {
            console.log(`workspace cleanup: removed ${taskDir}`);
          }
        } finally {
          this.taskInProgress = false;
          const progress = await readTaskProgress();
          // 各 task handler 自行 finish；仅异常中断时兜底，避免覆盖「批次任务已完成」等终态
          if (
            progress.active &&
            claim.task.taskKind !== "drama_package" &&
            progress.kind !== "drama_package"
          ) {
            await finishTaskProgress({ phase: "任务已结束" });
          }
        }
      } catch (err) {
        console.error("daemon loop error:", err instanceof Error ? err.message : err);
        await sleep(this.options.pollIntervalMs ?? 5000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopSidecar();
  }

  private async maybeHeartbeat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeat = now;

    const beat = await this.client.heartbeat();
    await this.syncAgentEnabled(beat.services);
    if (
      this.cachedConfig &&
      (beat.configVersion !== this.cachedConfig.configVersion ||
        beat.ruleSetVersion !== this.cachedConfig.asr?.rules?.ruleSetVersion)
    ) {
      this.cachedConfig = await this.client.fetchConfig();
      await this.syncAgentEnabled(this.cachedConfig.services);
      console.log(`config refreshed via heartbeat -> ${this.cachedConfig.configVersion}`);
    }
    await this.maybeApplyUpdateFromHeartbeat(beat);
  }

  private async maybeApplyUpdateFromHeartbeat(beat: Awaited<ReturnType<ClipApiClient["heartbeat"]>>): Promise<void> {
    if (!beat.agentUpdate?.available || this.updateInProgress) return;
    const version = beat.agentUpdate.version;
    if (!version) return;

    // 本地已是目标版或更高：视为更新已完成，清失败退避，后续心跳不再执行
    const currentVersion = await readEffectiveAgentVersion(this.options.installDir);
    if (!isAgentVersionNewer(version, currentVersion)) {
      if (this.lastUpdateNoticeVersion !== `done:${version}`) {
        this.lastUpdateNoticeVersion = `done:${version}`;
        console.log(
          `[clip-agent] 已是 v${currentVersion}，跳过目标 v${version}（更新已完成，不再执行）`,
        );
      }
      await clearFailedUpdate();
      return;
    }

    if (await shouldSkipUpdateAttempt(version, beat.agentUpdate.mandatory)) {
      // 失败退避期内静默跳过，避免每分钟刷 update available
      return;
    }
    if (this.taskInProgress) {
      if (this.lastUpdateNoticeVersion !== `pending:${version}`) {
        this.lastUpdateNoticeVersion = `pending:${version}`;
        console.log(`[clip-agent] update pending v${version} (task in progress)`);
      }
      return;
    }

    if (this.lastUpdateNoticeVersion !== `try:${version}`) {
      this.lastUpdateNoticeVersion = `try:${version}`;
      console.log(`update available: ${version}（当前 ${currentVersion}，开始热更新）`);
    }

    this.updateInProgress = true;
    try {
      const applied = await maybeApplyAgentUpdate({
        update: beat.agentUpdate,
        installDir: this.options.installDir,
        apiBase: this.options.apiBase,
        authHeaders: this.client.headers(),
      });
      if (applied) {
        await clearFailedUpdate();
        this.lastUpdateNoticeVersion = `done:${version}`;
        console.log(`[clip-agent] 热更新 v${version} 已完成，停止本进程等待重启`);
        this.running = false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[clip-agent] auto-update failed:", message);
      await recordFailedUpdate(version);
      this.lastUpdateNoticeVersion = `fail:${version}`;
    } finally {
      this.updateInProgress = false;
    }
  }

  /** 任务执行期间每 30 秒发一次心跳，防止服务端判定离线 */
  private startHeartbeatKeepAlive(): { stop: () => void } {
    let active = true;
    const run = async () => {
      while (active) {
        await sleep(30_000);
        if (!active) break;
        try {
          const beat = await this.client.heartbeat();
          await this.syncAgentEnabled(beat.services);
        } catch {
          // 心跳失败不中断任务
        }
      }
    };
    void run();
    return { stop: () => { active = false; } };
  }

  private async syncAgentEnabled(services?: AgentServicesConfig): Promise<void> {
    // heartbeat 已带合并后的 services（含 resourcePolicy），直接缓存供任务使用
    const resolved = resolveAgentServices(undefined, services);
    const prev = this.agentEnabled;
    this.agentEnabled = resolved.agentEnabled;
    if (this.cachedConfig) {
      this.cachedConfig.services = resolved;
    }

    if (!resolved.agentEnabled && prev) {
      console.log("agent disabled by server — idle, heartbeat only");
    } else if (resolved.agentEnabled && !prev) {
      console.log("agent enabled by server — resuming task polling");
    }
  }

  private async ensureConfigLoaded(): Promise<EffectiveConfig> {
    if (!this.cachedConfig?.asr?.runtime) {
      this.cachedConfig = await this.client.fetchConfig();
    }
    return this.cachedConfig;
  }

  private resolveAsrDevice(): string {
    return this.cachedConfig?.asr?.runtime?.device ?? "cuda:0";
  }

  private async ensureSidecar(): Promise<void> {
    if (this.options.mockAsrFile) {
      console.log("mock ASR enabled, skipping funasr-server spawn");
      return;
    }

    const paths = resolveAgentPaths({
      installDir: this.options.installDir,
      ffmpegPath: this.options.ffmpegPath,
      funasrServerPath: this.options.funasrServerPath,
      funasrModelsDir: this.options.funasrModelsDir,
    });

    await ensureFunasrVenv(paths.repoRoot);

    await this.ensureConfigLoaded();

    await startTaskProgress({
      title: "drama-clip",
      kind: "startup",
      phaseCode: "asr",
      phase: "启动 ASR 引擎（首次加载模型约 5–10 分钟）…",
    });

    const launch = resolveFunasrLaunch(
      paths,
      this.options.sidecarHost ?? "127.0.0.1",
      this.options.sidecarPort ?? 17860,
      this.resolveAsrDevice(),
    );

    this.sidecar = new FunasrSidecar({
      host: this.options.sidecarHost ?? "127.0.0.1",
      port: this.options.sidecarPort ?? 17860,
      launch,
    });
    console.log(`starting funasr-server: ${launch.command} ${launch.args.join(" ")}`);
    try {
      await this.sidecar.start();
    } finally {
      const progress = await readTaskProgress();
      if (progress.kind === "startup" && !this.taskInProgress) {
        await finishTaskProgress({ phase: "服务就绪，等待任务" });
      }
    }
    this.pipeline.setSidecar(this.sidecar);
  }

  private async stopSidecar(): Promise<void> {
    if (!this.sidecar) return;
    await this.sidecar.stop();
    this.sidecar = null;
    this.pipeline.setSidecar(null);
    console.log("funasr-server stopped by server service control");
  }

  private async resolveTaskConfig(
    taskConfigVersion: string | undefined,
    ruleSetId: string | undefined,
    claimConfig?: EffectiveConfig,
  ): Promise<EffectiveConfig> {
    if (claimConfig) {
      this.cachedConfig = claimConfig;
      return claimConfig;
    }

    const needsRefresh =
      !this.cachedConfig ||
      (taskConfigVersion && taskConfigVersion !== this.cachedConfig.configVersion) ||
      (ruleSetId && ruleSetId !== this.cachedConfig.asr?.rules?.ruleSetId);

    if (needsRefresh) {
      this.cachedConfig = await this.client.fetchConfig(ruleSetId);
      console.log(`refreshed config -> ${this.cachedConfig.configVersion}`);
    }

    return this.cachedConfig!;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
