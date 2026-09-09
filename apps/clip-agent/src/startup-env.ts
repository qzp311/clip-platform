import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { probeFfmpegCapabilities, setFfmpegCapabilities, getFfmpegCapabilities } from "@clip/agent-core";
import type { FfmpegCapabilities } from "@clip/agent-core";
import type { AgentPaths } from "./paths.js";
import type { GpuCheckResult } from "./gpu-check.js";
import { loadInstallConfig } from "./config.js";

export async function ensureBundledFfmpegOnWindows(paths: AgentPaths): Promise<AgentPaths> {
  if (process.platform !== "win32") return paths;
  if (process.env.CLIP_SKIP_FFMPEG_AUTO_INSTALL === "1") {
    return paths;
  }

  const script = join(paths.repoRoot, "scripts", "ensure-ffmpeg-windows.mjs");
  if (!existsSync(script)) {
    console.warn(`[startup] 未找到 ${script}，无法自动安装 bundled FFmpeg`);
    return paths;
  }

  // 仅缺 bundled 时安装；NVENC 冒烟失败多为驱动 API 落后，重装 FFmpeg 无意义
  const needsInstall =
    paths.ffmpegPathSource !== "bundled_engines" || !existsSync(paths.ffmpegPath);

  if (!needsInstall) {
    return paths;
  }

  console.log(`[startup] bundled FFmpeg 缺失 → ${join(paths.installDir, "engines", "ffmpeg")}`);
  await new Promise<void>((resolve, reject) => {
    const args = [script, "--install-dir", paths.installDir];
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      cwd: paths.repoRoot,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ensure-ffmpeg-windows 退出码 ${code}`));
    });
  });

  const { resolveAgentPaths } = await import("./paths.js");
  return resolveAgentPaths({
    installDir: paths.installDir,
    ffmpegPath: process.env.CLIP_FFMPEG_PATH,
    funasrServerPath: paths.funasrServerPath,
    funasrModelsDir: paths.funasrModelsDir,
  });
}

/** 子进程（如 run-drama-mix）渲染前必须调用，避免未探测时盲目走 NVENC */
export async function ensureFfmpegCapabilitiesProbed(paths: AgentPaths): Promise<FfmpegCapabilities> {
  const existing = getFfmpegCapabilities();
  if (existing) return existing;
  const caps = await probeFfmpegCapabilities({
    ffmpegPath: paths.ffmpegPath,
    ffprobePath: paths.ffprobePath,
    pathSource: paths.ffmpegPathSource,
  });
  setFfmpegCapabilities(caps);
  console.log(
    `[ffmpeg] 能力探测: nvenc_smoke=${caps.nvencSmokeOk} gpu_pipeline=${caps.gpuPipelineOk} → ${
      caps.nvencSmokeOk ? "h264_nvenc" : "libx264"
    }`,
  );
  if (caps.warnings.length) {
    console.warn(`[ffmpeg] ${caps.warnings.join("; ").slice(0, 300)}`);
  }
  return caps;
}

export async function logAgentStartupEnvironment(
  paths: AgentPaths,
  gpu: GpuCheckResult,
): Promise<void> {
  const installConfig = loadInstallConfig(paths.repoRoot);
  const caps = await ensureFfmpegCapabilitiesProbed(paths);

  console.log("========== drama-clip Agent 启动环境 ==========");
  console.log(`主机: ${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown"}`);
  console.log(`系统: ${gpu.os} (${process.platform} ${process.arch})`);
  console.log(
    `GPU: ${gpu.gpuName} | 显存 ${gpu.vramMb}MB | 驱动 ${gpu.driverVersion ?? "unknown"} | ${gpu.supported ? "检测通过" : `未通过: ${gpu.reason ?? ""}`}`,
  );
  console.log(`安装目录: ${paths.installDir} (${paths.installDirSource})`);
  console.log(`数据目录: ${paths.dataRoot}`);
  console.log(`工作区: ${paths.workspaceDir}`);
  console.log(`日志: ${paths.logsDir}`);
  console.log(`配置: ${paths.configPath ?? "默认/环境变量"} | apiBase=${installConfig.apiBase}`);
  console.log(`凭据: ${paths.credentialsPath}`);
  console.log(`FFmpeg: ${caps.ffmpegPath} (${caps.pathSource}) v${caps.version}`);
  console.log(
    `FFmpeg 能力: h264_nvenc=${caps.h264Nvenc} cuda=${caps.cudaHwaccel} scale_cuda=${caps.scaleCuda} nvenc_smoke=${caps.nvencSmokeOk} gpu_pipeline=${caps.gpuPipelineOk}`,
  );
  console.log(`FFprobe: ${caps.ffprobePath}`);
  console.log(`FunASR: ${paths.funasrServerPath}`);
  console.log(`FunASR 模型: ${paths.funasrModelsDir}`);
  console.log(`Node: ${paths.nodePath}`);
  console.log(`Python: ${paths.pythonPath}`);
  if (caps.warnings.length) {
    console.warn(`FFmpeg 警告: ${caps.warnings.join("; ")}`);
  }
  const renderCodec = caps.nvencSmokeOk ? "h264_nvenc（硬编）" : "libx264（CPU 软编回退）";
  console.log(`渲染编码器: ${renderCodec}`);
  console.log("==========================================");
}
