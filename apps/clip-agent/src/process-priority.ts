import { spawn } from "node:child_process";
import type { ResourceProcessPriority } from "@clip/sdk";

/** Windows：把指定 PID 设为 BelowNormal / Normal，失败则静默忽略 */
export async function setWindowsProcessPriority(
  pid: number,
  priority: ResourceProcessPriority,
): Promise<void> {
  if (process.platform !== "win32" || !Number.isFinite(pid) || pid <= 0) return;
  const cls = priority === "below_normal" ? "BelowNormal" : "Normal";
  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `try { (Get-Process -Id ${pid}).PriorityClass = '${cls}' } catch {}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/** 将当前 Node 进程优先级下调（限流档） */
export async function applyAgentProcessPriority(
  priority: ResourceProcessPriority,
): Promise<void> {
  await setWindowsProcessPriority(process.pid, priority);
}
