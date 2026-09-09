export function parseJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

/**
 * 列表/接口展示用时间：与库内 DATETIME 墙钟一致，不做 UTC 二次转换。
 * 形如 `2026-07-17 11:04:52.931`（无 Z / 无 T）。
 */
export function toIso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    // 兼容旧缓存的 ISO：去掉 T/Z，保留墙钟数字
    return s
      .replace("T", " ")
      .replace(/Z$/i, "")
      .replace(/([+-]\d{2}:\d{2})$/, "")
      .trim();
  }
  // Date：按进程本地墙钟格式化（服务器 Asia/Shanghai）
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`
  );
}

/** 写入 MySQL DATETIME：接受展示串或 Date，得到可绑定的 Date（按东八区理解） */
export function toMysqlDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const s = value.trim();
  if (!s) return null;
  // 已是带时区的 ISO
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s) || s.includes("T")) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // 库墙钟 `YYYY-MM-DD HH:mm:ss[.sss]` → 按东八区解析
  const d = new Date(s.replace(" ", "T") + "+08:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function jsonStringify(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}
