# drama-clip · 短剧 AI 智能剪辑平台

开源的短剧批量二创剪辑平台：把整部短剧自动完成 **语音识别 → 智能选段 → 批量混剪 → 字幕/花字/贴纸/转场 → 直传 TOS** 的全流程处理，并提供 Web 管理台与 Windows 客户端。

- 服务端 / 管理台：TypeScript + Node.js + Fastify + Vue 3
- 剪辑引擎：FFmpeg（支持 NVIDIA NVENC 硬编）
- 语音识别：FunASR（Paraformer）Sidecar，本地推理，无外部 API 依赖
- 存储：MySQL（业务数据）+ 火山引擎 TOS（成片与素材，S3 兼容）

## 功能总览

| 模块 | 说明 |
|------|------|
| 短剧入库 | 上传整包 zip / 分集视频，自动建剧目与分集索引 |
| ASR 识别 | FunASR GPU 推理（本地），句级片段 + 规则引擎后处理 |
| 智能选段 | 本地混剪方案生成（按 ASR 台词与时长策略批量出方案，不依赖任何云端大模型） |
| 批量混剪 | 多轮多方案出片，跨集转场、竖屏适配、NVENC 加速 |
| 成片增强 | ASS 字幕烧录、BGM 混音、标题花字、贴纸、角标、免责声明 |
| 案例复刻 | 以案例视频为参照做视觉指纹匹配，复刻同款节奏成片，支持二次裂变 |
| TOS 直传 | Agent 渲染完成后直接上传火山引擎 TOS；未配置则成片保留本地 |
| Web 管理台 | 任务看板 / 设备管理 / 统计报表 / 系统配置 / 版本发布 |
| Windows 客户端 | Tauri 托盘程序 + Agent 常驻，自动注册设备、领取任务 |

## 仓库结构

```
clip-platform/
├── apps/
│   ├── api-server/          # Fastify API 服务（含管理台静态资源）
│   ├── admin-web/           # Vue 3 管理台
│   ├── funasr-server/       # FunASR ASR Sidecar
│   ├── clip-agent/          # Windows Agent CLI（任务执行主体）
│   └── clip-agent-desktop/  # Tauri 2 托盘壳（Windows）
├── packages/
│   ├── sdk/                 # 共享类型与工具（Task/Plan/Config 等）
│   ├── agent-core/          # 渲染引擎（FFmpeg 编排、规则引擎）
│   ├── clip-schema/         # JSON Schema + 默认配置
│   └── ffmpeg-templates/    # 渲染模板
├── deploy/
│   ├── mysql/init.sql       # 数据库一键初始化
│   ├── docker-compose.yml   # API + MySQL 本地编排
│   ├── windows-packaging/   # Windows 安装包构建
│   └── systemd/             # Linux systemd 部署
└── scripts/                 # 引导、演示、打包脚本
```

## 快速开始（本地开发）

环境要求：Node.js ≥ 20、MySQL 8（或用 Docker）、FFmpeg（渲染机需要）。

```bash
# 1. 安装依赖并构建全部包
npm install
npm run setup

# 2. 初始化数据库
mysql -u root -p < deploy/mysql/init.sql
# 或直接用 docker-compose 起 API + MySQL：
cd deploy && docker compose up -d

# 3. 启动 API（默认 http://127.0.0.1:8081，管理台挂在 /admin/）
npm run dev:api

# 4. 启动 ASR Sidecar（开发默认 VAD 后端）
npm run dev:funasr

# 5. 启动 Agent（另开终端）
npm run dev:agent
```

打开管理台：`http://127.0.0.1:8081/admin/`

开源版管理台无需登录：路由守卫会自动创建本地会话；生产部署时建议自行加一层网关鉴权（如 Basic Auth / OAuth2 Proxy）。

## 一键演示

```bash
npm install
npm run demo
```

## 配置说明

### 数据库（必配）

| 环境变量 | 说明 |
|----------|------|
| `CLIP_MYSQL_URL` | MySQL 连接串（`mysql://user:pass@host:3306/db`），优先 |
| `CLIP_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | 分项配置（未设 URL 时生效） |

### TOS 直传（可选）

在管理台 **系统配置 → 流水线 → TOS 上传** 中填写：

- endpoint / bucket / region / AccessKey / AccessSecret（支持 base64 编码存储）
- 对象键前缀、公网访问域名（可选）

上传行为：

- 勾选「渲染完成后上传成片」且 TOS 配置完整 → Agent 渲染完成后**直传 TOS**（对象键默认 `{短剧名}/{文件名}`，可用前缀自定义）
- 未开启上传或 TOS 未配置 → 成片保留在 Agent 本地目录（默认 `D:/ClipOutput`），不上传

### ASR 后端

| `CLIP_ASR_BACKEND` | 说明 |
|--------------------|------|
| `funasr-gpu` | 生产默认，FunASR + CUDA 本地推理（需 NVIDIA GPU） |
| `vad` | 开发默认，仅 VAD 切分（无 GPU 也能跑通流程） |
| `whisper` / `mock` | 本地 Whisper / 调试 Mock |

Windows GPU 环境一键配置：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-funasr-windows.ps1
```

首次运行会从 ModelScope 自动下载 paraformer-zh / fsmn-vad / ct-punc 模型到本地。

### 其他常用环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | API 监听端口（默认 8081） |
| `CLIP_ENV` | `test` / `production`，决定加载 `deploy/.env.*` |
| `CLIP_API_PUBLIC_BASE` | 对外公网地址（拼接下载 URL 用） |
| `CLIP_FFMPEG_PATH` / `CLIP_FFPROBE_PATH` | 自定义 FFmpeg 路径 |

## 管理台功能

- **仪表盘**：任务量/成功率趋势、设备概览
- **短剧管理**：剧目列表、分集与 ASR 结果、规则集绑定
- **任务看板**：单集直剪 / 混剪 / 整包 / 复刻任务的创建、重跑、方案编辑
- **案例复刻**：上传案例视频创建复刻任务，支持裂变数量与维度
- **系统配置**：渲染并发、转场、字幕/BGM/花字/贴纸/角标、TOS、资源策略
- **版本发布**：Agent 客户端升级包上传与分发

## API 概览

Agent 端（`/agent`，设备 Token 鉴权）：register、config、heartbeat、claim、complete、fail、telemetry、updates/check 等。

管理台（`/admin/api`）：tasks、dramas、devices、stats、config/global、agent-releases、remix/replica 等。

管理台完整接口可在管理台页面直接操作，或参考 `apps/api-server/src/index.ts` 中的路由注册。

## Windows 一键安装包（用户侧）

```powershell
npm run pack:win
# 在 Windows 机器上执行，产出安装包与绿色免安装包
# 或用 Inno Setup 编译 deploy/windows-packaging/ClipAgent.iss
```

安装程序内置 Node.js / Python / FFmpeg / FunASR 引擎，用户双击安装后自动注册设备并启动托盘程序。

## 开发命令速查

```bash
npm run build        # 按依赖顺序构建全部包
npm run test         # agent-core 单测
npm run dev:api      # API + 管理台
npm run dev:admin    # 管理台热更新（Vite，端口 5173）
npm run dev:funasr   # ASR Sidecar
npm run dev:agent    # Agent
npm run pack:win     # Windows 安装包
npm run desktop      # Tauri 桌面壳构建
```

## License

MIT
