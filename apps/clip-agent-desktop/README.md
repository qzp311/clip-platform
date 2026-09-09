# drama-clip桌面端 (Tauri 2)

drama-clip · 短剧 AI 智能剪辑平台 — Windows 桌面端。一键安装后自动在后台运行，无需手动配置。

## 用户侧

1. 双击 `ClipAgent-0.3.0-x64.exe`
2. 按向导完成安装
3. 托盘图标出现即表示客户端已启动，首次使用请在托盘菜单设置 API 地址

## 开发者构建

**Windows 完整安装包（推荐）**

```powershell
cd clip-platform
npm install && npm run pack:win
# Inno Setup 编译 deploy/windows-packaging/ClipAgent.iss
```

`pack:win` 在 Windows 上会自动：
- 下载内置 Node.js + Python
- **预构建 FunASR venv 并打入安装包**（默认开启，用户无需再跑脚本）
- 编译 `clip-agent-desktop.exe` 并打入安装目录

打包机需联网；若预构建失败，安装向导与首次启动会自动重试配置。

**仅编译 Tauri 壳（需 Rust）**

```bash
# 先安装 Rust: https://rustup.rs/
cargo --version
npm run desktop
```

若 `npm run desktop` 报 `cargo metadata ... No such file or directory`，说明未安装 Rust 或未把 `~/.cargo/bin` 加入 PATH。

**Agent JS 热更新（无需 Rust）**

```bash
npm run pack:agent-hotfix -- 0.3.4
# 在管理台上传 zip 即可推送到 Windows Agent
```

## 托盘行为

- 安装后自动：注册设备 → 启动 Agent 守护进程
- 菜单：启动 / 停止 / 状态 / 退出
- 使用内置 `engines\node\node.exe`，不依赖系统 Node
