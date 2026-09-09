import type { Pool, RowDataPacket } from "mysql2/promise";
import type { BgmConfig, BgmTrackConfig } from "@clip/sdk";

export interface BgmSettings {
  enabled: boolean;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  loop: boolean;
}

export interface BgmTrackRow {
  trackId: number;
  name: string;
  url: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface SettingsRow extends RowDataPacket {
  settings_id: number;
  enabled: number;
  volume: number | string;
  fade_in_sec: number | string;
  fade_out_sec: number | string;
  loop_enabled: number;
}

interface TrackRow extends RowDataPacket {
  track_id: number;
  name: string;
  url: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const DEFAULT_SETTINGS: BgmSettings = {
  enabled: false,
  volume: 0.25,
  fadeInSec: 1,
  fadeOutSec: 2,
  loop: true,
};

function num(v: number | string | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function decodeNameFromUrl(url: string): string {
  try {
    const base = decodeURIComponent(url.split(/[\\/]/).pop()?.split("?")[0] || "");
    return base || "音频";
  } catch {
    return "音频";
  }
}

function mapSettings(row: SettingsRow | undefined): BgmSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled === 1,
    volume: num(row.volume, 0.25),
    fadeInSec: num(row.fade_in_sec, 1),
    fadeOutSec: num(row.fade_out_sec, 2),
    loop: row.loop_enabled !== 0,
  };
}

function mapTrack(row: TrackRow): BgmTrackRow {
  return {
    trackId: row.track_id,
    name: row.name ?? "",
    url: row.url,
    enabled: row.enabled === 1,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将表数据组装为 Agent / 管理台使用的 BgmConfig */
export function toBgmConfig(settings: BgmSettings, tracks: BgmTrackRow[]): BgmConfig {
  const active = tracks.filter((t) => t.enabled && t.url.trim());
  return {
    enabled: settings.enabled === true,
    tracks: active.map((t) => {
      const item: BgmTrackConfig = { url: t.url.trim() };
      const name = t.name.trim();
      if (name) item.name = name;
      return item;
    }),
    volume: settings.volume,
    fadeInSec: settings.fadeInSec,
    fadeOutSec: settings.fadeOutSec,
    loop: settings.loop,
  };
}

export class BgmMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async getSettings(): Promise<BgmSettings> {
    const [rows] = await this.pool.query<SettingsRow[]>(
      "SELECT * FROM clip_bgm_settings WHERE settings_id = 1 LIMIT 1",
    );
    return mapSettings(rows[0]);
  }

  async listTracks(): Promise<BgmTrackRow[]> {
    const [rows] = await this.pool.query<TrackRow[]>(
      "SELECT * FROM clip_bgm_track ORDER BY sort_order ASC, track_id ASC",
    );
    return rows.map(mapTrack);
  }

  /** Agent / 桌面端音频轨候选：启用且有 URL 的曲目 */
  async listAgentTracks(): Promise<Array<{ trackId: number; name: string; url: string }>> {
    const tracks = await this.listTracks();
    return tracks
      .filter((t) => t.enabled && String(t.url || "").trim())
      .map((t) => ({
        trackId: t.trackId,
        name: t.name.trim() || decodeNameFromUrl(t.url),
        url: t.url.trim(),
      }));
  }

  async getBgmConfig(): Promise<BgmConfig> {
    const [settings, tracks] = await Promise.all([this.getSettings(), this.listTracks()]);
    return toBgmConfig(settings, tracks);
  }

  async trackCount(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM clip_bgm_track",
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async saveSettings(settings: BgmSettings): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_bgm_settings
        (settings_id, enabled, volume, fade_in_sec, fade_out_sec, loop_enabled)
       VALUES (1, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         volume = VALUES(volume),
         fade_in_sec = VALUES(fade_in_sec),
         fade_out_sec = VALUES(fade_out_sec),
         loop_enabled = VALUES(loop_enabled)`,
      [
        settings.enabled ? 1 : 0,
        num(settings.volume, 0.25),
        num(settings.fadeInSec, 1),
        num(settings.fadeOutSec, 2),
        settings.loop !== false ? 1 : 0,
      ],
    );
  }

  /** 全量替换曲目列表（管理台保存） */
  async replaceTracks(tracks: BgmTrackConfig[]): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("DELETE FROM clip_bgm_track");
      let order = 0;
      for (const t of tracks) {
        const url = String(t.url ?? "").trim();
        if (!url) continue;
        await conn.execute(
          `INSERT INTO clip_bgm_track (name, url, enabled, sort_order)
           VALUES (?, ?, 1, ?)`,
          [String(t.name ?? "").trim(), url, order++],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async saveBgmConfig(bgm: BgmConfig): Promise<BgmConfig> {
    const tracks = Array.isArray(bgm.tracks)
      ? bgm.tracks
      : bgm.url
        ? [{ url: bgm.url, name: undefined }]
        : [];
    await this.saveSettings({
      enabled: bgm.enabled === true,
      volume: num(bgm.volume, 0.25),
      fadeInSec: num(bgm.fadeInSec, 1),
      fadeOutSec: num(bgm.fadeOutSec, 2),
      loop: bgm.loop !== false,
    });
    await this.replaceTracks(tracks);
    return this.getBgmConfig();
  }

  /**
   * 若表为空且 profile 里仍有旧 BGM，则迁移进表（一次性）。
   * @returns 是否发生了迁移
   */
  async migrateFromLegacy(bgm: BgmConfig | null | undefined): Promise<boolean> {
    if (!bgm) return false;
    const count = await this.trackCount();
    const settings = await this.getSettings();
    const hasLegacyTracks =
      (Array.isArray(bgm.tracks) && bgm.tracks.some((t) => String(t.url ?? "").trim())) ||
      Boolean(String(bgm.url ?? "").trim());
    // 已有曲目则不覆盖；仅当表无曲目且旧配置有候选时迁入
    if (count > 0 || !hasLegacyTracks) {
      // 仍可把 enabled/音量从旧配置补进空设置（仅在仍为默认关闭且旧配置开过）
      if (count === 0 && !hasLegacyTracks && bgm.enabled === true && !settings.enabled) {
        await this.saveSettings({
          enabled: true,
          volume: num(bgm.volume, settings.volume),
          fadeInSec: num(bgm.fadeInSec, settings.fadeInSec),
          fadeOutSec: num(bgm.fadeOutSec, settings.fadeOutSec),
          loop: bgm.loop !== false,
        });
        return true;
      }
      return false;
    }
    await this.saveBgmConfig(bgm);
    return true;
  }
}

/** 从 RenderConfig 中剥离 bgm，避免再写回 profile_json */
export function stripBgmFromRender<T extends { bgm?: BgmConfig }>(render: T): Omit<T, "bgm"> {
  const { bgm: _bgm, ...rest } = render;
  return rest;
}
