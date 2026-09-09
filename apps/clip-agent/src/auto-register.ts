import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertGpu4060 } from "./gpu-check.js";
import { credentialsPath } from "./config.js";
import { detectGpuInfo } from "./gpu-info.js";
import { readEffectiveAgentVersion } from "./effective-version.js";

export async function credentialsExist(): Promise<boolean> {
  try {
    const raw = await readFile(credentialsPath(), "utf-8");
    const data = JSON.parse(raw) as { deviceId?: string; deviceToken?: string };
    return Boolean(data.deviceId && data.deviceToken);
  } catch {
    return false;
  }
}

export async function clearCredentials(): Promise<void> {
  try {
    await unlink(credentialsPath());
  } catch {
    // already absent
  }
}

export async function loadCredentials(): Promise<{ deviceId: string; deviceToken: string }> {
  const raw = await readFile(credentialsPath(), "utf-8");
  const data = JSON.parse(raw) as { deviceId?: string; deviceToken?: string };
  if (!data.deviceId || !data.deviceToken) {
    throw new Error("credentials.json missing deviceId or deviceToken");
  }
  return { deviceId: data.deviceId, deviceToken: data.deviceToken };
}

function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b/.test(message) || /invalid device token/i.test(message);
}

/** 注册并在 token 失效时自动用 machineId 重新换取服务端 token */
export async function ensureAuthenticated(
  apiBase: string,
  probe: (creds: { deviceId: string; deviceToken: string }) => Promise<void>,
): Promise<{ deviceId: string; deviceToken: string }> {
  await ensureRegistered(apiBase);
  let creds = await loadCredentials();
  try {
    await probe(creds);
    return creds;
  } catch (err) {
    if (!isAuthFailure(err)) throw err;
  }

  console.warn(
    "[clip-agent] 服务端拒绝当前 device token（401），将清除本地凭证并重新注册…",
  );
  await clearCredentials();
  await ensureRegistered(apiBase);
  creds = await loadCredentials();
  await probe(creds);
  return creds;
}

export async function ensureRegistered(apiBase: string): Promise<void> {
  if (await credentialsExist()) return;

  await assertGpu4060();
  const gpu = await detectGpuInfo();
  const machineId = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "win-4060-001";
  const agentVersion = await readEffectiveAgentVersion();

  const res = await fetch(new URL("/agent/devices/register", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId,
      gpuName: gpu.gpuName,
      vramMb: gpu.vramMb,
      os: gpu.os,
      agentVersion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`device register failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { deviceId: string; deviceToken: string };
  const credPath = credentialsPath();
  await mkdir(dirname(credPath), { recursive: true });
  await writeFile(credPath, JSON.stringify(data, null, 2));
  console.log(`registered device ${data.deviceId} (${gpu.gpuName}, ${gpu.vramMb}MB)`);
}
