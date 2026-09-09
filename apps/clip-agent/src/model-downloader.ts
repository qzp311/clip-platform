import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export interface ModelManifestEntry {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface ModelManifest {
  version: string;
  provider?: string;
  models: ModelManifestEntry[];
}

export async function ensureModels(
  apiBase: string,
  headers: Record<string, string>,
  modelsDir: string,
): Promise<void> {
  await mkdir(modelsDir, { recursive: true });
  const manifestPath = join(modelsDir, "manifest.json");

  const res = await fetch(new URL("/agent/models/manifest", apiBase), { headers });
  if (!res.ok) throw new Error(`model manifest failed: ${res.status}`);
  const manifest = (await res.json()) as ModelManifest;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  for (const model of manifest.models) {
    const target = join(modelsDir, model.name);
    const marker = `${target}.sha256`;
    try {
      const existing = await readFile(marker, "utf-8");
      if (existing.trim() === model.sha256 && model.sha256 !== "0".repeat(64)) continue;
    } catch {
      // download
    }

    if (model.url.includes("example.com")) {
      console.log(`[models] skip placeholder model ${model.name}`);
      continue;
    }

    if (manifest.provider === "funasr-modelscope") {
      console.log(`[models] ${model.name}: FunASR ModelScope runtime download (CDN tracks version)`);
      await writeFile(marker, model.sha256 || "modelscope");
      continue;
    }

    console.log(`[models] downloading ${model.name}...`);
    const dl = await fetch(model.url);
    if (!dl.ok) throw new Error(`download ${model.name} failed: ${dl.status}`);
    await pipeline(dl.body!, createWriteStream(target));
    const hash = await sha256File(target);
    if (hash !== model.sha256) throw new Error(`sha256 mismatch for ${model.name}`);
    await writeFile(marker, model.sha256);
  }
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}
