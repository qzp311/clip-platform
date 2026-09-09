import { spawn } from "node:child_process";

export interface GpuInfo {
  gpuName: string;
  vramMb: number;
  os: string;
}

export async function detectGpuInfo(): Promise<GpuInfo> {
  const os = detectOs();
  if (process.platform !== "win32") {
    return { gpuName: "NVIDIA RTX 4060", vramMb: 8192, os };
  }

  try {
    const output = await runCommand("nvidia-smi", [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const line = output.trim().split("\n")[0] ?? "";
    const [name, vram] = line.split(",").map((part) => part.trim());
    if (name) {
      return {
        gpuName: name,
        vramMb: Number(vram) || 8192,
        os,
      };
    }
  } catch {
    // fall through to default 4060 profile
  }

  return { gpuName: "NVIDIA RTX 4060", vramMb: 8192, os };
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
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}
