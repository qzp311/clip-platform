import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DramaIntakeRecord, DramaIntakeStatus, DramaIntakeType } from "@clip/sdk";
import { sqlLimitOffset } from "../pagination.js";
import { toIso } from "./json.js";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "read",
  "downloaded",
  "uploaded",
  "queued",
  "ingesting",
  "ingested",
  "failed",
  "skipped",
]);

const VALID_DRAMA_TYPES: ReadonlySet<string> = new Set(["comic", "short", "paid_comic", "paid_short"]);

interface IntakeRow extends RowDataPacket {
  intake_id: string;
  external_drama_id: string;
  title: string;
  drama_type: DramaIntakeType;
  status: DramaIntakeStatus;
  note: string | null;
  synopsis: string | null;
  linked_task_id: string | null;
  linked_drama_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function assertDramaType(value: string): DramaIntakeType {
  if (!VALID_DRAMA_TYPES.has(value)) {
    throw new Error(`invalid drama intake type: ${value}`);
  }
  return value as DramaIntakeType;
}

function mapRow(row: IntakeRow): DramaIntakeRecord {
  return {
    intakeId: row.intake_id,
    externalDramaId: row.external_drama_id,
    title: row.title,
    dramaType: row.drama_type,
    status: row.status,
    synopsis: row.synopsis?.trim() ? row.synopsis.trim() : undefined,
    note: row.note ?? undefined,
    linkedTaskId: row.linked_task_id ?? undefined,
    linkedDramaId: row.linked_drama_id ?? undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

export class DramaIntakeMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async listPage(
    limit: number,
    offset: number,
    opts?: {
      status?: DramaIntakeStatus;
      dramaType?: DramaIntakeType;
      externalDramaId?: string;
      q?: string;
    },
  ): Promise<{
    items: DramaIntakeRecord[];
    total: number;
    limit: number;
    offset: number;
    statusCounts: Record<string, number>;
  }> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.dramaType) {
      where.push("drama_type = ?");
      params.push(opts.dramaType);
    }
    const externalDramaId = opts?.externalDramaId?.trim();
    if (externalDramaId) {
      where.push("external_drama_id = ?");
      params.push(externalDramaId);
    }
    const q = opts?.q?.trim();
    if (q) {
      where.push("(title LIKE ? OR external_drama_id LIKE ? OR synopsis LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM clip_drama_intake ${whereSql}`,
      params,
    );
    const total = Number(countRows[0]?.cnt ?? 0);

    const [rows] = await this.pool.query<IntakeRow[]>(
      `SELECT * FROM clip_drama_intake
       ${whereSql}
       ORDER BY updated_at DESC, created_at DESC${sqlLimitOffset(limit, offset)}`,
      params,
    );

    const [countByStatus] = await this.pool.query<RowDataPacket[]>(
      `SELECT status, COUNT(*) AS cnt FROM clip_drama_intake ${whereSql} GROUP BY status`,
      params,
    );
    const statusCounts: Record<string, number> = {};
    for (const row of countByStatus) {
      statusCounts[String(row.status)] = Number(row.cnt ?? 0);
    }

    return {
      items: rows.map(mapRow),
      total,
      limit,
      offset,
      statusCounts,
    };
  }

  /** 批量录入剧名、来源短剧 ID 与类型，跳过库内已存在及同批重复项 */
  async batchCreate(
    items: Array<{ title: string; externalDramaId: string; dramaType: DramaIntakeType }>,
  ): Promise<{
    created: DramaIntakeRecord[];
    duplicates: string[];
    /** 库内已存在的完整记录，供调用方判断是否可以自动触发建任务 */
    existingRecords: DramaIntakeRecord[];
  }> {
    if (!items.length) {
      return { created: [], duplicates: [], existingRecords: [] };
    }

    const seen = new Set<string>();
    const normalized: Array<{ title: string; externalDramaId: string; dramaType: DramaIntakeType }> =
      [];
    const duplicates: string[] = [];
    for (const item of items) {
      const externalDramaId = item.externalDramaId.trim();
      if (!externalDramaId) continue;
      if (seen.has(externalDramaId)) {
        duplicates.push(externalDramaId);
        continue;
      }
      seen.add(externalDramaId);
      normalized.push({
        title: item.title.trim(),
        externalDramaId,
        dramaType: assertDramaType(item.dramaType),
      });
    }
    if (!normalized.length) {
      return { created: [], duplicates, existingRecords: [] };
    }

    const ids = normalized.map((item) => item.externalDramaId);
    const placeholders = ids.map(() => "?").join(", ");
    const [existingRows] = await this.pool.query<IntakeRow[]>(
      `SELECT * FROM clip_drama_intake WHERE external_drama_id IN (${placeholders})`,
      ids,
    );
    const existingRecords = existingRows.map(mapRow);
    const existingSet = new Set(existingRecords.map((row) => row.externalDramaId));
    for (const item of normalized) {
      if (existingSet.has(item.externalDramaId)) {
        duplicates.push(item.externalDramaId);
      }
    }

    const toInsert = normalized.filter((item) => !existingSet.has(item.externalDramaId));
    if (!toInsert.length) {
      return { created: [], duplicates, existingRecords };
    }

    const now = new Date();
    const nowDisplay = toIso(now)!;
    const records: DramaIntakeRecord[] = toInsert.map((item) => ({
      intakeId: randomUUID(),
      externalDramaId: item.externalDramaId,
      title: item.title,
      dramaType: item.dramaType,
      status: "pending",
      createdAt: nowDisplay,
      updatedAt: nowDisplay,
    }));

    const valuePlaceholders = records.map(() => "(?, ?, ?, ?, 'pending', ?, ?)").join(", ");
    const insertParams = records.flatMap((record) => [
      record.intakeId,
      record.externalDramaId,
      record.title,
      record.dramaType,
      now,
      now,
    ]);
    await this.pool.execute(
      `INSERT INTO clip_drama_intake
        (intake_id, external_drama_id, title, drama_type, status, created_at, updated_at)
       VALUES ${valuePlaceholders}`,
      insertParams,
    );

    return { created: records, duplicates, existingRecords };
  }

  async findByExternalId(externalDramaId: string): Promise<DramaIntakeRecord | null> {
    const id = externalDramaId.trim();
    if (!id) return null;
    const [rows] = await this.pool.query<IntakeRow[]>(
      "SELECT * FROM clip_drama_intake WHERE external_drama_id = ? LIMIT 1",
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** 按入库后的内部 drama_id 反查清单（简介/类型在 intake 表） */
  async findByLinkedDramaId(linkedDramaId: string): Promise<DramaIntakeRecord | null> {
    const id = linkedDramaId.trim();
    if (!id) return null;
    const [rows] = await this.pool.query<IntakeRow[]>(
      `SELECT * FROM clip_drama_intake
       WHERE linked_drama_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** 批量按内部 drama_id 反查清单，避免前端 N 部剧触发 N 次查询 */
  async findByLinkedDramaIds(linkedDramaIds: string[]): Promise<DramaIntakeRecord[]> {
    const ids = [...new Set(linkedDramaIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const [rows] = await this.pool.query<IntakeRow[]>(
      `SELECT * FROM clip_drama_intake
       WHERE linked_drama_id IN (?)
       ORDER BY linked_drama_id, updated_at DESC`,
      [ids],
    );
    // 每组取最新一条（updated_at 降序后首个）
    const seen = new Set<string>();
    return rows.filter((row) => {
      const id = String(row.linked_drama_id || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(mapRow);
  }

  async updateByExternalId(
    externalDramaId: string,
    patch: {
      status?: DramaIntakeStatus;
      dramaType?: DramaIntakeType;
      synopsis?: string | null;
      note?: string | null;
      linkedTaskId?: string | null;
      linkedDramaId?: string | null;
    },
  ): Promise<DramaIntakeRecord | null> {
    const found = await this.findByExternalId(externalDramaId);
    if (!found) return null;
    return this.update(found.intakeId, patch);
  }

  async updateSynopsisByExternalId(
    externalDramaId: string,
    synopsis: string,
  ): Promise<DramaIntakeRecord | null> {
    const id = externalDramaId.trim();
    // 简介可空：空字符串写入 null
    const text = synopsis.trim() || null;
    if (!id) throw new Error("external drama id required");

    const [result] = await this.pool.execute(
      `UPDATE clip_drama_intake
       SET synopsis = ?, status = 'downloaded'
       WHERE external_drama_id = ?`,
      [text, id],
    );
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    if (!affected) return null;

    const [rows] = await this.pool.query<IntakeRow[]>(
      "SELECT * FROM clip_drama_intake WHERE external_drama_id = ? LIMIT 1",
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async update(
    intakeId: string,
    patch: {
      status?: DramaIntakeStatus;
      dramaType?: DramaIntakeType;
      synopsis?: string | null;
      note?: string | null;
      linkedTaskId?: string | null;
      linkedDramaId?: string | null;
    },
  ): Promise<DramaIntakeRecord | null> {
    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (patch.status !== undefined) {
      if (!VALID_STATUSES.has(patch.status)) {
        throw new Error(`invalid drama intake status: ${patch.status}`);
      }
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.dramaType !== undefined) {
      sets.push("drama_type = ?");
      params.push(assertDramaType(patch.dramaType));
    }
    if (patch.synopsis !== undefined) {
      const text = patch.synopsis?.trim() ? patch.synopsis.trim() : null;
      sets.push("synopsis = ?");
      params.push(text);
      // 回填简介视为已进入已下载流程
      if (text && patch.status === undefined) {
        sets.push("status = ?");
        params.push("downloaded");
      }
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      params.push(patch.note?.trim() ? patch.note.trim() : null);
    }
    if (patch.linkedTaskId !== undefined) {
      sets.push("linked_task_id = ?");
      params.push(patch.linkedTaskId?.trim() ? patch.linkedTaskId.trim() : null);
    }
    if (patch.linkedDramaId !== undefined) {
      sets.push("linked_drama_id = ?");
      params.push(patch.linkedDramaId?.trim() ? patch.linkedDramaId.trim() : null);
    }
    if (!sets.length) {
      const [rows] = await this.pool.query<IntakeRow[]>(
        "SELECT * FROM clip_drama_intake WHERE intake_id = ? LIMIT 1",
        [intakeId],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    }

    params.push(intakeId);
    const [result] = await this.pool.execute(
      `UPDATE clip_drama_intake SET ${sets.join(", ")} WHERE intake_id = ?`,
      params,
    );
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    if (!affected) return null;

    const [rows] = await this.pool.query<IntakeRow[]>(
      "SELECT * FROM clip_drama_intake WHERE intake_id = ? LIMIT 1",
      [intakeId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async delete(intakeId: string): Promise<boolean> {
    const [result] = await this.pool.execute("DELETE FROM clip_drama_intake WHERE intake_id = ?", [
      intakeId,
    ]);
    return ((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }
}
