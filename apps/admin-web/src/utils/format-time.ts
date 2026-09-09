/** 将接口时间按东八区墙钟解析（库内 DATETIME 无时区，与展示串一致） */
function parseDbWallClock(value: string): number {
  const s = value.trim();
  if (!s) return Number.NaN;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s) || s.includes("T")) {
    return new Date(s).getTime();
  }
  return new Date(s.replace(" ", "T") + "+08:00").getTime();
}

/** 相对时间；绝对展示请直接用接口返回的库墙钟字符串，勿再 toLocaleString */
export function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const then = parseDbWallClock(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return `${Math.max(0, diffSec)} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  // 超过一天：原样展示库时间（去掉多余毫秒也可）
  return iso.replace(/\.\d+$/, "").slice(0, 16);
}
