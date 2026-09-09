import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { resolveMysqlConfig, type MysqlConfig } from "./config.js";

let pool: Pool | null = null;

export function getMysqlPool(): Pool | null {
  return pool;
}

export async function initMysqlPool(config?: MysqlConfig): Promise<Pool | null> {
  const resolved = config ?? resolveMysqlConfig();
  if (!resolved) return null;

  pool = mysql.createPool({
    host: resolved.host,
    port: resolved.port,
    user: resolved.user,
    password: resolved.password,
    database: resolved.database,
    waitForConnections: true,
    connectionLimit: 50,
    // 库内 DATETIME 按东八区墙钟存储（与 @@time_zone=+08:00 / NOW() 一致）
    timezone: "+08:00",
    // 读出时直接用库内字符串，避免 Date↔UTC 二次换算导致列表时间对不上
    dateStrings: true,
    charset: "utf8mb4",
  });

  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  return pool;
}

export async function closeMysqlPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
