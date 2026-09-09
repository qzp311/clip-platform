/** 修正常见的 193.168.x.x → 192.168.x.x 手误 */
export function suggestApiBaseFix(apiBase: string): string | null {
  if (/^https?:\/\/193\.168\./i.test(apiBase)) {
    return apiBase.replace(/^(https?:\/\/)193\.168\./i, "$1192.168.");
  }
  return null;
}

export function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  const fixed = suggestApiBaseFix(trimmed);
  if (fixed && fixed !== trimmed) {
    console.warn(`[clip-agent] API 地址疑似 typo，已自动修正: ${trimmed} -> ${fixed}`);
    return fixed;
  }
  return trimmed;
}

export function formatApiConnectError(err: unknown, apiBase: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b401\b/.test(message) || /invalid device token/i.test(message)) {
    return (
      `API ${apiBase} 拒绝了 device token（401）。` +
      `常见原因：MySQL 重建/换库后服务端设备表已清空，但 Agent 仍使用旧 credentials.json。` +
      `Agent 将自动重新注册；若仍失败，请删除 credentials.json 后重启 Agent。`
    );
  }

  const cause =
    err instanceof Error && err.cause && typeof err.cause === "object"
      ? (err.cause as NodeJS.ErrnoException)
      : undefined;

  const code = cause?.code;
  if (code === "ECONNREFUSED") {
    return (
      `无法连接 API ${apiBase}（连接被拒绝）。` +
      `请确认 clip-api 已启动（默认 http://127.0.0.1:8081），或在桌面控制台填写正确的服务端地址。`
    );
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return (
      `连接 API ${apiBase} 超时。` +
      `请检查：1) 服务端 IP/端口是否正确（常见误填 193.168 → 192.168）；` +
      `2) 防火墙是否放行 8081；3) 服务端是否在本机或局域网可达。`
    );
  }

  return `无法连接 API ${apiBase}: ${message}`;
}

export async function waitForApiReachable(
  probe: () => Promise<void>,
  apiBase: string,
  options?: { intervalMs?: number; shouldContinue?: () => boolean },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 5000;
  while (options?.shouldContinue?.() ?? true) {
    try {
      await probe();
      return;
    } catch (err) {
      console.error(formatApiConnectError(err, apiBase));
      console.error(`[clip-agent] ${intervalMs / 1000}s 后重试连接 ${apiBase} ...`);
      await sleep(intervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
