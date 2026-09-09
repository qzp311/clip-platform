import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StickerManifest, StickerTemplate } from "@clip/sdk";

/** 贴花/花字模板注册表，渲染时统一读取本地清单 */
export interface StickerRegistry {
  /** 模板文件所在目录 */
  dir: string;
  /** 模板清单 */
  manifest: StickerManifest;
  /** 按模板 ID 索引 */
  byId: ReadonlyMap<string, StickerTemplate>;
  /** 按标签索引的模板列表 */
  byTag: ReadonlyMap<string, StickerTemplate[]>;
}

function parseStickerRegistry(stickersDir: string, raw: string): StickerRegistry {
  const manifest = JSON.parse(raw) as StickerManifest;
  if (!Array.isArray(manifest.templates) || manifest.templates.length === 0) {
    throw new Error(`贴花模板清单为空: ${join(stickersDir, "stickers.json")}`);
  }

  const byId = new Map<string, StickerTemplate>();
  const byTag = new Map<string, StickerTemplate[]>();

  for (const template of manifest.templates) {
    if (!template.id || !template.file) {
      console.warn(`[sticker-registry] 跳过无效模板记录: ${JSON.stringify(template)}`);
      continue;
    }
    byId.set(template.id, template);
    for (const tag of template.tags ?? []) {
      const list = byTag.get(tag) ?? [];
      list.push(template);
      byTag.set(tag, list);
    }
    for (const category of template.categories ?? []) {
      const list = byTag.get(category) ?? [];
      list.push(template);
      byTag.set(category, list);
    }
  }

  return { dir: stickersDir, manifest, byId, byTag };
}

/** 同步加载贴花模板清单；推荐在渲染器初始化时使用 */
export function loadStickerRegistry(stickersDir: string): StickerRegistry {
  const manifestPath = join(stickersDir, "stickers.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`贴花模板清单不存在: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return parseStickerRegistry(stickersDir, raw);
}

/** 异步加载贴花模板清单 */
export async function loadStickerRegistryAsync(stickersDir: string): Promise<StickerRegistry> {
  const { readFile } = await import("node:fs/promises");
  const manifestPath = join(stickersDir, "stickers.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`贴花模板清单不存在: ${manifestPath}`);
  }
  const raw = await readFile(manifestPath, "utf-8");
  return parseStickerRegistry(stickersDir, raw);
}

/** 根据模板 ID 解析模板记录 */
export function resolveStickerTemplate(registry: StickerRegistry | undefined, templateId?: string): StickerTemplate | undefined {
  if (!registry || !templateId) return undefined;
  return registry.byId.get(templateId);
}

/** 根据模板 ID 解析模板文件完整路径；找不到或文件不存在返回 undefined */
export function resolveStickerFile(registry: StickerRegistry | undefined, templateId?: string): string | undefined {
  if (!registry || !templateId) return undefined;
  const template = registry.byId.get(templateId);
  if (!template) return undefined;
  const fullPath = join(registry.dir, template.file);
  return existsSync(fullPath) ? fullPath : undefined;
}

/** 按标签查找模板；返回第一个匹配标签的模板，或 undefined */
export function findStickerByTag(registry: StickerRegistry | undefined, tags: string[]): StickerTemplate | undefined {
  if (!registry || tags.length === 0) return undefined;
  for (const tag of tags) {
    const list = registry.byTag.get(tag);
    if (list && list.length > 0) return list[0];
  }
  return undefined;
}

/** 列出所有可用模板 ID */
export function listStickerTemplateIds(registry: StickerRegistry): string[] {
  return Array.from(registry.byId.keys());
}
