import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DramaEpisodeRecord, DramaInfo, DramaMeta } from "@clip/sdk";
import { normalizeDramaMeta } from "@clip/sdk";
import { sqlLimitOffset } from "../pagination.js";
import { toIso, toMysqlDate } from "./json.js";

interface DramaRow extends RowDataPacket {
  drama_id: string;
  title: string;
  asr_rule_set_id: string;
  meta_json: unknown;
  remix_feature_object_key: string | null;
  remix_feature_fingerprint: string | null;
  remix_feature_size_bytes: number | null;
  remix_feature_frame_count: number | null;
  remix_feature_source_count: number | null;
  remix_feature_updated_at: Date | null;
}

export interface RemixFeatureCacheRecord {
  dramaId: string;
  objectKey: string;
  fingerprint: string;
  sizeBytes: number;
  frameCount: number;
  sourceCount: number;
  updatedAt: string;
}

interface EpisodeRow extends RowDataPacket {
  episode_id: string;
  drama_id: string;
  episode_no: number;
  title: string | null;
  source_url: string;
  status: DramaEpisodeRecord["status"];
  task_id: string | null;
  raw_segment_count: number | null;
  subtitle_url: string | null;
  subtitles_json_url: string | null;
  fail_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapMeta(raw: unknown): DramaMeta | undefined {
  const meta = normalizeDramaMeta(
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined,
  );
  return Object.keys(meta).length ? meta : undefined;
}

interface DramaListRow extends RowDataPacket {
  drama_id: string;
  title: string;
  asr_rule_set_id: string;
}

export class DramaMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async listDramas(): Promise<DramaInfo[]> {
    const [rows] = await this.pool.query<DramaRow[]>(
      "SELECT drama_id, title, asr_rule_set_id, meta_json FROM clip_drama ORDER BY drama_id",
    );
    return rows.map((r) => this.mapDrama(r));
  }

  async getRemixFeatureCache(dramaId: string): Promise<RemixFeatureCacheRecord | null> {
    const [rows] = await this.pool.query<DramaRow[]>(
      `SELECT drama_id, remix_feature_object_key, remix_feature_fingerprint,
              remix_feature_size_bytes, remix_feature_frame_count,
              remix_feature_source_count, remix_feature_updated_at
       FROM clip_drama
       WHERE drama_id = ? AND remix_feature_object_key IS NOT NULL
       LIMIT 1`,
      [dramaId],
    );
    const row = rows[0];
    if (!row || !row.remix_feature_object_key || !row.remix_feature_fingerprint) return null;
    return {
      dramaId: row.drama_id,
      objectKey: row.remix_feature_object_key,
      fingerprint: row.remix_feature_fingerprint,
      sizeBytes: Number(row.remix_feature_size_bytes ?? 0),
      frameCount: Number(row.remix_feature_frame_count ?? 0),
      sourceCount: Number(row.remix_feature_source_count ?? 0),
      updatedAt: toIso(row.remix_feature_updated_at) ?? new Date().toISOString(),
    };
  }

