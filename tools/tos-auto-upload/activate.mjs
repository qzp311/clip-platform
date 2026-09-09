/**
 * 解析「短剧名称_短剧ID.zip」；取最后一个 _ 分隔
 * @returns {{ title: string, externalDramaId: string } | null}
 */
export function parseDramaZipFilename(filename) {
  const base = String(filename ?? "")
    .trim()
    .replace(/^.*[\\/]/, "")
    .replace(/\.zip$/i, "");
  const idx = base.lastIndexOf("_");
  if (idx <= 0 || idx >= base.length - 1) return null;
  const title = base.slice(0, idx).trim();
  const externalDramaId = base.slice(idx + 1).trim();
  if (!title || !externalDramaId) return null;
  return { title, externalDramaId };
}

/**
 * 把 fetch 原生错误转成可读信息
 * @param {unknown} err
 * @returns {string}
 */
function explainFetchError(err) {
  if (!(err instanceof Error)) return String(err ?? "unknown");
  const msg = err.message || "";
  // Node.js fetch 底层是 undici，常见错误文本
  if (/ECONNREFUSED/i.test(msg)) return `连接被拒绝：${msg}`;
  if (/ECONNRESET/i.test(msg)) return `连接被重置：${msg}`;
  if (/ETIMEDOUT|timeout/i.test(msg)) return `连接超时：${msg}`;
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return `DNS 解析失败：${msg}`;
  if (/ECONNABORTED/i.test(msg)) return `连接中断：${msg}`;
  return msg;
}

/**
 * 上传完成后：标记已上传 + 创建 drama_package 入库/混剪任务
 */
export async function activateDramaPackage(apiBase, payload) {
  const base = String(apiBase ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("apiBaseUrl not configured in config.json");
  }
  const url = `${base}/admin/api/drama-intake/activate-package`;
  // Node.js fetch 默认无超时，防止一直挂起
  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const detail = explainFetchError(err);
    throw new Error(`activate-package fetch failed: ${detail} (url=${url})`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`activate-package invalid json: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return body;
}
