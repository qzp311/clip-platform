#!/usr/bin/env node
/**
 * 构建 clip-agent-desktop（Tauri 2，目标 Windows MSI）。
 * 需要 Rust 工具链；完整安装包请在 Windows 上执行 npm run pack:win。
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function findCargo() {
  const candidates = [
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, "bin", "cargo") : "",
    join(process.env.HOME ?? "", ".cargo", "bin", "cargo"),
    "cargo",
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin === "cargo") {
      const r = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
      if (r.status === 0) return "cargo";
      continue;
    }
    if (existsSync(bin)) return bin;
  }
  return null;
}

const cargo = findCargo();
if (!cargo) {
  console.error(`
[desktop] 未找到 Rust 工具链 (cargo)。

clip-agent-desktop 是 Tauri 2 应用，构建前必须安装 Rust：

  macOS / Linux:
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    source "$HOME/.cargo/env"

  Windows:
    访问 https://rustup.rs/ 安装 Rust，并安装 Visual Studio Build Tools。

安装完成后重新打开终端，执行:
  cargo --version
  npm run desktop

说明:
  - 安装包目标为 Windows MSI，完整打包请在 Windows 机器上运行 npm run pack:win
  - Agent JS 热更新修复可单独发布: npm run pack:agent-hotfix -- 0.3.4
`);
  process.exit(1);
}

try {
  execSync(`"${cargo}" --version`, { stdio: "inherit" });
} catch {
  console.error("[desktop] cargo 存在但无法执行，请检查 PATH 是否包含 ~/.cargo/bin");
  process.exit(1);
}

if (process.platform !== "win32") {
  console.warn(
    "[desktop] 当前为 macOS/Linux：tauri.conf.json 目标为 Windows MSI，" +
      "本地 tauri build 可能无法产出 MSI。Windows 安装包请使用: npm run pack:win",
  );
}

console.log("[desktop] building @clip/clip-agent-desktop …");
execSync("npm run build -w @clip/clip-agent-desktop", { cwd: root, stdio: "inherit" });
