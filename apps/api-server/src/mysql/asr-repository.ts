import type { RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";
import type {
  AsrResultRecord,
  AsrResultSummary,
  AsrSegment,
  ClipTaskKind,
  RawAsrSegment,
} from "@clip/sdk";
import { sqlLimitOffset } from "../pagination.js";
import { toIso, toMysqlDate } from "./json.js";

interface AsrResultRow extends RowDataPacket {
  task_id: string;
  drama_id: string | null;
  episode_id: string | null;
  episode_no: number | null;
  task_kind: ClipTaskKind;
  device_id: string | null;
  source_url: string | null;
  asr_rule_set_id: string | null;
  rule_set_version: string | null;
  raw_segment_count: number | null;
  final_segment_count: number;
  full_text: string | null;
  subtitle_url: string | null;
  subtitles_json_url: string | null;
  saved_at: Date | string;
  updated_at: Date | string;
}

interface SegmentRow extends RowDataPacket {
  segment_id: string;
  sort_order: number;
  start_ms: number;
  end_ms: number;
  speech_start_ms: number | null;
  text: string;
  confidence: number | null;
  episode_id: string | null;
  episode_no: number | null;
  highlight_type: string | null;
  highlight_score: number | null;
  highlight_tags: string | null;
  usable_as_hook: number | null;
  speaker_id: string | null;
  emotion: string | null;
  scene_type: string | null;
  label_source: string | null;
}

interface RawSegmentRow extends RowDataPacket {
  raw_id: string;
  sort_order: number;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
}

function basenameFromSourceUrl(sourceUrl: string): string {
  let path = sourceUrl || "";
  if (path.startsWith("clip-local:")) {
    try {
      path = decodeURIComponent(path.slice("clip-local:".length));
    } catch {
      path = path.slice("clip-local:".length);
    }
  }
  return path.replace(/\\/g, "/").split("/").pop()?.split(/[?#]/)[0]?.toLowerCase() || "";
}

/** 成片稳定后缀：不受中文剧名 sanitize 影响 */
function distinctiveOutputTail(fileName: string): string | null {
  const base = String(fileName || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .split(/[?#]/)[0]
    .trim();
  if (!base) return null;
  const m = base.match(/(\d{1,3}-\d+-\d{10,}-autoclip\.mp4)$/i);
  if (m?.[1]) return m[1].toLowerCase();
  if (/autoclip\.mp4$/i.test(base) && base.length >= 20) return base;
  return null;
}

function pickBestOutputAsrRow(
  rows: AsrResultRow[],
  wantBase: string,
  wantTail: string | null,
): AsrResultRow | null {
  if (!rows.length) return null;
  const exact = rows.find((r) => basenameFromSourceUrl(r.source_url || "") === wantBase);
  if (exact) return exact;
  if (wantTail) {
    const byTail = rows.find((r) => {
      const base = basenameFromSourceUrl(r.source_url || "");
      return base.endsWith(wantTail) || distinctiveOutputTail(base) === wantTail;
    });
    if (byTail) return byTail;
  }
  return null;
}

function mapRow(row: AsrResultRow, segments: AsrSegment[], rawSegments?: RawAsrSegment[]): AsrResultRecord {
  return {
    taskId: row.task_id,
    dramaId: row.drama_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    episodeNo: row.episode_no ?? undefined,
    taskKind: row.task_kind,
    deviceId: row.device_id ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    asrRuleSetId: row.asr_rule_set_id ?? undefined,
    ruleSetVersion: row.rule_set_version ?? undefined,
    rawSegmentCount: row.raw_segment_count ?? undefined,
    finalSegmentCount: row.final_segment_count,
    fullText: row.full_text ?? undefined,
    subtitleUrl: row.subtitle_url ?? undefined,
    subtitlesJsonUrl: row.subtitles_json_url ?? undefined,
    savedAt: toIso(row.saved_at)!,
    updatedAt: toIso(row.updated_at)!,
    segments,
    rawSegments,
  };
}

export class AsrMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async deleteByTaskId(taskId: string): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM clip_asr_segment WHERE task_id = ?", [taskId]);
      await conn.execute("DELETE FROM clip_asr_raw_segment WHERE task_id = ?", [taskId]);
      await conn.execute("DELETE FROM clip_asr_result WHERE task_id = ?", [taskId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** 更新 ASR 时保留首次 saved_at，避免加载全量 segments */
  async findSavedAt(taskId: string): Promise<string | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT saved_at FROM clip_asr_result WHERE task_id = ? LIMIT 1",
      [taskId],
    );
    const row = rows[0];
    if (!row?.saved_at) return undefined;
    return toIso(row.saved_at as Date);
  }

  async save(record: AsrResultRecord): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.upsertResult(conn, record);
      await conn.execute("DELETE FROM clip_asr_segment WHERE task_id = ?", [record.taskId]);
      await conn.execute("DELETE FROM clip_asr_raw_segment WHERE task_id = ?", [record.taskId]);
      await this.insertSegments(conn, record);
      await this.insertRawSegments(conn, record);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async findByTaskId(taskId: string): Promise<AsrResultRecord | null> {
    const [rows] = await this.pool.query<AsrResultRow[]>(
      "SELECT * FROM clip_asr_result WHERE task_id = ? LIMIT 1",
      [taskId],
    );
    if (!rows.length) return null;
    const segments = await this.loadSegments(taskId);
    const rawSegments = await this.loadRawSegments(taskId);
    return mapRow(rows[0]!, segments, rawSegments.length ? rawSegments : undefined);
  }

  /** 本地索引缺失时：按剧目/集号/设备回落查最新一条 ASR */
  async findLatestByEpisode(filter: {
    dramaId?: string;
    episodeId?: string;
    episodeNo?: number;
    deviceId?: string;
  }): Promise<AsrResultRecord | null> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.dramaId) {
      clauses.push("drama_id = ?");
      params.push(filter.dramaId);
    }
    if (filter.episodeId) {
      clauses.push("episode_id = ?");
      params.push(filter.episodeId);
    }
    if (filter.episodeNo != null && Number.isFinite(filter.episodeNo)) {
      clauses.push("episode_no = ?");
      params.push(Math.trunc(filter.episodeNo));
    }
    if (filter.deviceId) {
      clauses.push("device_id = ?");
      params.push(filter.deviceId);
    }
    // 至少要有「剧+集」或「设备+集」或 episodeId，避免全表扫
    const hasDramaEp = !!filter.dramaId && filter.episodeNo != null;
    const hasDeviceEp = !!filter.deviceId && filter.episodeNo != null;
    const hasEpisodeId = !!filter.episodeId;
    if (!hasDramaEp && !hasDeviceEp && !hasEpisodeId) return null;
    if (!clauses.length) return null;

    const [rows] = await this.pool.query<AsrResultRow[]>(
      `SELECT * FROM clip_asr_result
       WHERE ${clauses.join(" AND ")}
       ORDER BY (task_kind = 'episode_asr') DESC, updated_at DESC
       LIMIT 1`,
      params,
    );
    if (!rows.length) return null;
    const taskId = rows[0]!.task_id;
    const segments = await this.loadSegments(taskId);
    const rawSegments = await this.loadRawSegments(taskId);
    return mapRow(rows[0]!, segments, rawSegments.length ? rawSegments : undefined);
  }

  /** 成片真 ASR：严格匹配，禁止裸文件名模糊命中 */
  async findLatestOutputAsr(filter: {
    sourceUrl?: string;
    parentTaskId?: string;
    fileName?: string;
  }): Promise<AsrResultRecord | null> {
    const sourceUrl = filter.sourceUrl?.trim();
    const parentTaskId = filter.parentTaskId?.trim();
    const fileName = filter.fileName?.trim();
    if (!sourceUrl && !fileName) return null;

    // 1) 精确 sourceUrl
    if (sourceUrl) {
      const hit = await this.queryLatestOutputAsr(["r.source_url = ?"], [sourceUrl]);
      if (hit) return hit;
    }

    const wantBase = (fileName || basenameFromSourceUrl(sourceUrl || "")).toLowerCase();
    const wantTail = distinctiveOutputTail(wantBase);
    if (!wantBase && !wantTail) return null;

    // 2) 带父任务：在同一父任务下按文件名/稳定后缀精确比
    if (parentTaskId) {
      const rows = await this.listOutputAsrRows(
        ["t.parent_package_task_id = ?"],
        [parentTaskId],
        40,
      );
      const matched = pickBestOutputAsrRow(rows, wantBase, wantTail);
      if (matched) return this.hydrateAsrRow(matched);
    }

    // 3) 无父任务：仅允许「时间戳-autoclip」稳定后缀全库命中
    // （TOS 成片跨端下载后 path 不同，需靠文件名复用已入库 ASR；短名禁止，防串剧）
    const strongTail =
      wantTail && /^\d{1,3}-\d+-\d{10,}-autoclip\.mp4$/i.test(wantTail) ? wantTail : null;
    if (strongTail) {
      const rows = await this.listOutputAsrRows(
        ["LOWER(r.source_url) LIKE ?"],
        [`%${strongTail}`],
        20,
      );
      const matched = pickBestOutputAsrRow(rows, wantBase, strongTail);
      if (matched) return this.hydrateAsrRow(matched);
    }

    return null;
  }

  private async queryLatestOutputAsr(
    clauses: string[],
    params: unknown[],
  ): Promise<AsrResultRecord | null> {
    const rows = await this.listOutputAsrRows(clauses, params, 1);
    if (!rows.length) return null;
    return this.hydrateAsrRow(rows[0]!);
  }

  private async listOutputAsrRows(
    clauses: string[],
    params: unknown[],
    limit: number,
  ): Promise<AsrResultRow[]> {
    const where = ["r.task_kind = 'output_asr'", ...clauses];
    const [rows] = await this.pool.query<AsrResultRow[]>(
      `SELECT r.* FROM clip_asr_result r
       LEFT JOIN clip_task t ON t.task_id = r.task_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.updated_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 50)}`,
      params,
    );
    return rows;
  }

  private async hydrateAsrRow(row: AsrResultRow): Promise<AsrResultRecord> {
    const taskId = row.task_id;
    const segments = await this.loadSegments(taskId);
    const rawSegments = await this.loadRawSegments(taskId);
    return mapRow(row, segments, rawSegments.length ? rawSegments : undefined);
  }

  async listSummaries(filter?: {
    dramaId?: string;
    episodeId?: string;
    deviceId?: string;
    taskKind?: ClipTaskKind;
    limit?: number;
    offset?: number;
  }): Promise<{ results: AsrResultSummary[]; total: number; limit: number; offset: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.dramaId) {
      clauses.push("drama_id = ?");
      params.push(filter.dramaId);
    }
    if (filter?.episodeId) {
      clauses.push("episode_id = ?");
      params.push(filter.episodeId);
    }
    if (filter?.deviceId) {
      clauses.push("device_id = ?");
      params.push(filter.deviceId);
    }
    if (filter?.taskKind) {
      clauses.push("task_kind = ?");
      params.push(filter.taskKind);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    const offset = Math.max(filter?.offset ?? 0, 0);

    const [countRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM clip_asr_result ${where}`,
      params,
    );
    const total = Number(countRows[0]?.cnt ?? 0);

    const [rows] = await this.pool.query<AsrResultRow[]>(
      `SELECT task_id, drama_id, episode_id, episode_no, task_kind, device_id, source_url,
              asr_rule_set_id, rule_set_version, raw_segment_count, final_segment_count,
              full_text, subtitle_url, subtitles_json_url, saved_at, updated_at
       FROM clip_asr_result ${where} ORDER BY updated_at DESC${sqlLimitOffset(limit, offset)}`,
      params,
    );
    const results = rows.map((row) => {
      const { segments: _s, rawSegments: _r, ...summary } = mapRow(row, []);
      return summary;
    });
    return { results, total, limit, offset };
  }

  private async upsertResult(conn: PoolConnection, record: AsrResultRecord): Promise<void> {
    await conn.execute(
      `INSERT INTO clip_asr_result (
        task_id, drama_id, episode_id, episode_no, task_kind, device_id, source_url,
        asr_rule_set_id, rule_set_version, raw_segment_count, final_segment_count,
        full_text, subtitle_url, subtitles_json_url, saved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        drama_id = VALUES(drama_id),
        episode_id = VALUES(episode_id),
        episode_no = VALUES(episode_no),
        task_kind = VALUES(task_kind),
        device_id = VALUES(device_id),
        source_url = VALUES(source_url),
        asr_rule_set_id = VALUES(asr_rule_set_id),
        rule_set_version = VALUES(rule_set_version),
        raw_segment_count = VALUES(raw_segment_count),
        final_segment_count = VALUES(final_segment_count),
        full_text = VALUES(full_text),
        subtitle_url = VALUES(subtitle_url),
        subtitles_json_url = VALUES(subtitles_json_url),
        updated_at = VALUES(updated_at)`,
      [
        record.taskId,
        record.dramaId ?? null,
        record.episodeId ?? null,
        record.episodeNo ?? null,
        record.taskKind ?? "single",
        record.deviceId ?? null,
        record.sourceUrl ?? null,
        record.asrRuleSetId ?? null,
        record.ruleSetVersion ?? null,
        record.rawSegmentCount ?? null,
        record.finalSegmentCount,
        record.fullText ?? null,
        record.subtitleUrl ?? null,
        record.subtitlesJsonUrl ?? null,
        toMysqlDate(record.savedAt),
        toMysqlDate(record.updatedAt),
      ],
    );
  }

  private async insertSegments(conn: PoolConnection, record: AsrResultRecord): Promise<void> {
    if (!record.segments.length) return;
    const values = record.segments.map((segment, index) => [
      record.taskId,
      segment.segmentId,
      index,
      segment.startMs,
      segment.endMs,
      segment.speechStartMs ?? null,
      segment.text,
      segment.confidence ?? null,
      segment.episodeId ?? null,
      segment.episodeNo ?? null,
      segment.highlightType ?? null,
      segment.highlightScore ?? null,
      segment.highlightTags?.length ? segment.highlightTags.join(",") : null,
      segment.usableAsHook == null ? null : segment.usableAsHook ? 1 : 0,
      segment.speakerId ?? null,
      segment.emotion ?? null,
      segment.sceneType ?? null,
      segment.labelSource ?? null,
    ]);
    await conn.query(
      `INSERT INTO clip_asr_segment
        (task_id, segment_id, sort_order, start_ms, end_ms, speech_start_ms, text, confidence,
         episode_id, episode_no, highlight_type, highlight_score, highlight_tags, usable_as_hook,
         speaker_id, emotion, scene_type, label_source)
       VALUES ?`,
      [values],
    );
  }

  private async insertRawSegments(conn: PoolConnection, record: AsrResultRecord): Promise<void> {
    if (!record.rawSegments?.length) return;
    const values = record.rawSegments.map((segment, index) => [
      record.taskId,
      segment.id,
      index,
      segment.startMs,
      segment.endMs,
      segment.text,
      segment.confidence ?? null,
    ]);
    await conn.query(
      `INSERT INTO clip_asr_raw_segment
        (task_id, raw_id, sort_order, start_ms, end_ms, text, confidence)
       VALUES ?`,
      [values],
    );
  }

  private async loadSegments(taskId: string): Promise<AsrSegment[]> {
    const [rows] = await this.pool.query<SegmentRow[]>(
      `SELECT segment_id, sort_order, start_ms, end_ms, speech_start_ms, text, confidence,
              episode_id, episode_no, highlight_type, highlight_score, highlight_tags, usable_as_hook,
              speaker_id, emotion, scene_type, label_source
       FROM clip_asr_segment WHERE task_id = ? ORDER BY sort_order ASC`,
      [taskId],
    );
    return rows.map((row) => ({
      segmentId: row.segment_id,
      startMs: row.start_ms,
      endMs: row.end_ms,
      speechStartMs: row.speech_start_ms ?? undefined,
      text: row.text,
      confidence: row.confidence ?? undefined,
      episodeId: row.episode_id ?? undefined,
      episodeNo: row.episode_no ?? undefined,
      highlightType: (row.highlight_type as AsrSegment["highlightType"]) ?? undefined,
      highlightScore: row.highlight_score ?? undefined,
      highlightTags: row.highlight_tags
        ? row.highlight_tags.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      usableAsHook: row.usable_as_hook == null ? undefined : row.usable_as_hook === 1,
      speakerId: row.speaker_id ?? undefined,
      emotion: (row.emotion as AsrSegment["emotion"]) ?? undefined,
      sceneType: (row.scene_type as AsrSegment["sceneType"]) ?? undefined,
      labelSource: row.label_source ?? undefined,
    }));
  }

  private async loadRawSegments(taskId: string): Promise<RawAsrSegment[]> {
    const [rows] = await this.pool.query<RawSegmentRow[]>(
      `SELECT raw_id, sort_order, start_ms, end_ms, text, confidence
       FROM clip_asr_raw_segment WHERE task_id = ? ORDER BY sort_order ASC`,
      [taskId],
    );
    return rows.map((row) => ({
      id: row.raw_id,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
      confidence: row.confidence ?? undefined,
    }));
  }
}
