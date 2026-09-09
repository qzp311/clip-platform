#!/usr/bin/env node
/**
 * 下载 / 初始化 ASR 模型 CDN manifest
 * Windows 4060 生产: FunASR 通过 ModelScope 在首次 GPU 推理时自动缓存
 * 此脚本生成 manifest 并创建 CDN 目录结构
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cdnRoot = join(root, "data", "cdn", "models");
const apiBase = process.env.CLIP_API_BASE ?? "http://127.0.0.1:8081";

const MODELS = [
  {
    name: "paraformer-zh",
    description: "FunASR Paraformer 中文 ASR（ModelScope 自动缓存到 models-dir）",
    files: ["README.txt"],
  },
  {
    name: "fsmn-vad",
    description: "FunASR VAD 模型",
    files: ["README.txt"],
  },
  {
    name: "ct-punc",
    description: "FunASR 标点模型",
    files: ["README.txt"],
  },
];

async function main() {
  await mkdir(cdnRoot, { recursive: true });

  const manifestModels = [];

  for (const model of MODELS) {
    const modelDir = join(cdnRoot, model.name);
    await mkdir(modelDir, { recursive: true });

    const readme = [
      model.description,
      "",
      "生产环境: FunASR GPU Sidecar 通过 ModelScope 自动下载到 engines/funasr/models/",
      "Windows 安装后运行: pip install -r apps/funasr-server/python/requirements-funasr.txt",
      "设置 CLIP_ASR_BACKEND=funasr-gpu",
    ].join("\n");

    const readmePath = join(modelDir, "README.txt");
    await writeFile(readmePath, readme);

    const content = await readFile(readmePath);
    const sha256 = createHash("sha256").update(content).digest("hex");

    manifestModels.push({
      name: model.name,
      url: `/cdn/models/${model.name}/README.txt`,
      sha256,
      sizeBytes: content.byteLength,
      note: "FunASR uses ModelScope hub at runtime; CDN entry tracks bundle version",
    });
  }

  const manifest = {
    version: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    provider: "funasr-modelscope",
    platform: "win-x64-4060",
    models: manifestModels,
    setup: {
      python: "pip install -r apps/funasr-server/python/requirements-funasr.txt",
      backend: "CLIP_ASR_BACKEND=funasr-gpu",
      modelsDir: "%LOCALAPPDATA%\\ClipAgent\\models",
    },
  };

  await writeFile(join(cdnRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[models] CDN manifest written: ${join(cdnRoot, "manifest.json")}`);
  console.log("[models] FunASR GPU models will auto-download via ModelScope on first transcribe");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
