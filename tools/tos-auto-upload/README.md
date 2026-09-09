# TOS 自动上传（独立工具）

不依赖 clip-platform 仓库其他任何文件。把整个 `tos-auto-upload` 目录拷到 Windows 任意位置即可用。

## 环境要求

- 已安装 [Node.js 18+](https://nodejs.org/)（装好后命令行能跑 `node -v` / `npm -v`）

## 第一次使用

1. 进入本目录
2. 把 `config.example.json` 复制为 `config.json`（或直接改已有 `config.json`）
3. 填写：

```json
{
  "accessKey": "你的AK",
  "accessSecret": "你的SK",
  "accessSecretEncoding": "plain",
  "bucket": "vland",
  "endpoint": "https://tos-cn-beijing.volces.com",
  "region": "cn-beijing",
  "prefix": "sources/packages",
  "watchDir": "D:\\tos-inbox",
  "intervalSec": 10,
  "stableSec": 15,
  "concurrency": 4
}
```

`accessSecretEncoding` 用 **`plain`**。`concurrency` 为同时上传的文件数（默认 4）。
4. 双击 `start.cmd`  
   - 会自动 `npm install`  
   - 然后一直监听 `watchDir`  
   - 看到 `.zip` → 等文件写完（`stableSec`）→ 上传 TOS → **删除本地 zip**

也可命令行：

```bat
cd /d D:\tools\tos-auto-upload
npm install
node watch.mjs
```

临时改目录：

```bat
node watch.mjs --dir D:\短剧待上传
```

## 行为说明

| 项 | 说明 |
|----|------|
| 触发 | 监听目录内出现 `.zip`（实时 fs.watch + 轮询兜底） |
| 并发 | 同时最多上传 `concurrency` 个文件（默认 4） |
| 稳定等待 | 文件大小连续 `stableSec` 秒不变才上传（防拷贝到一半） |
| 成功 | 删除本地 zip；调用 api-server 将入库状态改为已上传并创建混剪任务 |
| 失败 | 移到 `watchDir\_failed\`，并追加 `errors.log` |

文件名必须为：`短剧名称_短剧ID.zip`（用最后一个 `_` 分隔 ID）。

`config.json` 需配置：

```json
"apiBaseUrl": "http://192.168.1.11:8081",
"activateAfterUpload": true
```


## 单次手动上传

```bat
node upload.mjs D:\path\xxx.zip
```

## 开机自启（计划任务）

- 程序：`C:\Windows\System32\cmd.exe`
- 参数：`/k D:\tools\tos-auto-upload\start.cmd`
- 触发器：用户登录时

## 目录内容

```
tos-auto-upload/
  package.json          # 仅依赖 @volcengine/tos-sdk
  common.mjs            # 上传逻辑
  watch.mjs             # 目录监听主程序
  upload.mjs            # 单次上传
  config.json           # 本地密钥（勿提交）
  config.example.json
  start.cmd             # Windows 一键启动
  README.md
```
