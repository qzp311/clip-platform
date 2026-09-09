import type { Pool, RowDataPacket } from "mysql2/promise";
import type { AgentServicesConfig, RenderConfig } from "@clip/sdk";
import { parseJson, toIso, toMysqlDate } from "./json.js";

export interface DeviceRow {
  deviceId: string;
  deviceToken: string;
  machineId: string;
  gpuName: string;
  vramMb: number;
  os: string;
  agentVersion: string;
  lastSeenAt: string;
  createdAt: string;
  boundUser?: string;
}

export interface DeviceConfigOverride {
  render?: RenderConfig;
  asrRuleSetId?: string;
  services?: AgentServicesConfig;
}

interface DeviceDbRow extends RowDataPacket {
  device_id: string;
  device_token: string;
  machine_id: string;
  gpu_name: string;
  vram_mb: number;
  os: string;
  agent_version: string;
  bound_user: string | null;
  last_seen_at: Date;
  created_at: Date;
}

interface DeviceConfigRow extends RowDataPacket {
  asr_rule_set_id: string | null;
  render_json: unknown;
  services_json: unknown;
}

export class DeviceMysqlRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<DeviceRow[]> {
    const [rows] = await this.pool.query<DeviceDbRow[]>(
      "SELECT * FROM clip_device ORDER BY last_seen_at DESC",
    );
    return rows.map((r) => this.mapDevice(r));
  }

  /** 启动 hydrate：一次拉取全部设备覆盖配置 */
  async listAllConfigOverrides(): Promise<Record<string, DeviceConfigOverride>> {
    const [rows] = await this.pool.query<(DeviceConfigRow & RowDataPacket)[]>(
      "SELECT device_id, asr_rule_set_id, render_json, services_json FROM clip_device_config",
    );
    const result: Record<string, DeviceConfigOverride> = {};
    for (const row of rows) {
      result[row.device_id] = {
        asrRuleSetId: row.asr_rule_set_id ?? undefined,
        render: parseJson<RenderConfig>(row.render_json),
        services: parseJson<AgentServicesConfig>(row.services_json),
      };
    }
    return result;
  }

  async findById(deviceId: string): Promise<DeviceRow | null> {
    const [rows] = await this.pool.query<DeviceDbRow[]>(
      "SELECT * FROM clip_device WHERE device_id = ? LIMIT 1",
      [deviceId],
    );
    return rows[0] ? this.mapDevice(rows[0]) : null;
  }

  async findByMachineId(machineId: string): Promise<DeviceRow | null> {
    const [rows] = await this.pool.query<DeviceDbRow[]>(
      "SELECT * FROM clip_device WHERE machine_id = ? LIMIT 1",
      [machineId],
    );
    return rows[0] ? this.mapDevice(rows[0]) : null;
  }

  async auth(deviceId: string, token: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT 1 FROM clip_device WHERE device_id = ? AND device_token = ? LIMIT 1",
      [deviceId, token],
    );
    return rows.length > 0;
  }

  async upsert(device: DeviceRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_device
        (device_id, device_token, machine_id, gpu_name, vram_mb, os, agent_version, bound_user, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        device_token = VALUES(device_token),
        gpu_name = VALUES(gpu_name),
        vram_mb = VALUES(vram_mb),
        os = VALUES(os),
        agent_version = VALUES(agent_version),
        bound_user = VALUES(bound_user),
        last_seen_at = VALUES(last_seen_at)`,
      [
        device.deviceId,
        device.deviceToken,
        device.machineId,
        device.gpuName,
        device.vramMb,
        device.os,
        device.agentVersion,
        device.boundUser ?? null,
        toMysqlDate(device.lastSeenAt),
        toMysqlDate(device.createdAt),
      ],
    );
  }

  async touch(deviceId: string, at = new Date()): Promise<void> {
    await this.pool.execute("UPDATE clip_device SET last_seen_at = ? WHERE device_id = ?", [
      at,
      deviceId,
    ]);
  }

  async getConfigOverride(deviceId: string): Promise<DeviceConfigOverride | null> {
    const [rows] = await this.pool.query<DeviceConfigRow[]>(
      "SELECT asr_rule_set_id, render_json, services_json FROM clip_device_config WHERE device_id = ?",
      [deviceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      asrRuleSetId: row.asr_rule_set_id ?? undefined,
      render: parseJson<RenderConfig>(row.render_json),
      services: parseJson<AgentServicesConfig>(row.services_json),
    };
  }

  async saveConfigOverride(deviceId: string, override: DeviceConfigOverride): Promise<void> {
    await this.pool.execute(
      `INSERT INTO clip_device_config (device_id, asr_rule_set_id, render_json, services_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         asr_rule_set_id = VALUES(asr_rule_set_id),
         render_json = VALUES(render_json),
         services_json = VALUES(services_json)`,
      [
        deviceId,
        override.asrRuleSetId ?? null,
        override.render ? JSON.stringify(override.render) : null,
        override.services ? JSON.stringify(override.services) : null,
      ],
    );
  }

  private mapDevice(row: DeviceDbRow): DeviceRow {
    return {
      deviceId: row.device_id,
      deviceToken: row.device_token,
      machineId: row.machine_id,
      gpuName: row.gpu_name,
      vramMb: row.vram_mb,
      os: row.os,
      agentVersion: row.agent_version,
      boundUser: row.bound_user ?? undefined,
      lastSeenAt: toIso(row.last_seen_at)!,
      createdAt: toIso(row.created_at)!,
    };
  }
}
