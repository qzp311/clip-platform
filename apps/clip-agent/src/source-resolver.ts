import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClipLocalSourceUrl } from "@clip/sdk";

export async function resolveSourceVideo(sourceUrl: string, workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  const dest = join(workspace, "source.mp4");

  const clipLocal = parseClipLocalSourceUrl(sourceUrl);
  if (clipLocal) {
    await access(clipLocal);
    return clipLocal;
  }

  if (/^https?:\/\//i.test(sourceUrl)) {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`download source failed: ${res.status} ${sourceUrl}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buffer);
    return dest;
  }

  if (sourceUrl.startsWith("file://")) {
    if (sourceUrl.includes("placeholder")) {
      throw new Error(
        "task sourceUrl is a placeholder; run: curl -X POST http://127.0.0.1:8081/admin/api/tasks/reset-demo",
      );
    }

    const localPath = resolveFileUrl(sourceUrl);
    await copyFile(localPath, dest);
    return dest;
  }

  if (sourceUrl.includes("placeholder")) {
    throw new Error(
      "task sourceUrl is a placeholder; run: curl -X POST http://127.0.0.1:8081/admin/api/tasks/reset-demo",
    );
  }

  await copyFile(sourceUrl, dest);
  return dest;
}

function resolveFileUrl(sourceUrl: string): string {
  try {
    return fileURLToPath(sourceUrl);
  } catch {
    const normalized = sourceUrl.replace(/^file:\/\//, "");
    const slashIndex = normalized.indexOf("/");
    if (slashIndex <= 0) throw new Error(`invalid file url: ${sourceUrl}`);
    return normalized.slice(slashIndex);
  }
}

export function guessOutputName(sourceUrl: string): string {
  const clipLocal = parseClipLocalSourceUrl(sourceUrl);
  if (clipLocal) {
    return basename(clipLocal);
  }
  if (sourceUrl.startsWith("file://")) {
    return basename(fileURLToPath(sourceUrl));
  }
  if (/^https?:\/\//i.test(sourceUrl)) {
    return basename(new URL(sourceUrl).pathname) || "source.mp4";
  }
  return basename(sourceUrl);
}
