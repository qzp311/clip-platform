import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { join, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AUTOCLIP_OUTPUT_FILE_RE } from "@clip/sdk";

export const ASR_ARTIFACT_FILENAMES = [
  "subtitles.json",
  "subtitles.srt",
  "raw-subtitles.json",
] as const;

export class LocalOss {
  constructor(private readonly rootDir: string) {
    mkdirSync(join(rootDir, "sources"), { recursive: true });
    mkdirSync(join(rootDir, "sources", "packages"), { recursive: true });
    mkdirSync(join(rootDir, "outputs"), { recursive: true });
  }

  get publicRoot(): string {
    return this.rootDir;
  }

  async seedDemoSource(sourceFile: string, objectKey = "sources/demo.mp4"): Promise<string> {
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await copyFile(sourceFile, target);
    return objectKey;
  }

  async saveBase64Upload(taskId: string, filename: string, contentBase64: string): Promise<string> {
    const safeName = basename(filename).replace(/[^\w.\-]+/g, "_");
    const objectKey = `outputs/${taskId}/${safeName || `${randomUUID()}.mp4`}`;
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(contentBase64, "base64"));
    return objectKey;
  }

  /** 流式写入并返回 sha256（用于 Agent 热更新包） */
  async saveStreamWithSha256(objectKey: string, stream: Readable): Promise<{ objectKey: string; sha256: string; sizeBytes: number }> {
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const write = createWriteStream(target);
    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    await pipeline(stream, write);
    return { objectKey, sha256: hash.digest("hex"), sizeBytes };
  }

  /** 流式写入成片（multipart 上传，避免 base64 膨胀与超时） */
  async saveStreamUpload(taskId: string, filename: string, stream: Readable): Promise<string> {
    const safeName = basename(filename).replace(/[^\w.\-]+/g, "_");
    const objectKey = `outputs/${taskId}/${safeName || `${randomUUID()}.mp4`}`;
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await pipeline(stream, createWriteStream(target));
    return objectKey;
  }

  /**
   * 清理本地 ASR 字幕文件（识别结果仅存 MySQL）。
   * 若任务目录内无成片 mp4，则删除整个 outputs/{taskId}/ 目录；
   * 若有成片，则只删遗留的识别文件。
   */
  async deleteAsrArtifacts(taskId: string): Promise<string[]> {
    const relDir = `outputs/${taskId}`;
    const taskDir = join(this.rootDir, relDir);
    if (!existsSync(taskDir)) return [];

    const entries = await readdir(taskDir);
    const hasClipOutput = entries.some((name) => AUTOCLIP_OUTPUT_FILE_RE.test(name));
    if (!hasClipOutput) {
      await rm(taskDir, { recursive: true, force: true });
      return [`${relDir}/`];
    }

    const removed: string[] = [];
    for (const filename of ASR_ARTIFACT_FILENAMES) {
      const objectKey = `${relDir}/${filename}`;
      const target = this.resolvePath(objectKey);
      if (!existsSync(target)) continue;
      await unlink(target);
      removed.push(objectKey);
    }
    return removed;
  }

  async saveTextArtifact(taskId: string, filename: string, content: string): Promise<string> {
    const safeName = basename(filename).replace(/[^\w.\-]+/g, "_");
    const objectKey = `outputs/${taskId}/${safeName}`;
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
    return objectKey;
  }

  async saveSourceUpload(filename: string, contentBase64: string): Promise<string> {
    const safeName = basename(filename).replace(/[^\w.\-]+/g, "_");
    const objectKey = `sources/${Date.now()}_${safeName || `${randomUUID()}.mp4`}`;
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(contentBase64, "base64"));
    return objectKey;
  }

  /** 剧级 zip 原片包，使用服务端分配的唯一包名作为对象键 */
  async savePackageUpload(packageName: string, contentBase64: string): Promise<string> {
    const safeName = basename(packageName).replace(/[^\w.\-]+/g, "_");
    if (!safeName.toLowerCase().endsWith(".zip")) {
      throw new Error("package must be a .zip file");
    }
    const objectKey = `sources/packages/${safeName}`;
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(contentBase64, "base64"));
    return objectKey;
  }

  async saveBytes(objectKey: string, data: Buffer): Promise<string> {
    const target = join(this.rootDir, objectKey);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, data);
    return objectKey;
  }

  resolvePath(objectKey: string): string {
    return join(this.rootDir, objectKey);
  }

  exists(objectKey: string): boolean {
    return existsSync(this.resolvePath(objectKey));
  }

  createReadStream(objectKey: string) {
    return createReadStream(this.resolvePath(objectKey));
  }

  toPublicUrl(apiBase: string, objectKey: string): string {
    const base = apiBase.replace(/\/$/, "");
    return `${base}/oss/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  parsePublicUrl(apiBase: string, url: string): string | null {
    const prefix = `${apiBase.replace(/\/$/, "")}/oss/`;
    if (!url.startsWith(prefix)) return null;
    return decodeURIComponent(url.slice(prefix.length));
  }

  async readAsBuffer(objectKey: string): Promise<Buffer> {
    return readFile(this.resolvePath(objectKey));
  }
}
