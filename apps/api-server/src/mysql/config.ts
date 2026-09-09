export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function resolveMysqlConfig(): MysqlConfig | null {
  const url = process.env.CLIP_MYSQL_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ""),
      };
    } catch {
      throw new Error("invalid CLIP_MYSQL_URL");
    }
  }

  const host = process.env.CLIP_MYSQL_HOST?.trim();
  if (!host) return null;

  return {
    host,
    port: Number(process.env.CLIP_MYSQL_PORT ?? 3306),
    user: process.env.CLIP_MYSQL_USER?.trim() ?? "clip_platform",
    password: process.env.CLIP_MYSQL_PASSWORD ?? "",
    database: process.env.CLIP_MYSQL_DATABASE?.trim() ?? "clip_platform",
  };
}
