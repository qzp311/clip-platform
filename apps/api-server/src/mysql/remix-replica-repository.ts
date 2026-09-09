import type { Pool, RowDataPacket } from "mysql2/promise";
import { toIso, toMysqlDate } from "./json.js";

export type RemixJobStatus =
  | "pending"
  | "claimed"
  | "analyzing"
  | "rendering"
  | "uploading"
  | "completed"
  | "failed"
  | "waiting_intake";

export interface RemixJob {
  jobId: string;
  dramaId: string | null;
  intakeId: string | null;
  externalDramaId: string | null;
  caseVideoUrl: string;
  caseVideoUrls: string[];
  episodeUrls: string[];
  parentPackageTaskId: string | null;
  status: RemixJobStatus;
  timeline?: Record<string, unknown>;
  outputUrl?: string;
  errorMessage?: string;
  deviceId?: string;
  claimedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  fissionEnabled: boolean;
  fissionOps: string[];
  fissionCount: number;
}

export interface CreateRemixJobInput {
  jobId: string;
  dramaId?: string | null;
  intakeId?: string | null;
  externalDramaId?: string | null;
  caseVideoUrl: string;
  caseVideoUrls?: string[];
  episodeUrls?: string[];
  parentPackageTaskId?: string | null;
  status?: RemixJobStatus;
  fissionEnabled?: boolean;
  fissionOps?: string[];
  fissionCount?: number;
}

interface RemixJobRow extends RowDataPacket {
  job_id: string;
  drama_id: string | null;
  intake_id: string | null;
  external_drama_id: string | null;
  case_video_url: string;
  case_video_urls: unknown;
  episode_urls: unknown;
  parent_package_task_id: string | null;
  status: RemixJobStatus;
  timeline_json: unknown;
  output_url: string | null;
  error_message: string | null;
  device_id: string | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  fission_enabled: number;
  fission_ops: unknown;
  fission_count: number;
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

function parseEpisodeUrls(value: unknown): string[] {
  const parsed = parseJson<string[]>(value);
  if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
  return [];
}

function parseFissionOps(value: unknown): string[] {
  const parsed = parseJson<string[]>(value);
  if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
  return [];
}

function rowToJob(row: RemixJobRow): RemixJob {
  const caseVideoUrls = parseEpisodeUrls(row.case_video_urls);
  return {
    jobId: row.job_id,
    dramaId: row.drama_id,
    intakeId: row.intake_id,
    externalDramaId: row.external_drama_id,
    caseVideoUrl: row.case_video_url,
    caseVideoUrls: caseVideoUrls.length > 0 ? caseVideoUrls : row.case_video_url ? [row.case_video_url] : [],
    episodeUrls: parseEpisodeUrls(row.episode_urls),
    parentPackageTaskId: row.parent_package_task_id,
    status: row.status,
    timeline: parseJson<Record<string, unknown>>(row.timeline_json),
    outputUrl: row.output_url ?? undefined,
    errorMessage: row.error_message ?? undefined,
    deviceId: row.device_id ?? undefined,
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    fissionEnabled: Boolean(row.fission_enabled),
    fissionOps: parseFissionOps(row.fission_ops),
    fissionCount: Number(row.fission_count ?? 0),
  };
}

export class RemixReplicaRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateRemixJobInput): Promise<RemixJob> {
    const caseVideoUrls = [
      ...new Set([...(input.caseVideoUrls ?? []).filter((url) => url.trim() !== ""), input.caseVideoUrl]),
    ];
    await this.pool.execute(
      `INSERT INTO clip_remix_job
       (job_id, drama_id, intake_id, external_drama_id, case_video_url, case_video_urls, episode_urls, parent_package_task_id, status,
        fission_enabled, fission_ops, fission_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.jobId,
        input.dramaId ?? null,
        input.intakeId ?? null,
        input.externalDramaId ?? null,
        input.caseVideoUrl,
        JSON.stringify(caseVideoUrls),
        JSON.stringify(input.episodeUrls ?? []),
        input.parentPackageTaskId ?? null,
        input.status ?? "pending",
        input.fissionEnabled ? 1 : 0,
        JSON.stringify(input.fissionOps ?? []),
        Math.max(0, input.fissionCount ?? 0),
      ],
    );
    const job = await this.findById(input.jobId);
    if (!job) throw new Error("创建复刻任务后查询失败");
    return job;
  }

  async findById(jobId: string): Promise<RemixJob | null> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job WHERE job_id = ? LIMIT 1`,
      [jobId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async listByDrama(dramaId: string, limit = 50): Promise<RemixJob[]> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job WHERE drama_id = ? ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
      [dramaId],
    );
    return rows.map(rowToJob);
  }

