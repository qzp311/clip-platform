import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 清理并重建解压目录，避免旧脏数据/部分解压导致扫描为空 */
async function resetExtractDir(destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
}

async function dirHasAnyEntry(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function canRun(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ["--help"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 使用 PowerShell Expand-Archive；失败时把 stderr 带出来 */
async function extractWithPowerShell(zipPath: string, destDir: string): Promise<void> {
  const escapedZip = zipPath.replace(/'/g, "''");
  const escapedDest = destDir.replace(/'/g, "''");
  const script =
    `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `$err = $null;` +
    `try {` +
    `  [System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedZip}', '${escapedDest}');` +
    `} catch {` +
    `  Write-Error "EXTRACT_FAILED: $_";` +
    `  exit 1;` +
    `}`;
  try {
    await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PowerShell 解压失败: ${msg}`);
  }
}

async function extractWith7z(zipPath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync(
      "7z",
      ["x", zipPath, `-o${destDir}`, "-y", "-r"],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`7z 解压失败: ${msg}`);
  }
}

async function extractWithUnzip(zipPath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync("unzip", ["-o", zipPath, "-d", destDir], {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`unzip 解压失败: ${msg}`);
  }
}

export async function extractZipArchive(zipPath: string, destDir: string): Promise<void> {
  const zipStat = await stat(zipPath);
  if (!zipStat.isFile() || zipStat.size === 0) {
    throw new Error(`剧包压缩包不存在或为空: ${zipPath}`);
  }

  await resetExtractDir(destDir);

  const errors: string[] = [];

  if (process.platform === "win32") {
    if (await canRun("7z")) {
      try {
        await extractWith7z(zipPath, destDir);
        if (await dirHasAnyEntry(destDir)) return;
        errors.push("7z 解压后目录为空");
      } catch (err) {
        errors.push(String(err instanceof Error ? err.message : err));
      }
    }

    try {
      await extractWithPowerShell(zipPath, destDir);
      if (await dirHasAnyEntry(destDir)) return;
      errors.push("PowerShell 解压后目录为空");
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err));
    }
  } else {
    try {
      await extractWithUnzip(zipPath, destDir);
      if (await dirHasAnyEntry(destDir)) return;
      errors.push("unzip 解压后目录为空");
    } catch (err) {
      errors.push(String(err instanceof Error ? err.message : err));
    }
  }

  throw new Error(
    `剧包解压失败或解压后为空（${errors.length} 种方式均失败）: ${errors.join("; ")}`,
  );
}
