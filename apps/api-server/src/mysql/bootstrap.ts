import type { AsrRules, DramaEpisodeRecord, DramaInfo } from "@clip/sdk";
import type { ConfigMysqlRepository, ProfileState, UpdateManifestRow } from "./config-repository.js";
import type { DeviceMysqlRepository } from "./device-repository.js";
import type { DramaMysqlRepository } from "./drama-repository.js";
import type { TelemetryMysqlRepository } from "./telemetry-repository.js";
import type { AsrMysqlRepository } from "./asr-repository.js";
import type { DeviceRow } from "./device-repository.js";

export interface RuntimeCache {
  devices: DeviceRow[];
  ruleSets: Record<string, AsrRules>;
  dramas: Record<string, DramaInfo>;
  deviceOverrides: Record<
    string,
    { render?: import("@clip/sdk").RenderConfig; asrRuleSetId?: string; services?: import("@clip/sdk").AgentServicesConfig }
  >;
  profile: ProfileState;
  dramaEpisodes: Record<string, DramaEpisodeRecord[]>;
  updateManifest: UpdateManifestRow;
}

export interface MysqlRepos {
  device: DeviceMysqlRepository;
  config: ConfigMysqlRepository;
  drama: DramaMysqlRepository;
  telemetry: TelemetryMysqlRepository;
  asr: AsrMysqlRepository;
}

export interface MysqlDefaults {
  profile: ProfileState;
  ruleSets: Record<string, AsrRules>;
  dramas: DramaInfo[];
  updateManifest: UpdateManifestRow;
}

/** 空库时写入 schema 默认配置（不覆盖已有数据） */
export async function ensureMysqlDefaults(repos: MysqlRepos, defaults: MysqlDefaults): Promise<void> {
  if (!(await repos.config.getActiveProfile())) {
    await repos.config.saveActiveProfile(defaults.profile);
    console.log("[clip-api] seeded default profile in MySQL");
  }

  for (const [ruleSetId, rules] of Object.entries(defaults.ruleSets)) {
    if (!(await repos.config.getRuleSet(ruleSetId))) {
      await repos.config.saveRuleSet(ruleSetId, rules);
    }
  }

  for (const drama of defaults.dramas) {
    if (!(await repos.drama.getDrama(drama.dramaId))) {
      await repos.drama.saveDrama(drama);
    }
  }

  if (!(await repos.config.getUpdateManifest(defaults.updateManifest.platform))) {
    await repos.config.saveUpdateManifest(defaults.updateManifest);
  }
}

/** 从 MySQL 加载运行时内存缓存 */
export async function hydrateFromMysql(repos: MysqlRepos): Promise<RuntimeCache> {
  const profile = await repos.config.getActiveProfile();
  if (!profile) {
    throw new Error("[clip-api] No active profile in MySQL. Run deploy/mysql/init.sql first.");
  }

  const ruleEntries = await repos.config.listRuleSets();
  const ruleSets: Record<string, AsrRules> = {};
  for (const entry of ruleEntries) {
    ruleSets[entry.ruleSetId] = entry.rules;
  }

  const dramasList = await repos.drama.listDramas();
  const dramas: Record<string, DramaInfo> = {};
  const episodesByDrama = await repos.drama.listAllEpisodesGrouped();
  const dramaEpisodes: Record<string, DramaEpisodeRecord[]> = {};
  for (const drama of dramasList) {
    dramas[drama.dramaId] = drama;
    dramaEpisodes[drama.dramaId] = episodesByDrama[drama.dramaId] ?? [];
  }
  // 分集表有、剧目表缺失时仍装入内存，避免 listEpisodes 恒空导致混剪重复 ASR
  const fallbackRuleSetId = Object.keys(ruleSets)[0] ?? "drama-default-v1";
  for (const [dramaId, episodes] of Object.entries(episodesByDrama)) {
    if (dramaEpisodes[dramaId]) continue;
    dramaEpisodes[dramaId] = episodes;
    if (!dramas[dramaId]) {
      dramas[dramaId] = {
        dramaId,
        title: dramaId,
        asrRuleSetId: fallbackRuleSetId,
      };
    }
  }

  const devices = await repos.device.list();
  const deviceOverrides = await repos.device.listAllConfigOverrides();

  const updateManifest =
    (await repos.config.getUpdateManifest("win-x64-4060")) ?? {
      platform: "win-x64-4060",
      version: "0.3.0",
      downloadUrl: "",
      sha256: "0".repeat(64),
      mandatory: false,
      releaseNotes: "",
    };

  return {
    devices,
    ruleSets,
    dramas,
    deviceOverrides,
    profile,
    dramaEpisodes,
    updateManifest,
  };
}
