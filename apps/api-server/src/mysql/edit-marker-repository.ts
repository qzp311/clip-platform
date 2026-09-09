import type { Pool, RowDataPacket } from "mysql2/promise";

export type EditMarkerHighlightType = "hook" | "conflict" | "twist" | "cliff";

export interface EditMarker {
  markerId: number;
  taskId?: string;
  sourcePath: string;
  deviceId: string;
  startMs: number;
  endMs: number;
  label: string;
  highlightType?: EditMarkerHighlightType;
  usableAsHook?: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface MarkerRow extends RowDataPacket {
  marker_id: number;
  task_id: string | null;
  source_path: string;
  device_id: string;
  start_ms: number;
  end_ms: number;
  label: string;
  highlight_type: string | null;
  usable_as_hook: number | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const HIGHLIGHT_TYPES = new Set(["hook", "conflict", "twist", "cliff"]);

function normalizeHighlightType(raw: string | null | undefined): EditMarkerHighlightType | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  return HIGHLIGHT_TYPES.has(t) ? (t as EditMarkerHighlightType) : undefined;
}

const map = (r: MarkerRow): EditMarker => ({
  markerId: r.marker_id,
  taskId: r.task_id ?? undefined,
  sourcePath: r.source_path,
  deviceId: r.device_id,
  startMs: Number(r.start_ms),
  endMs: Number(r.end_ms),
  label: r.label,
  highlightType: normalizeHighlightType(r.highlight_type),
  usableAsHook: r.usable_as_hook == null ? undefined : Boolean(r.usable_as_hook),
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class EditMarkerMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: Omit<EditMarker, "markerId" | "createdAt" | "updatedAt">,
  ): Promise<EditMarker> {
    const highlightType = normalizeHighlightType(input.highlightType);
    const usableAsHook =
      input.usableAsHook === true || highlightType === "hook" ? 1 : input.usableAsHook === false ? 0 : null;
    const [result] = await this.pool.execute(
      `INSERT INTO clip_edit_marker
        (task_id, source_path, device_id, start_ms, end_ms, label, highlight_type, usable_as_hook, source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.taskId ?? null,
        input.sourcePath,
        input.deviceId,
        input.startMs,
        input.endMs,
        input.label,
        highlightType ?? null,
        usableAsHook,
        input.source,
      ],
    );
    const id = Number((result as { insertId?: number }).insertId);
    const [rows] = await this.pool.query<MarkerRow[]>(
      "SELECT * FROM clip_edit_marker WHERE marker_id=?",
      [id],
    );
    return map(rows[0]!);
  }

  async list(input: {
    sourcePath?: string;
    sourcePaths?: string[];
    taskId?: string;
    taskIds?: string[];
    deviceId?: string;
    sourcePathContains?: string[];
  }): Promise<EditMarker[]> {
    const w: string[] = [];
    const p: Array<string | number> = [];
    if (input.sourcePath) {
      w.push("source_path=?");
      p.push(input.sourcePath);
    }
    if (input.sourcePaths?.length) {
      w.push(`source_path IN (${input.sourcePaths.map(() => "?").join(",")})`);
      p.push(...input.sourcePaths);
    }
    if (input.sourcePathContains?.length) {
      const likes = input.sourcePathContains.map(() => "source_path LIKE ?");
      w.push(`(${likes.join(" OR ")})`);
      for (const sub of input.sourcePathContains) {
        p.push(`%${sub}%`);
      }
    }
    if (input.taskId) {
      w.push("task_id=?");
      p.push(input.taskId);
    }
    if (input.taskIds?.length) {
      w.push(`task_id IN (${input.taskIds.map(() => "?").join(",")})`);
      p.push(...input.taskIds);
    }
    if (input.deviceId) {
      w.push("device_id=?");
      p.push(input.deviceId);
    }
    const [rows] = await this.pool.query<MarkerRow[]>(
      `SELECT * FROM clip_edit_marker${w.length ? ` WHERE ${w.join(" AND ")}` : ""} ORDER BY start_ms ASC`,
      p,
    );
    return rows.map(map);
  }

  /** 孤儿标记回绑到当前分集 ASR taskId */
  async updateTaskId(markerId: number, taskId: string): Promise<boolean> {
    const [result] = await this.pool.execute(
      `UPDATE clip_edit_marker SET task_id=?, updated_at=NOW(3) WHERE marker_id=?`,
      [taskId, markerId],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
  }

  /** 按路径+起止时间匹配（允许 ±80ms），删人工标记。跨设备共享：不限定 device_id */
  async deleteByRange(input: {
    deviceId?: string;
    sourcePath: string;
    startMs: number;
    endMs: number;
  }): Promise<number> {
    const [result] = await this.pool.execute(
      `DELETE FROM clip_edit_marker
       WHERE source_path=? AND source='human'
         AND ABS(start_ms - ?) <= 80 AND ABS(end_ms - ?) <= 80`,
      [input.sourcePath, input.startMs, input.endMs],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  /** 按 markerId 精确删除（云端标记跨设备删除用） */
  async deleteById(markerId: number): Promise<number> {
    const [result] = await this.pool.execute(
      "DELETE FROM clip_edit_marker WHERE marker_id=? AND source='human'",
      [markerId],
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  /** 按路径+旧起止时间匹配后更新区间/类型。跨设备共享：不限定 device_id */
  async updateByRange(input: {
    deviceId?: string;
    sourcePath: string;
    oldStartMs: number;
    oldEndMs: number;
    startMs: number;
    endMs: number;
    label?: string;
    highlightType?: EditMarkerHighlightType;
    usableAsHook?: boolean;
  }): Promise<EditMarker | null> {
    const highlightType = normalizeHighlightType(input.highlightType);
    const usableAsHook =
      input.usableAsHook === true || highlightType === "hook"
        ? 1
        : input.usableAsHook === false
          ? 0
          : null;
    const [result] = await this.pool.execute(
      `UPDATE clip_edit_marker
       SET start_ms=?, end_ms=?,
           label=COALESCE(?, label),
           highlight_type=COALESCE(?, highlight_type),
           usable_as_hook=COALESCE(?, usable_as_hook)
       WHERE source_path=? AND source='human'
         AND ABS(start_ms - ?) <= 80 AND ABS(end_ms - ?) <= 80
       LIMIT 1`,
      [
        input.startMs,
        input.endMs,
        input.label?.trim() || null,
        highlightType ?? null,
        usableAsHook,
        input.sourcePath,
        input.oldStartMs,
        input.oldEndMs,
      ],
    );
    if (!Number((result as { affectedRows?: number }).affectedRows ?? 0)) return null;
    const rows = await this.list({
      sourcePath: input.sourcePath,
    });
    return (
      rows.find(
        (m) =>
          Math.abs(m.startMs - input.startMs) <= 80 && Math.abs(m.endMs - input.endMs) <= 80,
      ) ?? null
    );
  }
}
