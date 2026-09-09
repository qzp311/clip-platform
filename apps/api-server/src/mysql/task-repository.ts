import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type {
  ClipPlan,
  ClipPlanBatch,
  ClipTask,
  ClipTaskKind,
  DramaPackageMeta,
  MixRenderRecord,
} from "@clip/sdk";
import { sqlLimitOffset } from "../pagination.js";
import { toIso, toMysqlDate } from "./json.js";

/** 看板轻量任务行：仅看板展示所需字段 */
export interface BoardTaskLite {
  taskId: string;
  taskKind: ClipTaskKind;
  status: ClipTask["status"];
  dramaId: string;
  episodeNo?: number;
  phase?: DramaPackageMeta["phase"];
  claimedBy?: string;
  claimedAt?: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  outputUrl?: string;
}

export interface TaskRecord {
  taskId: string;
  templateId: string;
  asrRuleSetId?: string;
  configVersion?: string;
  sourceUrl: string;
  dramaId?: string;
  dramaMeta?: Record<string, unknown>;
  taskKind?: ClipTaskKind;
  episodeNo?: number;
  episodeId?: string;
  mixEpisodeIds?: string[];
  parentPackageTaskId?: string;
  dramaPackage?: DramaPackageMeta;
  status: ClipTask["status"];
  claimedBy?: string;
  claimedAt?: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  totalWallTimeSec?: number;
  plan?: ClipPlan;
  planBatches?: ClipPlanBatch[];
  outputUrl?: string;
  outputUrls?: string[];
  mixRenders?: MixRenderRecord[];
  failMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  taskId?: string;
  templateId?: string;
  asrRuleSetId?: string;
  configVersion?: string;
  sourceUrl: string;
  dramaId?: string;
  dramaMeta?: Record<string, unknown>;
  taskKind?: ClipTaskKind;
  episodeNo?: number;
  episodeId?: string;
  mixEpisodeIds?: string[];
  parentPackageTaskId?: string;
  dramaPackage?: DramaPackageMeta;
  status?: ClipTask["status"];
  claimedBy?: string;
  claimedAt?: string;
}

/** @deprecated use TaskRecord + save() */
export interface TaskRowInput {
  taskId: string;
  templateId: string;
  taskKind?: ClipTaskKind;
  status: ClipTask["status"];
  sourceUrl: string;
  dramaId?: string;
  dramaMeta?: Record<string, unknown>;
  episodeId?: string;
  episodeNo?: number;
  asrRuleSetId?: string;
  configVersion?: string;
  claimedBy?: string;
  claimedAt?: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  totalWallTimeSec?: number;
  outputUrl?: string;
  failMessage?: string;
  plan?: ClipPlan;
  planBatches?: ClipPlanBatch[];
  createdAt: string;
  updatedAt: string;
}

interface TaskRow extends RowDataPacket {
  task_id: string;
  template_id: string;
  task_kind: ClipTaskKind;
  status: ClipTask["status"];
  source_url: string;
  drama_id: string | null;
  drama_meta_json: unknown;
  drama_package_json: unknown;
  episode_id: string | null;
  episode_no: number | null;
  parent_package_task_id: string | null;
  asr_rule_set_id: string | null;
  config_version: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  processing_started_at: Date | null;
  processing_completed_at: Date | null;
  total_wall_time_sec: number | null;
  output_url: string | null;
  fail_message: string | null;
  plan_json: unknown;
  plan_batches_json: unknown;
  created_at: Date;
  updated_at: Date;
}

const TASK_SELECT = `
  SELECT task_id, template_id, task_kind, status, source_url, drama_id, drama_meta_json,
         drama_package_json, episode_id, episode_no, parent_package_task_id,
         asr_rule_set_id, config_version, claimed_by, claimed_at,
         processing_started_at, processing_completed_at, total_wall_time_sec,
         output_url, fail_message, plan_json, plan_batches_json, created_at, updated_at
  FROM clip_task`;

/** 列表页查询：不含 plan_json / plan_batches_json，减轻 IO */
const TASK_LIST_SELECT = `
  SELECT task_id, template_id, task_kind, status, source_url, drama_id, drama_meta_json,
         drama_package_json, episode_id, episode_no, parent_package_task_id,
         asr_rule_set_id, config_version, claimed_by, claimed_at,
         processing_started_at, processing_completed_at, total_wall_time_sec,
         output_url, fail_message, created_at, updated_at
  FROM clip_task`;

