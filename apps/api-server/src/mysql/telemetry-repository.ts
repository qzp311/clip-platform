import type { Pool, RowDataPacket } from "mysql2/promise";
import type { TelemetryBatch } from "@clip/sdk";
import { sqlLimitOffset } from "../pagination.js";
import { toIso } from "./json.js";

export interface DailyStatsRow {
  device_id: string;
  machine_id?: string;
  gpu_name?: string;
  stat_date: string;
  task_count: number;
  task_success: number;
  task_fail: number;
  asr_audio_sec_total: number;
  asr_wall_sec_total: number;
  asr_job_count: number;
  render_output_sec_total: number;
  render_wall_sec_total: number;
  render_bytes_total: number;
}

interface StatsRow extends RowDataPacket {
  device_id: string;
  task_count: number;
  task_success: number;
  task_fail: number;
  asr_audio_sec_total: number;
  asr_wall_sec_total: number;
  asr_job_count: number;
  render_output_sec_total: number;
  render_wall_sec_total: number;
  render_bytes_total: number;
}

interface BatchRow extends RowDataPacket {
  id: number;
  device_id: string;
  task_id: string;
  config_version: string;
  asr_rule_set_id: string | null;
  asr_rule_set_version: string | null;
  created_at: Date;
}

export class TelemetryMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async insertBatch(batch: TelemetryBatch): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO clip_telemetry_batch
          (device_id, task_id, config_version, asr_rule_set_id, asr_rule_set_version)
         VALUES (?, ?, ?, ?, ?)`,
        [
          batch.deviceId,
          batch.taskId,
          batch.configVersion ?? "",
          batch.asrRuleSetId ?? null,
          batch.asrRuleSetVersion ?? null,
        ],
      );
      const batchId = Number((result as { insertId: number }).insertId);
      if (batch.events.length) {
        const eventValues = batch.events.map((event) => [
          batchId,
          event.type,
          new Date(event.at ?? new Date().toISOString()),
          JSON.stringify(event.metrics ?? {}),
        ]);
        await conn.query(
          `INSERT INTO clip_telemetry_event (batch_id, event_type, event_at, metrics_json)
           VALUES ?`,
          [eventValues],
        );
      }
      await conn.commit();
      return batchId;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async listBatchesByDeviceDate(deviceId: string, datePrefix: string): Promise<TelemetryBatch[]> {
    const [rows] = await this.pool.query<BatchRow[]>(
      `SELECT b.id, b.device_id, b.task_id, b.config_version, b.asr_rule_set_id, b.asr_rule_set_version, b.created_at
       FROM clip_telemetry_batch b
       WHERE b.device_id = ? AND b.created_at >= ? AND b.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY b.created_at ASC`,
      [deviceId, `${datePrefix} 00:00:00.000`, `${datePrefix} 00:00:00.000`],
    );
    const batches: TelemetryBatch[] = [];
    for (const row of rows) {
      const [events] = await this.pool.query<
        Array<RowDataPacket & { event_type: string; event_at: Date; metrics_json: unknown }>
      >("SELECT event_type, event_at, metrics_json FROM clip_telemetry_event WHERE batch_id = ?", [
        row.id,
      ]);
      batches.push({
        deviceId: row.device_id,
        taskId: row.task_id,
        configVersion: row.config_version,
        asrRuleSetId: row.asr_rule_set_id ?? undefined,
        asrRuleSetVersion: row.asr_rule_set_version ?? undefined,
        events: events.map((e) => ({
          type: e.event_type,
          at: toIso(e.event_at)!,
          metrics: typeof e.metrics_json === "string" ? JSON.parse(e.metrics_json) : e.metrics_json,
        })),
      });
    }
    return batches;
  }

  async upsertDailyStats(
    statDate: string,
    deviceId: string,
    delta: Omit<
      DailyStatsRow,
      "device_id" | "stat_date" | "machine_id" | "gpu_name"
    >,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_device_daily_stats
        (stat_date, device_id, task_count, task_success, task_fail,
         asr_audio_sec_total, asr_wall_sec_total, asr_job_count,
         render_output_sec_total, render_wall_sec_total, render_bytes_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         task_count = task_count + VALUES(task_count),
         task_success = task_success + VALUES(task_success),
         task_fail = task_fail + VALUES(task_fail),
         asr_audio_sec_total = asr_audio_sec_total + VALUES(asr_audio_sec_total),
         asr_wall_sec_total = asr_wall_sec_total + VALUES(asr_wall_sec_total),
         asr_job_count = asr_job_count + VALUES(asr_job_count),
         render_output_sec_total = render_output_sec_total + VALUES(render_output_sec_total),
         render_wall_sec_total = render_wall_sec_total + VALUES(render_wall_sec_total),
         render_bytes_total = render_bytes_total + VALUES(render_bytes_total)`,
      [
        statDate,
        deviceId,
        delta.task_count,
        delta.task_success,
        delta.task_fail,
        delta.asr_audio_sec_total,
        delta.asr_wall_sec_total,
        delta.asr_job_count,
        delta.render_output_sec_total,
        delta.render_wall_sec_total,
        delta.render_bytes_total,
      ],
    );
  }

  async listDailyStats(statDate: string): Promise<StatsRow[]> {
    const [rows] = await this.pool.query<StatsRow[]>(
      "SELECT * FROM clip_device_daily_stats WHERE stat_date = ? ORDER BY device_id",
      [statDate],
    );
    return rows;
  }

  async listDailyStatsPage(
    statDate: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: StatsRow[]; total: number }> {
    const [countRows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM clip_device_daily_stats WHERE stat_date = ?",
      [statDate],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    const [rows] = await this.pool.query<StatsRow[]>(
      `SELECT * FROM clip_device_daily_stats WHERE stat_date = ? ORDER BY device_id${sqlLimitOffset(limit, offset)}`,
      [statDate],
    );
    return { rows, total };
  }
}