  async listAll(limit = 50): Promise<RemixJob[]> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
    );
    return rows.map(rowToJob);
  }

  /** 查询等待某条入库记录的复刻任务 */
  async listWaitingByIntakeId(intakeId: string): Promise<RemixJob[]> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job WHERE intake_id = ? AND status = 'waiting_intake'`,
      [intakeId],
    );
    return rows.map(rowToJob);
  }

  /** 查询某个 intake 是否已经有等待/待领取的复刻任务（防止重复创建） */
  async findActiveByIntakeId(intakeId: string): Promise<RemixJob | null> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job
       WHERE intake_id = ? AND status IN ('waiting_intake', 'pending', 'claimed')
       ORDER BY created_at DESC LIMIT 1`,
      [intakeId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  /** 查询等待某个外部短剧 ID 的复刻任务（intake 未创建时按 externalDramaId 兜底） */
  async listWaitingByExternalDramaId(externalDramaId: string): Promise<RemixJob[]> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job WHERE external_drama_id = ? AND status = 'waiting_intake'`,
      [externalDramaId],
    );
    return rows.map(rowToJob);
  }

  /** 当入库完成、 dramaId 与 parentPackageTaskId 确定后，把等待的复刻任务转为 pending */
  async activateWaiting(
    jobId: string,
    patch: { dramaId: string; parentPackageTaskId: string },
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_remix_job
       SET drama_id = ?, parent_package_task_id = ?, status = 'pending'
       WHERE job_id = ? AND status = 'waiting_intake'`,
      [patch.dramaId, patch.parentPackageTaskId, jobId],
    );
  }

  async claim(jobId: string, deviceId: string): Promise<RemixJob | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `UPDATE clip_remix_job
         SET status = 'claimed', device_id = ?, claimed_at = CURRENT_TIMESTAMP(3)
         WHERE job_id = ? AND status = 'pending'`,
        [deviceId, jobId],
      );
      const affected = Number((result as { affectedRows?: number }).affectedRows ?? 0);
      if (!affected) {
        await conn.commit();
        return null;
      }
      await conn.execute(
        `UPDATE clip_task
         SET status = 'claimed', claimed_by = ?, claimed_at = NOW(3), updated_at = NOW(3)
         WHERE task_id = ? AND status = 'pending' AND task_kind = 'remix_replica'`,
        [deviceId, jobId],
      );
      await conn.commit();
      return this.findById(jobId);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** 父任务尚未完成时，把已领取的复刻任务恢复为 pending */
  async releaseClaim(jobId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_remix_job
       SET status = 'pending', device_id = NULL, claimed_at = NULL
       WHERE job_id = ? AND status = 'claimed'`,
      [jobId],
    );
  }

  async updateStatus(
    jobId: string,
    status: RemixJobStatus,
    patch?: { timeline?: Record<string, unknown>; errorMessage?: string },
  ): Promise<void> {
    const fields: string[] = ["status = ?"];
    const params: (string | Date)[] = [status];
    if (patch?.timeline != null) {
      fields.push("timeline_json = ?");
      params.push(JSON.stringify(patch.timeline));
    }
    if (patch?.errorMessage != null) {
      fields.push("error_message = ?");
      params.push(patch.errorMessage);
    }
    params.push(jobId);
    await this.pool.execute(
      `UPDATE clip_remix_job SET ${fields.join(", ")} WHERE job_id = ?`,
      params,
    );
  }

  async complete(jobId: string, outputUrl: string, timeline?: Record<string, unknown>): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_remix_job
       SET status = 'completed', output_url = ?, timeline_json = ?, completed_at = CURRENT_TIMESTAMP(3), error_message = NULL
       WHERE job_id = ?`,
      [outputUrl, timeline ? JSON.stringify(timeline) : null, jobId],
    );
  }

  async fail(jobId: string, errorMessage: string): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_remix_job
       SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP(3)
       WHERE job_id = ?`,
      [errorMessage, jobId],
    );
  }

  /** 查找可领取的 pending 任务， oldest first */
  async findPendingForClaim(): Promise<RemixJob | null> {
    const [rows] = await this.pool.execute<RemixJobRow[]>(
      `SELECT * FROM clip_remix_job WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }
}
