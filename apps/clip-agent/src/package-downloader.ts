import { Transform } from "node:stream";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.CLIP_PACKAGE_DOWNLOAD_TIMEOUT_MS ?? THIRTY_MINUTES_MS,
);
const PROGRESS_LOG_INTERVAL_MS = 5000;

export interface PackageDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
}

function createProgressTracker(
  totalBytes: number,
  url: string,
  onProgress?: (progress: PackageDownloadProgress) => void,
): Transform {
  let downloaded = 0;
  let lastLogAt = 0;
  let lastNotifyAt = 0;
  const notify = () => {
    const progress: PackageDownloadProgress = {
      downloadedBytes: downloaded,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : null,
    };
    onProgress?.(progress);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      downloaded += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastNotifyAt >= 300) {
        lastNotifyAt = now;
        notify();
      }
      if (now - lastLogAt >= PROGRESS_LOG_INTERVAL_MS) {
        lastLogAt = now;
        const downloadedMb = (downloaded / 1024 / 1024).toFixed(1);
        if (totalBytes > 0) {
          const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
          const pct = Math.min(100, Math.round((downloaded / totalBytes) * 100));
          console.log(`[package-download] progress ${downloadedMb}/${totalMb} MB (${pct}%)`);
        } else {
          console.log(`[package-download] progress ${downloadedMb} MB downloaded`);
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      notify();
      const downloadedMb = (downloaded / 1024 / 1024).toFixed(1);
      console.log(`[package-download] finished streaming ${downloadedMb} MB from ${url}`);
      cb();
    },
  });
}

export async function downloadPackage(
  url: string,
  destPath: string,
  onProgress?: (progress: PackageDownloadProgress) => void,
): Promise<void> {
  console.log(`[package-download] downloadUrl=${url}`);
  console.log(`[package-download] saveTo=${destPath}`);

  await mkdir(dirname(destPath), { recursive: true });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[package-download] failed downloadUrl=${url} error=${detail}`);
    throw new Error(`download package failed: ${detail} (${url})`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    console.error(
      `[package-download] failed downloadUrl=${url} httpStatus=${res.status}${body ? ` body=${body}` : ""}`,
    );
    throw new Error(
      `download package failed: HTTP ${res.status} ${url}${body ? ` — ${body}` : ""}`,
    );
  }
  if (!res.body) {
    console.error(`[package-download] failed downloadUrl=${url} reason=empty response body`);
    throw new Error(`download package failed: empty body ${url}`);
  }

  const totalBytes = Number(res.headers.get("content-length") ?? 0);
  if (totalBytes > 0) {
    console.log(`[package-download] content-length=${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log("[package-download] content-length unknown, progress will report downloaded bytes only");
  }

  const nodeStream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  const progress = createProgressTracker(totalBytes, url, onProgress);
  await pipeline(nodeStream, progress, createWriteStream(destPath));
  const fileStat = await stat(destPath);
  console.log(
    `[package-download] ok downloadUrl=${url} bytes=${fileStat.size} saveTo=${destPath}`,
  );
}
