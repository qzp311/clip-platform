import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ModelManifest } from "@clip/sdk";

export class ModelCdn {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  manifestPath(): string {
    return join(this.rootDir, "manifest.json");
  }

  loadManifest(): ModelManifest | null {
    const path = this.manifestPath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as ModelManifest;
  }

  saveManifest(manifest: ModelManifest): void {
    writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2));
  }

  buildManifest(apiBase: string): ModelManifest {
    const existing = this.loadManifest();
    if (existing) {
      return {
        ...existing,
        models: existing.models.map((m) => ({
          ...m,
          url: m.url.startsWith("http") ? m.url : `${apiBase}${m.url}`,
        })),
      };
    }

    return {
      version: "bootstrap",
      models: [
        {
          name: "paraformer-zh",
          url: `${apiBase}/cdn/models/paraformer-zh/model.onnx`,
          sha256: "0".repeat(64),
          sizeBytes: 0,
        },
      ],
    };
  }

  exists(objectKey: string): boolean {
    return existsSync(join(this.rootDir, objectKey));
  }

  resolvePath(objectKey: string): string {
    return join(this.rootDir, objectKey);
  }

  createReadStream(objectKey: string) {
    return createReadStream(this.resolvePath(objectKey));
  }

  static sha256File(path: string): string {
    const data = readFileSync(path);
    return createHash("sha256").update(data).digest("hex");
  }
}
