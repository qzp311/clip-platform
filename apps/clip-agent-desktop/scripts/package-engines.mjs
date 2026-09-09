#!/usr/bin/env node
/**
 * 打包 clip-agent-desktop 前把运行时 engines 复制到 src-tauri 旁，
 * 供 Tauri resources 打进 NSIS 安装包。
 * 来源优先从环境变量 CLIP_PACKAGE_ENGINES 或 D:\ClipAgent\engines 读取。
 */
import { cp, mkdir, existsSync, readdirSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcTauri = join(root, "src-tauri");
const targetEngines = join(srcTauri, "engines");
const sourceEngines =
  process.env.CLIP_PACKAGE_ENGINES?.trim() ||
  "D:\\ClipAgent\\engines";

function copyFilteredEngines(src, dest) {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });

  // 同步复制顶层目录，但跳过 funasr/venv（体积巨大、路径超长，会导致 Tauri/NSIS 打包卡死）
  const entries = readdirSync(src, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.name === "funasr" && entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      const sub = readdirSync(from, { withFileTypes: true });
      for (const s of sub) {
        if (s.name === "venv") continue; // 安装后自动下载
        const subFrom = join(from, s.name);
        const subTo = join(to, s.name);
        cpSync(subFrom, subTo, { recursive: true, dereference: true, force: true });
        copied++;
      }
    } else {
      cpSync(from, to, { recursive: true, dereference: true, force: true });
      copied++;
    }
  }
  return copied;
}

if (!existsSync(sourceEngines)) {
  console.warn(`[package-engines] source engines not found: ${sourceEngines}, skip bundle`);
  process.exit(0);
}

// 每次构建前清理旧 engines，避免残留已删除的 venv 或过期文件
try {
  if (existsSync(targetEngines)) {
    rmSync(targetEngines, { recursive: true, force: true });
  }
} catch (err) {
  console.warn(`[package-engines] cleanup target failed: ${err.message ?? err}`);
}
const copied = copyFilteredEngines(sourceEngines, targetEngines);
console.log(`[package-engines] copied ${copied} top-level items from ${sourceEngines} -> ${targetEngines} (skipped funasr/venv)`);
