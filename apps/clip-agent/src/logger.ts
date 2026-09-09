import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentPaths } from "./paths.js";

let logFilePath: string | null = null;
let installed = false;

export function agentLogPath(): string {
  if (!logFilePath) {
    logFilePath = join(resolveAgentPaths().logsDir, "agent.log");
  }
  return logFilePath;
}

export async function initAgentLogger(): Promise<string> {
  if (installed) return agentLogPath();

  const { logsDir } = resolveAgentPaths();
  await mkdir(logsDir, { recursive: true });
  logFilePath = join(logsDir, "agent.log");

  const writeLine = (level: string, args: unknown[]) => {
    const msg = args
      .map((a) => (typeof a === "string" ? sanitizeLogText(a) : JSON.stringify(a)))
      .join(" ");
    const line = `[${formatLogTimestamp(new Date())}] [${level}] ${msg}\n`;
    appendFile(logFilePath!, line, "utf8").catch(() => {});
  };

  const mirrorStdout = process.env.CLIP_LOG_TO_STDOUT !== "false" && !process.env.CLIP_DESKTOP_MANAGED;

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    writeLine("INFO", args);
    if (mirrorStdout) origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeLine("WARN", args);
    if (mirrorStdout) origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeLine("ERROR", args);
    if (mirrorStdout) origErr(...args);
  };

  installed = true;
  console.log(`logging to ${logFilePath}`);
  return logFilePath;
}

function formatLogTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${YYYY}年${MM}月${DD}日 ${hh}:${mm}:${ss}.${ms}`;
}

/** Keep agent.log valid UTF-8 for the desktop console (Windows sidecar may emit GBK-ish bytes). */
function sanitizeLogText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFFFD/g, "?");
}
