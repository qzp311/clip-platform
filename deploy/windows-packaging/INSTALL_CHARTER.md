# drama-clip Windows 一键安装包构建章程

本章程说明如何把仓库构建成可一键安装的 `ClipAgent-0.3.0-x64.exe`，安装包内含 Node.js、Python、FFmpeg、FunASR（GPU/CPU 自动适配）。

## 一、适用场景

- 目标系统：Windows 10 / Windows 11 64 位
- 目标用户：无开发环境，双击安装即可使用
- 构建机器：Windows 10/11 64 位，建议 NVIDIA 显卡（用于预构建 GPU 版 FunASR）

## 二、构建机依赖

以管理员身份打开 PowerShell，执行仓库内脚本一次性安装：

```powershell
cd d:\clip-platform\clip-platform
powershell -ExecutionPolicy Bypass -File scripts\install-windows-pack-deps.ps1
```

脚本会自动安装/校验：
1. Windows 长路径支持（避免 FunASR venv 路径超过 MAX_PATH）
2. Chocolatey
3. Node.js LTS
4. Rust（Tauri 桌面壳需要）
5. Inno Setup 6
6. WebView2 Runtime

> 若脚本提示需要重启，请保存工作后重启，然后继续。

## 三、环境准备（一次）

在 PowerShell 中进入仓库根目录：

```powershell
cd d:\clip-platform\clip-platform
```

检查 Node 与 npm：

```powershell
node -v
npm -v
```

## 四、正式构建

### 4.1 完整构建（推荐）

```powershell
npm install
npm run pack:win
```

`pack:win` 会依次完成：

1. `npm install`：安装仓库依赖
2. `npm run build`：编译所有 TypeScript/Rust
3. `node scripts/bootstrap.mjs`：准备 FFmpeg、FunASR Node 入口、模型清单
4. `node scripts/download-asr-models.mjs`：下载 ASR 模型索引
5. `node scripts/download-windows-runtimes.mjs`：下载内置 Node.js、Python 解释器
6. 预构建 FunASR venv（默认开启）：在打包机联网下载 PyTorch + FunASR，封入安装包
7. 构建 Tauri 桌面壳
8. Inno Setup 编译生成最终 exe

产物位置：

```
d:\clip-platform\clip-platform\deploy\windows-packaging\output\ClipAgent-0.3.0-x64.exe
```

### 4.2 跳过 FunASR venv 预构建（减小安装包体积，但用户安装时必须联网）

```powershell
$env:CLIP_PREBUILD_FUNASR_VENV="0"
npm run pack:win
```

## 五、安装包结构

安装目录示例 `C:\Program Files\ClipAgent\`：

```
ClipAgent/
├── clip-agent-desktop.exe      # 托盘入口
├── clip-agent/                 # Node 主程序
├── clip-agent.cmd              # 命令行调试入口
├── config.json
├── engines/
│   ├── node/node.exe           # 内置 Node.js
│   ├── python/                 # 内置 Python 3.11
│   ├── ffmpeg/                 # 内置 FFmpeg（含 NVENC）
│   └── funasr/
│       ├── venv/               # 预构建的 FunASR 虚拟环境
│       ├── wheels/             # sentencepiece 离线 wheel（急救用）
│       ├── runtime/            # VC++ CRT 运行时
│       └── dist/               # Node sidecar 入口
├── packages/                   # @clip/* 运行时包
├── scripts/                    # 激活/修复脚本
└── data/cdn/models/            # 模型清单
```

## 六、安装流程（用户侧）

1. 用户双击 `ClipAgent-0.3.0-x64.exe`
2. 安装程序释放文件
3. 安装程序检测 GPU：
   - 有 NVIDIA 显卡且显存 ≥ 4GB → 启用 `funasr-gpu`
   - 否则 → 启用 `funasr-cpu`
4. 安装程序优先执行 `scripts\activate-funasr-engine.ps1` 做离线激活（几秒完成）
5. 若预构建的 venv 损坏或缺失，则弹出 PowerShell 窗口运行 `scripts\setup-funasr-bundled.ps1` 联网重新安装（3–8 分钟）
6. 完成后自动启动托盘程序

## 七、常见问题与修复

### 7.1 安装时卡在「正在配置 AI 语音引擎」

原因多为网络波动导致 PyTorch/FunASR 下载失败。

解决方案：

1. 重试一次安装
2. 或切换为离线完整包：构建时不要设置 `CLIP_PREBUILD_FUNASR_VENV=0`

### 7.2 安装完成后启动托盘，AI 识别失败

打开 PowerShell（管理员），进入安装目录执行修复：

```powershell
cd "C:\Program Files\ClipAgent"
powershell -ExecutionPolicy Bypass -File scripts\activate-funasr-engine.ps1
```

若仍失败，执行急救修复：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\repair-funasr-venv.ps1
```

### 7.3 sentencepiece 加载崩溃（0xC0000005）

执行 sentencepiece 专用修复脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\repair-funasr-sentencepiece.ps1
```

### 7.4 日志查看

日志路径：

```
%LOCALAPPDATA%\ClipAgent\logs\funasr-setup.log
%LOCALAPPDATA%\ClipAgent\logs\agent.log
```

## 八、构建产物验证

构建成功后，在干净 Windows 虚拟机或未安装开发环境的机器上测试：

1. 双击 exe 完成安装
2. 托盘启动后右键「设置」或打开日志
3. 查看日志中是否有 `[funasr-gpu] model ready` 或 `[funasr-cpu] model ready`
4. 使用系统自带 NVIDIA 控制面板检查 GPU 是否被调用（GPU 模式）

## 九、章程变更记录

- 2026-08：改为默认预构建 FunASR venv 并封入安装包，用户端优先离线激活，失败才联网兜底。
- 2026-08：修复 `funasr_gpu_server.py` 语法错误；安装向导优先调用 `activate-funasr-engine.ps1`。