  async setRemixFeatureCache(record: RemixFeatureCacheRecord): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_drama
       SET remix_feature_object_key = ?,
           remix_feature_fingerprint = ?,
           remix_feature_size_bytes = ?,
           remix_feature_frame_count = ?,
           remix_feature_source_count = ?,
           remix_feature_updated_at = CURRENT_TIMESTAMP(3)
       WHERE drama_id = ?`,
      [
        record.objectKey,
        record.fingerprint,
        record.sizeBytes,
        record.frameCount,
        record.sourceCount,
        record.dramaId,
      ],
    );
  }

  async listDramasPage(
    limit: number,
    offset: number,
  ): Promise<{ dramas: DramaInfo[]; total: number; limit: number; offset: number }> {
    const [countRows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM clip_drama",
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    const [rows] = await this.pool.query<DramaListRow[]>(
      `SELECT drama_id, title, asr_rule_set_id
       FROM clip_drama ORDER BY drama_id${sqlLimitOffset(limit, offset)}`,
    );
    return {
      dramas: rows.map((r) => ({
        dramaId: r.drama_id,
        title: r.title,
        asrRuleSetId: r.asr_rule_set_id,
      })),
      total,
      limit,
      offset,
    };
  }

  /** 启动 hydrate：一次拉取全部分集，避免 N+1 */
  async listAllEpisodesGrouped(): Promise<Record<string, DramaEpisodeRecord[]>> {
    const [rows] = await this.pool.query<EpisodeRow[]>(
      "SELECT * FROM clip_drama_episode ORDER BY drama_id, episode_no ASC",
    );
    const grouped: Record<string, DramaEpisodeRecord[]> = {};
    for (const row of rows) {
      const episode = this.mapEpisode(row);
      (grouped[episode.dramaId] ??= []).push(episode);
    }
    return grouped;
  }

  async getDrama(dramaId: string): Promise<DramaInfo | null> {
    const [rows] = await this.pool.query<DramaRow[]>(
      "SELECT drama_id, title, asr_rule_set_id, meta_json FROM clip_drama WHERE drama_id = ? LIMIT 1",
      [dramaId],
    );
    const row = rows[0];
    if (!row) return null;
    return this.mapDrama(row);
  }

  /** 看板用：IN 批量取剧标题 */
  async listTitlesByIds(dramaIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!dramaIds.length) return result;
    const placeholders = dramaIds.map(() => "?").join(",");
    const [rows] = await this.pool.query<DramaRow[]>(
      `SELECT drama_id, title FROM clip_drama WHERE drama_id IN (${placeholders})`,
      dramaIds,
    );
    for (const r of rows) result.set(r.drama_id, r.title);
    return result;
  }

  async saveDrama(drama: DramaInfo): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_drama (drama_id, title, asr_rule_set_id, meta_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         asr_rule_set_id = VALUES(asr_rule_set_id),
         meta_json = VALUES(meta_json)`,
      [
        drama.dramaId,
        drama.title,
        drama.asrRuleSetId,
        drama.meta ? JSON.stringify(drama.meta) : null,
      ],
    );
  }

  async updateDramaMeta(dramaId: string, meta: DramaMeta): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_drama SET meta_json = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE drama_id = ?`,
      [JSON.stringify(normalizeDramaMeta(meta)), dramaId],
    );
  }

  private mapDrama(row: DramaRow): DramaInfo {
    return {
      dramaId: row.drama_id,
      title: row.title,
      asrRuleSetId: row.asr_rule_set_id,
      meta: mapMeta(row.meta_json),
    };
  }

  async listEpisodes(dramaId: string): Promise<DramaEpisodeRecord[]> {
    const [rows] = await this.pool.query<EpisodeRow[]>(
      `SELECT * FROM clip_drama_episode WHERE drama_id = ? ORDER BY episode_no ASC`,
      [dramaId],
    );
    return rows.map((r) => this.mapEpisode(r));
  }

  async saveEpisode(episode: DramaEpisodeRecord): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_drama_episode
        (episode_id, drama_id, episode_no, title, source_url, status, task_id,
         raw_segment_count, subtitle_url, subtitles_json_url, fail_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         source_url = VALUES(source_url),
         status = VALUES(status),
         task_id = VALUES(task_id),
         raw_segment_count = VALUES(raw_segment_count),
         subtitle_url = VALUES(subtitle_url),
         subtitles_json_url = VALUES(subtitles_json_url),
         fail_message = VALUES(fail_message),
         updated_at = VALUES(updated_at)`,
      [
        episode.episodeId,
        episode.dramaId,
        episode.episodeNo,
        episode.title ?? null,
        episode.sourceUrl,
        episode.status,
        episode.taskId ?? null,
        episode.rawSegmentCount ?? null,
        episode.subtitleUrl ?? null,
        episode.subtitlesJsonUrl ?? null,
        episode.failMessage ?? null,
        toMysqlDate(episode.createdAt),
        toMysqlDate(episode.updatedAt),
      ],
    );
  }

  async updateEpisodeAsr(
    dramaId: string,
    episodeId: string,
    patch: {
      status: DramaEpisodeRecord["status"];
      rawSegmentCount?: number | null;
      subtitleUrl?: string | null;
      subtitlesJsonUrl?: string | null;
      failMessage?: string | null;
    },
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE clip_drama_episode
       SET status = ?, raw_segment_count = ?, subtitle_url = ?, subtitles_json_url = ?,
           fail_message = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE drama_id = ? AND episode_id = ?`,
      [
        patch.status,
        patch.rawSegmentCount ?? null,
        patch.subtitleUrl ?? null,
        patch.subtitlesJsonUrl ?? null,
        patch.failMessage ?? null,
        dramaId,
        episodeId,
      ],
    );
  }

  async deleteEpisodesByDrama(dramaId: string): Promise<void> {
    await this.pool.execute("DELETE FROM clip_drama_episode WHERE drama_id = ?", [dramaId]);
  }

  async clearEpisodeSubtitles(dramaId: string, episodeIds: string[]): Promise<void> {
    if (!episodeIds.length) return;
    const placeholders = episodeIds.map(() => "?").join(",");
    await this.pool.execute(
      `UPDATE clip_drama_episode
       SET subtitle_url = NULL, subtitles_json_url = NULL, updated_at = NOW(3)
       WHERE drama_id = ? AND episode_id IN (${placeholders})`,
      [dramaId, ...episodeIds],
    );
  }

  private mapEpisode(row: EpisodeRow): DramaEpisodeRecord {
    return {
      episodeId: row.episode_id,
      dramaId: row.drama_id,
      episodeNo: row.episode_no,
      title: row.title ?? undefined,
      sourceUrl: row.source_url,
      status: row.status,
      taskId: row.task_id ?? undefined,
      rawSegmentCount: row.raw_segment_count ?? undefined,
      subtitleUrl: row.subtitle_url ?? undefined,
      subtitlesJsonUrl: row.subtitles_json_url ?? undefined,
      failMessage: row.fail_message ?? undefined,
      createdAt: toIso(row.created_at)!,
      updatedAt: toIso(row.updated_at)!,
    };
  }
}
