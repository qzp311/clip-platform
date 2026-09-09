#!/usr/bin/env node
/**
 * 单次上传本地文件到 TOS
 * 用法: node upload.mjs D:\path\file.zip
 */
import { resolve } from "node:path";
import {
  CONFIG_PATH,
  createTosClient,
  formatUploadError,
  loadConfig,
  loadTosSettings,
  uploadLocalFileToTos,
} from "./common.mjs";

async function main() {
  const file = process.argv[2] ? resolve(process.argv[2]) : "";
  if (!file) {
    console.log("用法: node upload.mjs <本地文件>");
    process.exit(1);
  }
  const cfg = await loadConfig(CONFIG_PATH);
  const settings = loadTosSettings(cfg);
  const { client, UploadEventType } = createTosClient(settings);
  const result = await uploadLocalFileToTos(client, UploadEventType, settings, file);
  console.log(result.publicUrl);
}

main().catch((err) => {
  const { message, hints } = formatUploadError(err);
  console.error(`[tos] 失败: ${message}`);
  for (const h of hints) console.error(`提示: ${h}`);
  process.exit(1);
});
