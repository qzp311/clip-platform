import type { Pool, RowDataPacket } from "mysql2/promise";
import type { AgentServicesConfig, AsrRules, EffectiveConfig, RenderConfig } from "@clip/sdk";
import { parseJson } from "./json.js";

export type ProfileState = Omit<EffectiveConfig, "asr" | "services"> & {
  asr: Omit<EffectiveConfig["asr"], "rules">;
  /** 全局服务开关与资源策略（写入 profile_json.services） */
  services?: AgentServicesConfig;
};

export interface UpdateManifestRow {
  version: string;
  platform: string;
  downloadUrl: string;
  sha256: string;
  mandatory: boolean;
  releaseNotes: string;
  /** 增量包下载 URL */
  incrementalUrl?: string;
  /** 增量包 sha256 */
  incrementalSha256?: string;
}

interface ProfileRow extends RowDataPacket {
  profile_key: string;
  config_version: string;
  profile_json: unknown;
}

interface RuleRow extends RowDataPacket {
  rule_set_id: string;
  rule_set_version: string;
  rules_json: unknown;
}

interface ManifestRow extends RowDataPacket {
  platform: string;
  version: string;
  download_url: string;
  sha256: string;
  mandatory: number;
  release_notes: string | null;
}

export class ConfigMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async getActiveProfile(): Promise<ProfileState | null> {
    const [rows] = await this.pool.query<ProfileRow[]>(
      "SELECT profile_key, config_version, profile_json FROM clip_config_profile WHERE is_active = 1 LIMIT 1",
    );
    const row = rows[0];
    if (!row) return null;
    const parsed = parseJson<Record<string, unknown>>(row.profile_json);
    if (!parsed) return null;
    const asr = parseJson<ProfileState["asr"]>(parsed.asr) ?? (parsed.asr as ProfileState["asr"]);
    const render = parseJson<RenderConfig>(parsed.render) ?? (parsed.render as RenderConfig);
    const services =
      parseJson<AgentServicesConfig>(parsed.services) ??
      (parsed.services as AgentServicesConfig | undefined);
    return {
      configVersion: String(parsed.configVersion ?? row.config_version),
      profile: String(parsed.profile ?? row.profile_key),
      asr: asr ?? { models: { asr: "paraformer-zh" }, runtime: { device: "cuda:0" } },
      render: render ?? { encode: { codec: "h264_nvenc" }, limits: {} },
      services,
    };
  }

  async saveActiveProfile(profile: ProfileState, profileKey = "gpu_4060_standard"): Promise<void> {
    const profileJson = {
      profile: profile.profile,
      configVersion: profile.configVersion,
      asr: profile.asr,
      render: profile.render,
      services: profile.services,
    };
    await this.pool.execute(
      `INSERT INTO clip_config_profile (profile_key, config_version, profile_json, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE config_version = VALUES(config_version), profile_json = VALUES(profile_json), is_active = 1`,
      [profileKey, profile.configVersion, JSON.stringify(profileJson)],
    );
  }

  async listRuleSets(): Promise<Array<{ ruleSetId: string; rules: AsrRules }>> {
    const [rows] = await this.pool.query<RuleRow[]>(
      "SELECT rule_set_id, rule_set_version, rules_json FROM clip_asr_rule_set ORDER BY rule_set_id",
    );
    return rows.map((row) => {
      const rules =
        parseJson<AsrRules>(row.rules_json) ??
        ({ ruleSetId: row.rule_set_id, ruleSetVersion: row.rule_set_version } as AsrRules);
      return {
        ruleSetId: row.rule_set_id,
        rules: { ...rules, ruleSetId: row.rule_set_id, ruleSetVersion: row.rule_set_version },
      };
    });
  }

  async getRuleSet(ruleSetId: string): Promise<AsrRules | null> {
    const [rows] = await this.pool.query<RuleRow[]>(
      "SELECT rule_set_id, rule_set_version, rules_json FROM clip_asr_rule_set WHERE rule_set_id = ? LIMIT 1",
      [ruleSetId],
    );
    const row = rows[0];
    if (!row) return null;
    const rules = parseJson<AsrRules>(row.rules_json);
    if (!rules) return { ruleSetId: row.rule_set_id, ruleSetVersion: row.rule_set_version };
    return { ...rules, ruleSetId: row.rule_set_id, ruleSetVersion: row.rule_set_version };
  }

  async saveRuleSet(ruleSetId: string, rules: AsrRules): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_asr_rule_set (rule_set_id, rule_set_version, rules_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE rule_set_version = VALUES(rule_set_version), rules_json = VALUES(rules_json)`,
      [ruleSetId, rules.ruleSetVersion, JSON.stringify(rules)],
    );
  }

  async getUpdateManifest(platform: string): Promise<UpdateManifestRow | null> {
    const [rows] = await this.pool.query<ManifestRow[]>(
      "SELECT * FROM clip_agent_update_manifest WHERE platform = ? LIMIT 1",
      [platform],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      platform: row.platform,
      version: row.version,
      downloadUrl: row.download_url,
      sha256: row.sha256,
      mandatory: row.mandatory === 1,
      releaseNotes: row.release_notes ?? "",
      incrementalUrl: row.incremental_url ?? undefined,
      incrementalSha256: row.incremental_sha256 ?? undefined,
    };
  }

  async saveUpdateManifest(manifest: UpdateManifestRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_agent_update_manifest (platform, version, download_url, sha256, mandatory, release_notes, incremental_url, incremental_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         version = VALUES(version),
         download_url = VALUES(download_url),
         sha256 = VALUES(sha256),
         mandatory = VALUES(mandatory),
         release_notes = VALUES(release_notes),
         incremental_url = VALUES(incremental_url),
         incremental_sha256 = VALUES(incremental_sha256)`,
      [
        manifest.platform,
        manifest.version,
        manifest.downloadUrl,
        manifest.sha256,
        manifest.mandatory ? 1 : 0,
        manifest.releaseNotes,
        manifest.incrementalUrl ?? null,
        manifest.incrementalSha256 ?? null,
      ],
    );
  }
}
