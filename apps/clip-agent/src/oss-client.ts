import { copyFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { EffectiveConfig } from "@clip/sdk";
import { resolveUploadDestination, shouldUploadToTos } from "@clip/sdk";
import { uploadOutputVideoToTos } from "./tos-client.js";
import { ensureTaskLocalOutputDir, resolveLocalOutputRoot } from "./local-output.js";

/** 长混剪成片可达数百 MB，上传+服务端落盘需足够长的超时 */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export interface UploadOutputOptions {
  apiBase: string;
  headers: Record<string, string>;
  taskId: string;
  outputPath: string;
  filename?: string;
  config: EffectiveConfig;
  /** 对象 key 中的目录段：TOS 直传时按短剧名归档 */
  folderSegment?: string;
  /** 抽封面用 ffmpeg 路径 */
  ffmpegPath?: string;
  /** 探测帧率用 ffprobe 路径 */
  ffprobePath?: string;
  /** 上传完成后是否保留本地成片；默认 false（上传 TOS 后删除本地文件） */
  keepLocalAfterUpload?: boolean;
}

/** 按配置将成片直传 TOS；TOS 未配置时由调用方保留本地不上传 */
export async function uploadOutputVideo(options: UploadOutputOptions): Promise<string> {
  const filename = options.filename ?? "output.mp4";
  if (!shouldUploadToTos(options.config)) {
    throw new Error("uploadOutputVideo called while TOS upload is not configured");
  }
  console.log("[upload] Agent 直传 TOS");
  return uploadOutputVideoToTos(options.config, {
    taskId: options.taskId,
    outputPath: options.outputPath,
    filename,
    folderSegment: options.folderSegment,
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
  });
}

async function forceRemoveWithRetry(path: string, retries = 3, delayMs = 500): Promise<void> {
  const lastErr: Error[] = [];
  for (let i = 0; i <= retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr[0] = err instanceof Error ? err : new Error(msg);
      if (i < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr[0] ?? new Error(`forceRemove failed: ${path}`);
}

/**
 * 上传成片后清理本地文件。
 * - keepLocalAfterUpload=true：归档到本地成片目录并保留
 * - 默认 keepLocalAfterUpload=false：上传成功后删除本地成片文件
 * 注意：只删除成片文件（outputPath），不删除源素材。
 * 返回 { url, localPath }：localPath 为成片最终本地位置（归档后即归档路径）。
 */
export async function uploadOutputVideoAndDelete(
  options: UploadOutputOptions,
): Promise<{ url: string; localPath: string }> {
  const url = await uploadOutputVideo(options);
  const tag = resolveUploadDestination(options.config) === "local" ? "local" : "upload";
  const src = resolve(options.outputPath);

  if (options.keepLocalAfterUpload) {
    const outputRoot = resolve(resolveLocalOutputRoot(options.config));
    const keepDir = resolve(await ensureTaskLocalOutputDir(options.config, options.taskId));
    const keepPath = resolve(join(keepDir, options.filename || basename(options.outputPath)));
    const srcUnderOutputRoot =
      src === outputRoot || src.startsWith(outputRoot + "\\") || src.startsWith(outputRoot + "/");

    try {
      if (src === keepPath || srcUnderOutputRoot) {
        console.log(`[${tag}] 上传完成，已保留本地成片: ${src}`);
        return { url, localPath: src };
      }
      try {
        await rename(src, keepPath);
      } catch {
        await copyFile(src, keepPath);
        await forceRemoveWithRetry(src).catch(() => {});
      }
      console.log(`[${tag}] 上传完成，已保留本地成片: ${keepPath}`);
      return { url, localPath: keepPath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${tag}] 归档本地成片失败，保留原路径 ${src}: ${msg.slice(0, 200)}`);
      return { url, localPath: src };
    }
  }

  try {
    await forceRemoveWithRetry(src);
    console.log(`[${tag}] 上传完成，已删除本地成片: ${src}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${tag}] 上传完成，删除本地成片失败 ${src}: ${msg.slice(0, 200)}`);
  }
  return { url, localPath: src };
}