function buildTaskListWhere(filter?: {
  status?: ClipTask["status"];
  taskKind?: ClipTaskKind;
  dramaId?: string;
  claimedBy?: string;
  updatedDatePrefix?: string;
}): { where: string; params: (string | Date)[] } {
  const clauses: string[] = [];
  const params: (string | Date)[] = [];
  if (filter?.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.taskKind) {
    clauses.push("task_kind = ?");
    params.push(filter.taskKind);
  }
  if (filter?.dramaId) {
    clauses.push("drama_id = ?");
    params.push(filter.dramaId);
  }
  if (filter?.claimedBy) {
    clauses.push("claimed_by = ?");
    params.push(filter.claimedBy);
  }
  if (filter?.updatedDatePrefix) {
    clauses.push("updated_at >= ? AND updated_at < ?");
    params.push(`${filter.updatedDatePrefix}T00:00:00.000Z`);
    const next = new Date(`${filter.updatedDatePrefix}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    params.push(next.toISOString());
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

function parseJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

function rowToTask(
  row: TaskRow,
  extras?: {
    mixEpisodeIds?: string[];
    outputUrls?: string[];
    mixRenders?: MixRenderRecord[];
  },
): TaskRecord {
  const outputUrls = extras?.outputUrls;
  const mixRenders = extras?.mixRenders;
  return {
    taskId: row.task_id,
    templateId: row.template_id,
    taskKind: row.task_kind,
    status: row.status,
    sourceUrl: row.source_url,
    dramaId: row.drama_id ?? undefined,
    dramaMeta: parseJson<Record<string, unknown>>(row.drama_meta_json),
    dramaPackage: parseJson<DramaPackageMeta>(row.drama_package_json),
    episodeId: row.episode_id ?? undefined,
    episodeNo: row.episode_no ?? undefined,
    parentPackageTaskId: row.parent_package_task_id ?? undefined,
    mixEpisodeIds: extras?.mixEpisodeIds,
    asrRuleSetId: row.asr_rule_set_id ?? undefined,
    configVersion: row.config_version ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: toIso(row.claimed_at),
    processingStartedAt: toIso(row.processing_started_at),
    processingCompletedAt: toIso(row.processing_completed_at),
    totalWallTimeSec: row.total_wall_time_sec ?? undefined,
    outputUrl: row.output_url ?? outputUrls?.[0] ?? undefined,
    outputUrls,
    mixRenders,
    failMessage: row.fail_message ?? undefined,
    plan: parseJson<ClipPlan>(row.plan_json),
    planBatches: parseJson<ClipPlanBatch[]>(row.plan_batches_json),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

export class TaskMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async findById(taskId: string): Promise<TaskRecord | null> {
    const [rows] = await this.pool.execute<TaskRow[]>(`${TASK_SELECT} WHERE task_id = ?`, [taskId]);
    const row = rows[0];
    if (!row) return null;
    const extras = await this.loadTaskExtras([taskId]);
    return rowToTask(row, extras.get(taskId));
  }

  /** 批量查询 drama_package 任务的 source_url，用于重复剧自动建任务时复用 zip 地址 */
  async findDramaPackageSourceUrlsByIds(taskIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await this.pool.execute<TaskRow[]>(
      `${TASK_LIST_SELECT}
       WHERE task_id IN (${placeholders})
         AND task_kind = 'drama_package'
         AND source_url LIKE 'http%://%zip%'`,
      ids,
    );
    const result = new Map<string, string>();
    for (const row of rows) {
      const url = row.source_url?.trim();
      if (url && /^https?:\/\//i.test(url) && /\.zip/i.test(url)) {
        result.set(row.task_id, url);
      }
    }
    return result;
  }

  /** 查找含 planBatches 的最新混剪任务（剧包详情页质量面板用） */
  async findLatestMixWithPlanBatches(
    dramaId: string,
    parentPackageTaskId?: string,
  ): Promise<TaskRecord | null> {
    if (parentPackageTaskId) {
      const [byParent] = await this.pool.execute<TaskRow[]>(
        `${TASK_SELECT}
         WHERE task_kind = 'drama_mix'
           AND drama_id = ?
           AND parent_package_task_id = ?
           AND plan_batches_json IS NOT NULL
           AND JSON_LENGTH(plan_batches_json) > 0
         ORDER BY updated_at DESC
         LIMIT 1`,
        [dramaId, parentPackageTaskId],
      );
      if (byParent[0]) {
        const extras = await this.loadTaskExtras([byParent[0].task_id]);
        return rowToTask(byParent[0], extras.get(byParent[0].task_id));
      }
    }

    const [rows] = await this.pool.execute<TaskRow[]>(
      `${TASK_SELECT}
       WHERE task_kind = 'drama_mix'
         AND drama_id = ?
         AND plan_batches_json IS NOT NULL
         AND JSON_LENGTH(plan_batches_json) > 0
       ORDER BY updated_at DESC
       LIMIT 1`,
      [dramaId],
    );
    const row = rows[0];
    if (!row) return null;
    const extras = await this.loadTaskExtras([row.task_id]);
    return rowToTask(row, extras.get(row.task_id));
  }

  async list(filter?: {
    status?: ClipTask["status"];
    claimedBy?: string;
    updatedDatePrefix?: string;
    limit?: number;
  }): Promise<TaskRecord[]> {
    const { where, params } = buildTaskListWhere(filter);
    const limitClause = filter?.limit ? ` LIMIT ${Math.min(Math.max(filter.limit, 1), 500)}` : "";
    const [rows] = await this.pool.execute<TaskRow[]>(
      `${TASK_SELECT}${where} ORDER BY updated_at DESC${limitClause}`,
      params,
    );
    const extras = await this.loadTaskExtras(rows.map((r) => r.task_id));
    return rows.map((row) => rowToTask(row, extras.get(row.task_id)));
  }

  /**
   * 按剧聚合的任务看板数据：固定三条 SQL，无 N+1
   * 1) 按聚合状态过滤的剧分组总数（HAVING，与 2) 同条件）
   * 2) 分组分页：每剧取最近活动时间排序
   * 3) IN 批量取当前页各剧的任务行，内存做 kind/status 计数
   * aggStatus 是剧级汇总状态：failed=任一任务失败；completed=全部完成；running=其余
   */
  async listTaskBoard(filter: {
    aggStatus?: "running" | "completed" | "failed";
    claimedBy?: string;
    limit: number;
    offset: number;
  }): Promise<{
    groups: Array<{
      dramaId: string;
      taskCount: number;
      lastActiveAt: string;
      kindCounts: Record<string, number>;
      statusCounts: Record<string, number>;
      failMessage?: string;
    }>;
    total: number;
  }> {
    const { where, params } = buildTaskListWhere({ claimedBy: filter.claimedBy });
    // 聚合状态条件（HAVING 用）：按剧汇总失败数/完成数/总数
    const base = `FROM clip_task${where}${where ? " AND" : " WHERE"} drama_id IS NOT NULL`;
    const having =
      filter.aggStatus === "failed"
        ? "HAVING failed_cnt > 0"
        : filter.aggStatus === "completed"
          ? "HAVING failed_cnt = 0 AND total_cnt = done_cnt"
          : filter.aggStatus === "running"
            ? "HAVING failed_cnt = 0 AND total_cnt > done_cnt"
            : "";
    const groupSelect = `SELECT drama_id, MAX(updated_at) AS last_active_at,
              SUM(status = 'failed') AS failed_cnt,
              SUM(status = 'completed') AS done_cnt,
              COUNT(*) AS total_cnt
       ${base}
       GROUP BY drama_id
       ${having}`;
    // 1) 剧分组总数
    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM (${groupSelect}) t`,
      params,
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    // 2) 分组分页：每剧最近活动时间（LIMIT/OFFSET 必须 Inline，execute 预处理不支持占位符）
    const [groupRows] = await this.pool.execute<RowDataPacket[]>(
      `${groupSelect} ORDER BY last_active_at DESC${sqlLimitOffset(filter.limit, filter.offset)}`,
      params,
    );
    if (!groupRows.length) return { groups: [], total };
    // 3) IN 批量取当前页各剧的任务行（列表轻量列，不带 plan_json）
    const dramaIds = groupRows.map((r) => String(r.drama_id));
    const placeholders = dramaIds.map(() => "?").join(",");
    const [taskRows] = await this.pool.execute<TaskRow[]>(
      `${TASK_LIST_SELECT} WHERE drama_id IN (${placeholders})`,
      dramaIds,
    );
    // 内存分组组装：kind/status 计数 + 每剧最近失败信息
    const byDrama = new Map<string, TaskRow[]>();
    for (const row of taskRows) {
      const key = row.drama_id ?? "";
      const list = byDrama.get(key);
      if (list) list.push(row);
      else byDrama.set(key, [row]);
    }
    const groups = groupRows.map((g) => {
      const dramaId = String(g.drama_id);
      const tasks = byDrama.get(dramaId) ?? [];
      const kindCounts: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};
      let failMessage: string | undefined;
      let failAt = "";
      for (const t of tasks) {
        kindCounts[t.task_kind] = (kindCounts[t.task_kind] ?? 0) + 1;
        statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
        // dateStrings 模式下 updated_at 是 "YYYY-MM-DD HH:mm:ss" 字符串，直接字符串比较即可
        const tUpdatedAt = String(t.updated_at);
        if (t.status === "failed" && t.fail_message && tUpdatedAt > failAt) {
          failAt = tUpdatedAt;
          failMessage = t.fail_message;
      }
      }
      return {
        dramaId,
        taskCount: tasks.length,
        lastActiveAt: String(g.last_active_at),
        kindCounts,
        statusCounts,
        failMessage,
      };
    });
    return { groups, total };
  }

  /**
   * 看板用：IN 批量取指定剧的任务轻量行（列表轻量列 + drama_package_json 里的 phase）
   */
  async listTaskBoardTasks(dramaIds: string[]): Promise<BoardTaskLite[]> {
    if (!dramaIds.length) return [];
    const placeholders = dramaIds.map(() => "?").join(",");
    const [rows] = await this.pool.execute<TaskRow[]>(
      `${TASK_LIST_SELECT} WHERE drama_id IN (${placeholders})`,
      dramaIds,
    );
    return rows.map((r) => ({
      taskId: r.task_id,
      taskKind: r.task_kind,
      status: r.status,
      dramaId: r.drama_id ?? "",
      episodeNo: r.episode_no ?? undefined,
      phase: parseJson<DramaPackageMeta>(r.drama_package_json)?.phase,
      claimedBy: r.claimed_by ?? undefined,
      claimedAt: toIso(r.claimed_at),
      processingStartedAt: toIso(r.processing_started_at),
      processingCompletedAt: toIso(r.processing_completed_at),
      outputUrl: r.output_url ?? undefined,
    }));
  }

  async listPage(filter: {
    status?: ClipTask["status"];
    taskKind?: ClipTaskKind;
    dramaId?: string;
    claimedBy?: string;
    updatedDatePrefix?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: TaskRecord[]; total: number }> {
    const { where, params } = buildTaskListWhere(filter);
    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM clip_task${where}`,
      params,
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    const pageSql = `${TASK_LIST_SELECT}${where} ORDER BY updated_at DESC${sqlLimitOffset(filter.limit, filter.offset)}`;
    const [rows] = await this.pool.execute<TaskRow[]>(pageSql, params);
    const skipExtras = filter.taskKind === "drama_package";
    const extras = skipExtras
      ? new Map<string, { mixEpisodeIds?: string[]; outputUrls?: string[]; mixRenders?: MixRenderRecord[] }>()
      : await this.loadTaskExtras(rows.map((r) => r.task_id));
    return {
      rows: rows.map((row) => rowToTask(row, extras.get(row.task_id))),
      total,
    };
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const now = toIso(new Date())!;
    const task: TaskRecord = {
      taskId: input.taskId ?? `task-${randomUUID().slice(0, 8)}`,
      templateId: input.templateId ?? "vertical_hook_60s",
      asrRuleSetId: input.asrRuleSetId,
      configVersion: input.configVersion,
      sourceUrl: input.sourceUrl,
      dramaId: input.dramaId,
      dramaMeta: input.dramaMeta,
      taskKind: input.taskKind ?? "single",
      episodeNo: input.episodeNo,
      episodeId: input.episodeId,
      mixEpisodeIds: input.mixEpisodeIds,
      parentPackageTaskId: input.parentPackageTaskId,
      dramaPackage: input.dramaPackage,
      status: input.status ?? "pending",
      claimedBy: input.claimedBy,
      claimedAt: input.claimedAt ?? (input.claimedBy ? now : undefined),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(task);
    return task;
  }

  async save(task: TaskRecord): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.upsertRow(conn, task);
      if (task.taskKind === "drama_mix") {
        await this.replaceMixEpisodes(conn, task.taskId, task.mixEpisodeIds ?? []);
      }
      await this.replaceOutputUrls(conn, task.taskId, task.outputUrls ?? []);
      await this.replaceMixRenders(conn, task.taskId, task.mixRenders ?? []);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** @deprecated use save() */
  async upsert(task: TaskRowInput): Promise<void> {
    await this.save({
      taskId: task.taskId,
      templateId: task.templateId,
      taskKind: task.taskKind,
      status: task.status,
      sourceUrl: task.sourceUrl,
      dramaId: task.dramaId,
      dramaMeta: task.dramaMeta,
      episodeId: task.episodeId,
      episodeNo: task.episodeNo,
      asrRuleSetId: task.asrRuleSetId,
      configVersion: task.configVersion,
      claimedBy: task.claimedBy,
      claimedAt: task.claimedAt,
      processingStartedAt: task.processingStartedAt,
      processingCompletedAt: task.processingCompletedAt,
      totalWallTimeSec: task.totalWallTimeSec,
      outputUrl: task.outputUrl,
      outputUrls: task.outputUrl ? [task.outputUrl] : undefined,
      failMessage: task.failMessage,
      plan: task.plan,
      planBatches: task.planBatches,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  async releaseStaleClaims(timeoutMs: number): Promise<number> {
    const staleBefore = new Date(Date.now() - timeoutMs);
    // 过期认领回退 pending 时，同步清掉 drama_package.phase=downloading，
    // 否则管理台会一直显示「下载中」，但实际上已无人执行。
    const [result] = await this.pool.execute(
      `UPDATE clip_task
       SET status = 'pending',
           claimed_by = NULL,
           claimed_at = NULL,
           drama_package_json = CASE
             WHEN task_kind = 'drama_package' AND drama_package_json IS NOT NULL
             THEN JSON_SET(drama_package_json, '$.phase', 'pending')
             ELSE drama_package_json
           END,
           updated_at = NOW(3)
       WHERE status IN ('claimed', 'processing')
         AND parent_package_task_id IS NULL
         AND claimed_at IS NOT NULL
         AND claimed_at < ?`,
      [staleBefore],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  async countTopLevelPending(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM clip_task
       WHERE status = 'pending' AND parent_package_task_id IS NULL`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  /** 领取复刻任务：允许 parent_package_task_id 非空，直接在 task 上写 claimed */
  async claimRemixReplica(taskId: string, deviceId: string): Promise<number> {
    const [result] = await this.pool.execute(
      `UPDATE clip_task
       SET status = 'claimed', claimed_by = ?, claimed_at = NOW(3), updated_at = NOW(3)
       WHERE task_id = ? AND status = 'pending' AND task_kind = 'remix_replica'`,
      [deviceId, taskId],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  async claim(deviceId: string, taskId?: string, taskQueue: "all" | "mix" | "replica" = "all"): Promise<TaskRecord | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      if (taskId) {
        const [rows] = await conn.execute<TaskRow[]>(
          `${TASK_SELECT} WHERE task_id = ? AND status = 'pending' AND parent_package_task_id IS NULL FOR UPDATE`,
          [taskId],
        );
        if (!rows[0]) {
          await conn.commit();
          return null;
        }
        await this.applyClaim(conn, rows[0], deviceId);
        await conn.commit();
        return this.findById(taskId);
      }

      // 队列分工过滤：replica 只领复刻，mix 只领非复刻（混剪/剧包/ASR 等短剧剪辑链路），all 不过滤
      const queueFilter =
        taskQueue === "replica"
          ? "AND task_kind = 'remix_replica'"
          : taskQueue === "mix"
            ? "AND (task_kind IS NULL OR task_kind <> 'remix_replica')"
            : "";
      const [candidates] = await conn.execute<TaskRow[]>(
        `${TASK_SELECT}
         WHERE status = 'pending' AND parent_package_task_id IS NULL ${queueFilter}
         ORDER BY CASE task_kind WHEN 'drama_package' THEN 0 ELSE 1 END,
                  COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(drama_package_json, '$.priority')) AS UNSIGNED), 0) DESC,
                  created_at ASC
         LIMIT 1 FOR UPDATE`,
      );
      const row = candidates[0];
      if (!row) {
        await conn.commit();
        return null;
      }
      await this.applyClaim(conn, row, deviceId);
      await conn.commit();
      return this.findById(row.task_id);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async deleteByParentPackageTaskId(parentPackageTaskId: string): Promise<string[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT task_id FROM clip_task WHERE parent_package_task_id = ?",
      [parentPackageTaskId],
    );
    const taskIds = rows.map((r) => r.task_id as string);
    if (!taskIds.length) return [];

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const id of taskIds) {
        await this.deleteTaskArtifacts(conn, id);
      }
      await conn.execute("DELETE FROM clip_task WHERE parent_package_task_id = ?", [parentPackageTaskId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return taskIds;
  }

  async clearParentPackageTaskId(parentPackageTaskId: string): Promise<number> {
    const [result] = await this.pool.execute(
      `UPDATE clip_task SET parent_package_task_id = NULL, updated_at = NOW(3)
       WHERE parent_package_task_id = ? AND status = 'pending'`,
      [parentPackageTaskId],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  /** 父任务尚未完成时，把已领取的复刻任务恢复为 pending，等待下次领取 */
  async releaseRemixReplicaClaim(taskId: string): Promise<number> {
    const [result] = await this.pool.execute(
      `UPDATE clip_task
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW(3)
       WHERE task_id = ? AND task_kind = 'remix_replica' AND status = 'claimed'`,
      [taskId],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  /** 仅允许 pending 的剧包任务调整优先级，避免覆盖 Agent 已领取的任务。 */
  async setDramaPackagePriority(taskId: string, priority: boolean): Promise<TaskRecord | null> {
    const [result] = await this.pool.execute(
      `UPDATE clip_task
       SET drama_package_json = JSON_SET(
             COALESCE(drama_package_json, JSON_OBJECT()),
             '$.priority',
             CAST(? AS UNSIGNED)
           ),
           updated_at = NOW(3)
       WHERE task_id = ? AND task_kind = 'drama_package' AND status = 'pending'`,
      [priority ? 1 : 0, taskId],
    );
    if (Number((result as { affectedRows?: number }).affectedRows ?? 0) === 0) return null;
    return this.findById(taskId);
  }

  /** 级联删除单条任务及其子表数据；drama_package 会先删子任务再删自身 */
  async deleteTask(taskId: string): Promise<string[]> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1) 查任务类型， drama_package 需要先级联删除子任务
      const [rows] = await conn.execute<RowDataPacket[]>(
        "SELECT task_id, task_kind FROM clip_task WHERE task_id = ?",
        [taskId],
      );
      const task = rows[0] as { task_id: string; task_kind: string | null } | undefined;
      if (!task) {
        await conn.commit();
        return [];
      }

      const deletedIds: string[] = [];
      if (task.task_kind === "drama_package") {
        const childIds = await this.deleteByParentPackageTaskId(taskId);
        deletedIds.push(...childIds);
      }

      // 2) 删除本任务级联数据
      await this.deleteTaskArtifacts(conn, taskId);
      await conn.execute("DELETE FROM clip_task WHERE task_id = ?", [taskId]);
      await conn.commit();
      deletedIds.push(taskId);
      return deletedIds;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  private async deleteTaskArtifacts(conn: PoolConnection, taskId: string): Promise<void> {
    await conn.execute("DELETE FROM clip_task_mix_episode WHERE task_id = ?", [taskId]);
    await conn.execute("DELETE FROM clip_task_output WHERE task_id = ?", [taskId]);
    await conn.execute("DELETE FROM clip_mix_render WHERE task_id = ?", [taskId]);
  }

  async allocatePackageSeq(safeTitle: string): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO clip_drama_package_name_index (safe_title, last_seq) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE last_seq = last_seq + 1`,
        [safeTitle],
      );
      const [rows] = await conn.execute<RowDataPacket[]>(
        "SELECT last_seq FROM clip_drama_package_name_index WHERE safe_title = ?",
        [safeTitle],
      );
      await conn.commit();
      return Number(rows[0]?.last_seq ?? 1);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  private async applyClaim(conn: PoolConnection, row: TaskRow, deviceId: string): Promise<void> {
    const now = new Date();
    const isPackage = row.task_kind === "drama_package";
    const status = isPackage ? "processing" : "claimed";
    // 认领时不要提前写 phase=downloading：否则 Agent 认领后崩溃/放弃时，
    // 管理台会显示全员「下载中」但实际无人在跑。真正开始下载时由 Agent 调 updatePackagePhase。
    let dramaPackageJson: string | null = null;
    if (row.drama_package_json != null) {
      dramaPackageJson =
        typeof row.drama_package_json === "string"
          ? row.drama_package_json
          : JSON.stringify(row.drama_package_json);
    }
    await conn.execute(
      `UPDATE clip_task
       SET status = ?, claimed_by = ?, claimed_at = ?, drama_package_json = ?, updated_at = ?
       WHERE task_id = ? AND status = 'pending'`,
      [status, deviceId, now, dramaPackageJson, now, row.task_id],
    );
  }

  private async upsertRow(conn: PoolConnection, task: TaskRecord): Promise<void> {
    await conn.execute(
      `INSERT INTO clip_task (
        task_id, template_id, task_kind, status, source_url, drama_id, drama_meta_json,
        drama_package_json, episode_id, episode_no, parent_package_task_id,
        asr_rule_set_id, config_version, claimed_by, claimed_at,
        processing_started_at, processing_completed_at, total_wall_time_sec, output_url,
        fail_message, plan_json, plan_batches_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        template_id = VALUES(template_id),
        task_kind = VALUES(task_kind),
        status = VALUES(status),
        source_url = VALUES(source_url),
        drama_id = VALUES(drama_id),
        drama_meta_json = VALUES(drama_meta_json),
        drama_package_json = VALUES(drama_package_json),
        episode_id = VALUES(episode_id),
        episode_no = VALUES(episode_no),
        parent_package_task_id = VALUES(parent_package_task_id),
        asr_rule_set_id = VALUES(asr_rule_set_id),
        config_version = VALUES(config_version),
        claimed_by = VALUES(claimed_by),
        claimed_at = VALUES(claimed_at),
        processing_started_at = VALUES(processing_started_at),
        processing_completed_at = VALUES(processing_completed_at),
        total_wall_time_sec = VALUES(total_wall_time_sec),
        output_url = VALUES(output_url),
        fail_message = VALUES(fail_message),
        plan_json = VALUES(plan_json),
        plan_batches_json = VALUES(plan_batches_json),
        updated_at = VALUES(updated_at)`,
      [
        task.taskId,
        task.templateId,
        task.taskKind ?? "single",
        task.status,
        task.sourceUrl,
        task.dramaId ?? null,
        task.dramaMeta ? JSON.stringify(task.dramaMeta) : null,
        task.dramaPackage ? JSON.stringify(task.dramaPackage) : null,
        task.episodeId ?? null,
        task.episodeNo ?? null,
        task.parentPackageTaskId ?? null,
        task.asrRuleSetId ?? null,
        task.configVersion ?? null,
        task.claimedBy ?? null,
        task.claimedAt ? toMysqlDate(task.claimedAt) : null,
        task.processingStartedAt ? toMysqlDate(task.processingStartedAt) : null,
        task.processingCompletedAt ? toMysqlDate(task.processingCompletedAt) : null,
        task.totalWallTimeSec ?? null,
        task.outputUrl ?? task.outputUrls?.[0] ?? null,
        task.failMessage ?? null,
        task.plan ? JSON.stringify(task.plan) : null,
        task.planBatches?.length ? JSON.stringify(task.planBatches) : null,
        toMysqlDate(task.createdAt),
        toMysqlDate(task.updatedAt),
      ],
    );
  }

  private async replaceMixEpisodes(
    conn: PoolConnection,
    taskId: string,
    episodeIds: string[],
  ): Promise<void> {
    await conn.execute("DELETE FROM clip_task_mix_episode WHERE task_id = ?", [taskId]);
    if (!episodeIds.length) return;
    const values = episodeIds.map((episodeId, index) => [taskId, episodeId, index]);
    await conn.query(
      `INSERT INTO clip_task_mix_episode (task_id, episode_id, sort_order) VALUES ?`,
      [values],
    );
  }

  private async replaceOutputUrls(
    conn: PoolConnection,
    taskId: string,
    outputUrls: string[],
  ): Promise<void> {
    await conn.execute("DELETE FROM clip_task_output WHERE task_id = ?", [taskId]);
    if (!outputUrls.length) return;
    const values = outputUrls.map((url, index) => [taskId, url, index]);
    await conn.query(
      `INSERT INTO clip_task_output (task_id, output_url, sort_order) VALUES ?`,
      [values],
    );
  }

  private async replaceMixRenders(
    conn: PoolConnection,
    taskId: string,
    mixRenders: MixRenderRecord[],
  ): Promise<void> {
    await conn.execute("DELETE FROM clip_mix_render WHERE task_id = ?", [taskId]);
    if (!mixRenders.length) return;
    const values = mixRenders.map((render) => {
      const meta = {
        localOutputPath: render.localOutputPath,
        uploaded: render.uploaded,
        editForm: render.editForm,
        genreProfile: render.genreProfile,
        targetDurationLabel: render.targetDurationLabel,
        durationStatus: render.durationStatus,
        hookType: render.hookType,
        cliffType: render.cliffType,
        durationSec: render.durationSec,
        estimatedDurationSec: render.durationSec ?? render.estimatedDurationSec,
        planSeqInRound: render.planSeqInRound,
        skillsQuality: render.skillsQuality,
      };
      const hasMeta = Object.values(meta).some((v) => v !== undefined && v !== null);
      return [
        taskId,
        render.round ?? 1,
        render.planIndex ?? 0,
        render.outputUrl,
        render.strategy ?? null,
        render.durationTier ?? null,
        render.narrativeLine ?? null,
        hasMeta ? JSON.stringify(meta) : null,
      ];
    });
    await conn.query(
      `INSERT INTO clip_mix_render
        (task_id, round_no, plan_index, output_url, strategy, duration_tier, narrative_line, meta_json)
       VALUES ?`,
      [values],
    );
  }

  private async loadTaskExtras(
    taskIds: string[],
  ): Promise<Map<string, { mixEpisodeIds?: string[]; outputUrls?: string[]; mixRenders?: MixRenderRecord[] }>> {
    const result = new Map<
      string,
      { mixEpisodeIds?: string[]; outputUrls?: string[]; mixRenders?: MixRenderRecord[] }
    >();
    if (taskIds.length === 0) return result;

    const placeholders = taskIds.map(() => "?").join(", ");

    const [mixRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT task_id, episode_id FROM clip_task_mix_episode
       WHERE task_id IN (${placeholders}) ORDER BY task_id, sort_order`,
      taskIds,
    );
    for (const row of mixRows) {
      const entry = result.get(row.task_id as string) ?? {};
      entry.mixEpisodeIds ??= [];
      entry.mixEpisodeIds.push(row.episode_id as string);
      result.set(row.task_id as string, entry);
    }

    const [outputRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT task_id, output_url FROM clip_task_output
       WHERE task_id IN (${placeholders}) ORDER BY task_id, sort_order`,
      taskIds,
    );
    for (const row of outputRows) {
      const entry = result.get(row.task_id as string) ?? {};
      entry.outputUrls ??= [];
      entry.outputUrls.push(row.output_url as string);
      result.set(row.task_id as string, entry);
    }

    const [renderRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT task_id, round_no, plan_index, output_url, strategy, duration_tier, narrative_line, meta_json
       FROM clip_mix_render WHERE task_id IN (${placeholders})
       ORDER BY task_id, round_no, plan_index`,
      taskIds,
    );
    for (const row of renderRows) {
      const entry = result.get(row.task_id as string) ?? {};
      entry.mixRenders ??= [];
      const meta =
        row.meta_json && typeof row.meta_json === "object"
          ? (row.meta_json as Record<string, unknown>)
          : typeof row.meta_json === "string"
            ? (JSON.parse(row.meta_json) as Record<string, unknown>)
            : {};
      entry.mixRenders.push({
        round: Number(row.round_no),
        planIndex: Number(row.plan_index),
        outputUrl: row.output_url as string,
        strategy: (row.strategy as string | null) ?? undefined,
        durationTier: (row.duration_tier as MixRenderRecord["durationTier"]) ?? undefined,
        narrativeLine: (row.narrative_line as string | null) ?? undefined,
        localOutputPath: meta.localOutputPath as string | undefined,
        uploaded: meta.uploaded as boolean | undefined,
        editForm: meta.editForm as MixRenderRecord["editForm"],
        genreProfile: meta.genreProfile as MixRenderRecord["genreProfile"],
        targetDurationLabel: meta.targetDurationLabel as MixRenderRecord["targetDurationLabel"],
        durationStatus: meta.durationStatus as MixRenderRecord["durationStatus"],
        hookType: meta.hookType as string | undefined,
        cliffType: meta.cliffType as string | undefined,
        durationSec: (meta.durationSec as number | undefined) ??
          (meta.estimatedDurationSec as number | undefined),
        estimatedDurationSec: (meta.durationSec as number | undefined) ??
          (meta.estimatedDurationSec as number | undefined),
        planSeqInRound: meta.planSeqInRound as number | undefined,
        skillsQuality: meta.skillsQuality as MixRenderRecord["skillsQuality"],
      });
      result.set(row.task_id as string, entry);
    }

    return result;
  }

  /**
   * 跨设备成片库：直接读 clip_task_output（+ 任务主表 output_url 兜底），不按认领设备分页截断。
   */
  async listSharedHttpOutputs(limit = 500): Promise<
    Array<{ taskId: string; url: string; updatedAt?: string; dramaTitle?: string }>
  > {
    const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT o.task_id AS taskId, o.output_url AS url, t.updated_at AS updatedAt, t.drama_meta_json AS dramaMeta
       FROM clip_task_output o
       INNER JOIN clip_task t ON t.task_id = o.task_id
       WHERE o.output_url LIKE 'http%'
       ORDER BY o.id DESC
       LIMIT ${lim}`,
    );
    const seen = new Set<string>();
    const out: Array<{ taskId: string; url: string; updatedAt?: string; dramaTitle?: string }> = [];
    const push = (taskId: string, url: string, updatedAt?: Date | string, dramaMeta?: unknown) => {
      const key = url.trim();
      if (!/^https?:\/\//i.test(key) || seen.has(key)) return;
      seen.add(key);
      let dramaTitle: string | undefined;
      if (dramaMeta && typeof dramaMeta === "object" && !Array.isArray(dramaMeta)) {
        const title = (dramaMeta as Record<string, unknown>).title;
        if (typeof title === "string" && title.trim()) dramaTitle = title.trim();
      } else if (typeof dramaMeta === "string" && dramaMeta.trim()) {
        try {
          const parsed = JSON.parse(dramaMeta) as { title?: string };
          if (typeof parsed?.title === "string" && parsed.title.trim()) {
            dramaTitle = parsed.title.trim();
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        taskId,
        url: key,
        updatedAt: updatedAt ? toIso(updatedAt instanceof Date ? updatedAt : new Date(updatedAt)) ?? undefined : undefined,
        dramaTitle,
      });
    };
    for (const row of rows) {
      push(
        String(row.taskId ?? row.task_id ?? ""),
        String(row.url ?? row.output_url ?? ""),
        row.updatedAt ?? row.updated_at,
        row.dramaMeta ?? row.drama_meta,
      );
    }
    // 主表 output_url 兜底（历史数据可能未写入 clip_task_output）
    const [mainRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT task_id AS taskId, output_url AS url, updated_at AS updatedAt, drama_meta_json AS dramaMeta
       FROM clip_task
       WHERE output_url LIKE 'http%'
       ORDER BY updated_at DESC
       LIMIT ${lim}`,
    );
    for (const row of mainRows) {
      push(
        String(row.taskId ?? row.task_id ?? ""),
        String(row.url ?? row.output_url ?? ""),
        row.updatedAt ?? row.updated_at,
        row.dramaMeta ?? row.drama_meta,
      );
    }
    return out;
  }

  /** Agent 历史表现聚合：单条 GROUP BY，含 p50/p95 耗时（子查询内排序取分位） */
  async aggregateAgentSummary(since?: Date): Promise<
    Array<{
      deviceId: string;
      taskTotal: number;
      taskSuccess: number;
      taskFail: number;
      running: number;
      avgWallSec: number | null;
      p50WallSec: number | null;
      p95WallSec: number | null;
      firstSeenAt: string | null;
      lastActiveAt: string | null;
    }>
  > {
    const sinceClause = since ? "AND claimed_at >= ?" : "";
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT t.claimed_by AS deviceId,
              COUNT(*) AS taskTotal,
              SUM(t.status = 'completed') AS taskSuccess,
              SUM(t.status = 'failed') AS taskFail,
              SUM(t.status IN ('claimed', 'processing')) AS running,
              AVG(CASE WHEN t.status = 'completed' THEN t.total_wall_time_sec END) AS avgWallSec,
              MIN(t.claimed_at) AS firstSeenAt,
              MAX(t.claimed_at) AS lastActiveAt
       FROM clip_task t
       WHERE t.claimed_by IS NOT NULL ${sinceClause}
       GROUP BY t.claimed_by`,
      since ? [since] : [],
    );

    if (!rows.length) return [];
    // p50/p95 一次性取回各设备已完成任务耗时，内存分位（数据量为各设备完成任务数，可接受）
    const ids = rows.map((r) => String(r.deviceId));
    const placeholders = ids.map(() => "?").join(", ");
    const [durRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT claimed_by AS deviceId, total_wall_time_sec AS sec
       FROM clip_task
       WHERE claimed_by IN (${placeholders})
         AND status = 'completed'
         AND total_wall_time_sec IS NOT NULL`,
      ids,
    );
    const durationsByDevice = new Map<string, number[]>();
    for (const row of durRows) {
      const list = durationsByDevice.get(String(row.deviceId)) ?? [];
      list.push(Number(row.sec));
      durationsByDevice.set(String(row.deviceId), list);
    }
    const percentile = (sorted: number[], p: number): number | null => {
      if (!sorted.length) return null;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return Math.round(sorted[idx]!);
    };

    return rows.map((r) => {
      const durations = (durationsByDevice.get(String(r.deviceId)) ?? []).sort((a, b) => a - b);
      return {
        deviceId: String(r.deviceId),
        taskTotal: Number(r.taskTotal ?? 0),
        taskSuccess: Number(r.taskSuccess ?? 0),
        taskFail: Number(r.taskFail ?? 0),
        running: Number(r.running ?? 0),
        avgWallSec: r.avgWallSec != null ? Math.round(Number(r.avgWallSec)) : null,
        p50WallSec: percentile(durations, 50),
        p95WallSec: percentile(durations, 95),
        firstSeenAt: toIso(r.firstSeenAt instanceof Date ? r.firstSeenAt : new Date(String(r.firstSeenAt))) ?? null,
        lastActiveAt: toIso(r.lastActiveAt instanceof Date ? r.lastActiveAt : new Date(String(r.lastActiveAt))) ?? null,
      };
    });
  }

  /** 近 N 天任务趋势：单条 GROUP BY DATE(updated_at) */
  async aggregateTaskTrend(since: Date): Promise<
    Array<{ day: string; total: number; success: number; fail: number }>
  > {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT DATE(updated_at) AS day,
              COUNT(*) AS total,
              SUM(status = 'completed') AS success,
              SUM(status = 'failed') AS fail
       FROM clip_task
       WHERE updated_at >= ?
       GROUP BY DATE(updated_at)
       ORDER BY day ASC`,
      [since],
    );
    return rows.map((r) => ({
      day: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day),
      total: Number(r.total ?? 0),
      success: Number(r.success ?? 0),
      fail: Number(r.fail ?? 0),
    }));
  }
}
