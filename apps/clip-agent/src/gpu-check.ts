import { spawn } from "node:child_process";

export interface GpuCheckResult {
  supported: boolean;
  gpuName: string;
  vramMb: number;
  driverVersion?: string;
  os: string;
  reason?: string;
}

const MIN_VRAM_MB = 7500;
const MIN_DRIVER_MAJOR = 522;

export async function checkGpu4060(): Promise<GpuCheckResult> {
  const os = detectOs();

  if (process.platform !== "win32") {
    return {
      supported: true,
      gpuName: "dev-non-windows",
      vramMb: 8192,
      os,
      reason: "dev mode: GPU check skipped on non-Windows",
    };
  }

  if (!os.includes("Windows 11") && !process.env.CLIP_SKIP_OS_CHECK) {
    return {
      supported: false,
      gpuName: "unknown",
      vramMb: 0,
      os,
      reason: "MVP 仅支持 Windows 11",
    };
  }

  try {
    const smi = await runCommand("nvidia-smi", [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader,nounits",
    ]);
    const line = smi.trim().split("\n")[0] ?? "";
    const [name, vram, driver] = line.split(",").map((p) => p.trim());
    const vramMb = Number(vram) || 0;
    const driverMajor = parseInt((driver ?? "0").split(".")[0] ?? "0", 10);

    if (!/NVIDIA|RTX|GTX|Quadro/i.test(name ?? "")) {
      return {
        supported: false,
        gpuName: name ?? "unknown",
        vramMb,
        os,
        reason: `仅支持 NVIDIA 显卡，当前: ${name}`,
      };
    }

    if (vramMb < MIN_VRAM_MB) {
      return {
        supported: false,
        gpuName: name ?? "unknown",
        vramMb,
        os,
        reason: `显存不足: ${vramMb}MB，需要 >= 8GB`,
      };
    }

    if (driverMajor < MIN_DRIVER_MAJOR && !process.env.CLIP_SKIP_DRIVER_CHECK) {
      return {
        supported: false,
        gpuName: name ?? "unknown",
        vramMb,
        os,
        reason: `驱动版本过低: ${driver}，需要 >= ${MIN_DRIVER_MAJOR}`,
      };
    }

    return { supported: true, gpuName: name ?? "NVIDIA", vramMb, driverVersion: driver, os };
  } catch (err) {
    return {
      supported: false,
      gpuName: "unknown",
      vramMb: 0,
      os,
      reason: `无法检测 NVIDIA GPU: ${err instanceof Error ? err.message : err}`,
    };
  }
}

export async function assertGpu4060(): Promise<GpuCheckResult> {
  const result = await checkGpu4060();
  if (!result.supported && !process.env.CLIP_SKIP_GPU_CHECK) {
    throw new Error(result.reason ?? "GPU not supported");
  }
  return result;
}

function detectOs(): string {
  const release = process.env.OS ?? "";
  if (release.includes("Windows 11")) return "Windows 11";
  if (process.platform === "win32") return "Windows 11";
  return `${process.platform} ${process.arch}`;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed: ${stderr.slice(-300)}`));
    });
  });
}
