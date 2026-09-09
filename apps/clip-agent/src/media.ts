import { spawn } from "node:child_process";
import { extname } from "node:path";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
  ".ts",
  ".mpeg",
  ".mpg",
]);

export function isVideoExtension(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function assertVideoFile(filePath: string): void {
  if (!isVideoExtension(filePath)) {
    const ext = extname(filePath) || "(无扩展名)";
    throw new Error(
      `不支持的素材格式 ${ext}，请上传视频文件（mp4/mov/mkv 等）。图片文件无法提取音轨做 ASR。`,
    );
  }
}

export async function assertHasAudioStream(
  filePath: string,
  ffprobePath = "ffprobe",
): Promise<void> {
  const probe = await runProbe(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    filePath,
  ]).catch(() => "");

  if (probe.trim().includes("audio")) return;

  throw new Error(
    `素材不含音轨，无法做语音识别：${filePath}。请上传带音频的视频文件。`,
  );
}

function runProbe(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.slice(-500) || `ffprobe exited ${code}`));
    });
  });
}
