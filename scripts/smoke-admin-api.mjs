#!/usr/bin/env node
/**
 * Smoke-test admin + core API endpoints against a running api-server.
 * Usage: node scripts/smoke-admin-api.mjs [baseUrl]
 */
const base = (process.argv[2] ?? process.env.CLIP_API_BASE ?? "http://127.0.0.1:8081").replace(/\/$/, "");

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: msg });
    console.error(`✗ ${name}: ${msg}`);
  }
}

async function json(path, init) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log(`[smoke] base=${base}`);

  await check("GET /health", async () => {
    const h = await json("/health");
    if (!h.ok) throw new Error("health not ok");
    if (!h.mysql) throw new Error("mysql not enabled");
  });

  await check("GET /admin/stats/devices/daily", async () => {
    const d = await json("/admin/stats/devices/daily");
    if (!Array.isArray(d.devices)) throw new Error("devices missing");
  });

  await check("GET /admin/devices", async () => {
    const d = await json("/admin/devices");
    if (!Array.isArray(d.devices)) throw new Error("devices missing");
  });

  await check("GET /admin/tasks", async () => {
    const d = await json("/admin/tasks");
    if (!Array.isArray(d.tasks)) throw new Error("tasks missing");
  });

  await check("GET /admin/asr-results", async () => {
    const d = await json("/admin/asr-results?limit=5");
    if (!Array.isArray(d.results)) throw new Error("results missing");
  });

  await check("GET /admin/config/global", async () => {
    const d = await json("/admin/config/global");
    if (!d.configVersion) throw new Error("configVersion missing");
  });

  await check("GET /admin/config/llm", async () => {
    await json("/admin/config/llm");
  });

  await check("GET /admin/asr-rule-sets", async () => {
    const d = await json("/admin/asr-rule-sets");
    if (!Array.isArray(d.ruleSets) || d.ruleSets.length === 0) throw new Error("no rule sets");
  });

  await check("GET /admin/dramas", async () => {
    const d = await json("/admin/dramas");
    if (!Array.isArray(d.dramas)) throw new Error("dramas missing");
  });

  await check("GET /admin/templates", async () => {
    const d = await json("/admin/templates");
    if (!Array.isArray(d.templates)) throw new Error("templates missing");
  });

  let retryTaskId = null;
  await check("POST /admin/tasks (create) + retry", async () => {
    const created = await json("/admin/tasks", {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: `${base}/oss/sources/demo.mp4`,
        dramaId: "drama-demo",
        templateId: "vertical_hook_60s",
      }),
    });
    if (!created.task?.taskId) throw new Error("create task failed");
    retryTaskId = created.task.taskId;

    await json(`/admin/tasks/${retryTaskId}`, { method: "GET" });

    const retried = await json(`/admin/tasks/${retryTaskId}/retry`, {
      method: "POST",
      body: "{}",
    });
    if (!retried.ok || retried.task?.status !== "pending") {
      throw new Error(`retry failed: ${JSON.stringify(retried)}`);
    }

    const detail = await json(`/admin/tasks/${retryTaskId}`);
    if (detail.status !== "pending") throw new Error(`status not pending: ${detail.status}`);
    if (detail.outputUrl) throw new Error(`outputUrl not cleared: ${detail.outputUrl}`);
    if (detail.mixRenders?.length) throw new Error("mixRenders not cleared");
  });

  await check("POST /admin/tasks/reset-demo", async () => {
    const d = await json("/admin/tasks/reset-demo", { method: "POST", body: "{}" });
    if (!d.ok) throw new Error("reset-demo failed");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
