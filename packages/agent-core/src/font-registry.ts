import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 字体授权范围：
 * - all-platform：全平台可商用（如 OFL、阿里巴巴普惠体）
 * - byte-dance-only：仅限字节系平台（抖音、西瓜、今日头条等）
 * - internal-only：仅限内部测试，不用于对外发布
 */
export type FontLicenseScope = "all-platform" | "byte-dance-only" | "internal-only";

/** 单条字体记录 */
export interface FontRecord {
  /** 字体唯一标识 */
  id: string;
  /** 展示名称 */
  name: string;
  /** 字体族名，传给 ffmpeg drawtext/ASS 使用 */
  family: string;
  /** 授权协议，如 OFL-1.1、免费商用 */
  license: string;
  /** 授权范围 */
  licenseScope: FontLicenseScope;
  /** 授权协议链接 */
  licenseUrl?: string;
  /** 字体来源 */
  source?: string;
  /** 字体文件名，相对于 fontsDir */
  file: string;
  /** 字体描述 */
  description?: string;
}

/** 字体清单文件结构 */
export interface FontManifest {
  version?: string;
  /** 默认回退字体（优先） */
  defaultFontFamily?: string;
  /** 第二默认回退字体 */
  defaultFallbackFamily?: string;
  fonts: FontRecord[];
}

/** 字体注册表，渲染时统一读取 */
export interface FontRegistry {
  /** 字体文件所在目录 */
  dir: string;
  /** 字体清单 */
  manifest: FontManifest;
  /** 按 family/名称/id 索引的字体记录 */
  byFamily: ReadonlyMap<string, FontRecord>;
  byName: ReadonlyMap<string, FontRecord>;
  byId: ReadonlyMap<string, FontRecord>;
}

function parseFontRegistry(fontsDir: string, raw: string): FontRegistry {
  const manifest = JSON.parse(raw) as FontManifest;
  if (!Array.isArray(manifest.fonts) || manifest.fonts.length === 0) {
    throw new Error(`字体清单为空: ${join(fontsDir, "fonts.json")}`);
  }

  const byFamily = new Map<string, FontRecord>();
  const byName = new Map<string, FontRecord>();
  const byId = new Map<string, FontRecord>();

  for (const font of manifest.fonts) {
    if (!font.id || !font.family || !font.file) {
      console.warn(`[font-registry] 跳过无效字体记录: ${JSON.stringify(font)}`);
      continue;
    }
    byId.set(font.id, font);
    byName.set(font.name, font);
    // 同一 family 可能有多个文件（粗细），后出现的覆盖先出现的；当前清单按单个文件处理
    byFamily.set(font.family, font);
  }

  return { dir: fontsDir, manifest, byFamily, byName, byId };
}

/** 同步加载字体清单；推荐在渲染器初始化时使用 */
export function loadFontRegistry(fontsDir: string): FontRegistry {
  const manifestPath = join(fontsDir, "fonts.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`字体清单不存在: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return parseFontRegistry(fontsDir, raw);
}

/** 异步加载字体清单；适用于需要非阻塞初始化的场景 */
export async function loadFontRegistryAsync(fontsDir: string): Promise<FontRegistry> {
  const { readFile } = await import("node:fs/promises");
  const manifestPath = join(fontsDir, "fonts.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`字体清单不存在: ${manifestPath}`);
  }
  const raw = await readFile(manifestPath, "utf-8");
  return parseFontRegistry(fontsDir, raw);
}

/** 根据字体名解析成字体文件路径；支持 family、展示名、id */
export function resolveFontFile(registry: FontRegistry | undefined, fontName?: string): string | undefined {
  const name = fontName?.trim();
  if (!name) return undefined;
  if (!registry) return undefined;

  const record = registry.byFamily.get(name) ?? registry.byName.get(name) ?? registry.byId.get(name);
  if (!record) return undefined;

  const fullPath = join(registry.dir, record.file);
  return existsSync(fullPath) ? fullPath : undefined;
}

/** 把字体名解析成 FontRecord；找不到返回 undefined */
export function resolveFontRecord(
  registry: FontRegistry | undefined,
  fontName?: string,
): FontRecord | undefined {
  const name = fontName?.trim();
  if (!name || !registry) return undefined;
  return registry.byFamily.get(name) ?? registry.byName.get(name) ?? registry.byId.get(name);
}

/** 获取渲染时应使用的有效字体名
 * - 命中白名单：返回白名单字体的 family（文件有保障）
 * - 未命中白名单但传了名字：保留原名字，让 render/subtitle 层的系统字体映射兜底尝试
 * - 未传名字：回退默认字体
 */
export function resolveEffectiveFontName(
  registry: FontRegistry | undefined,
  fontName?: string,
): string {
  const name = fontName?.trim();
  if (!name) {
    return getDefaultFontFamily(registry);
  }
  if (!registry) {
    return name;
  }
  const record = resolveFontRecord(registry, name);
  if (record) {
    return record.family;
  }
  // 方案 C：允许系统字体作为备选，未命中白名单时保留原名字，交给后续系统字体映射处理
  console.info(
    `[font-registry] 字体 "${name}" 不在白名单，保留原名字并尝试系统字体映射；` +
      `白名单字体: ${listAllowedFontNames(registry).join(", ")}`,
  );
  return name;
}

/** 返回默认字体族名；无注册表时回退到抖音美好体（为兼容旧逻辑） */
export function getDefaultFontFamily(registry: FontRegistry | undefined): string {
  if (registry?.manifest?.defaultFontFamily) {
    return registry.manifest.defaultFontFamily;
  }
  return "DouyinSansBold";
}

/** 列出所有允许使用的字体展示名称 */
export function listAllowedFontNames(registry: FontRegistry): string[] {
  return registry.manifest.fonts.map((f) => f.name);
}

/** 校验字体是否可用于当前平台；strict=false 时未命中只返回警告原因 */
export function validateFont(
  registry: FontRegistry,
  fontName: string,
  targetPlatform?: string,
): { ok: boolean; reason?: string } {
  const record = resolveFontRecord(registry, fontName);
  if (!record) {
    const available = listAllowedFontNames(registry).join(", ");
    return {
      ok: false,
      reason: `字体 "${fontName}" 不在白名单，可用字体: ${available}`,
    };
  }
  if (record.licenseScope === "byte-dance-only" && targetPlatform && targetPlatform !== "douyin") {
    return {
      ok: false,
      reason: `字体 "${record.name}" 仅限字节系平台使用，当前平台: ${targetPlatform}`,
    };
  }
  if (record.licenseScope === "internal-only") {
    return {
      ok: false,
      reason: `字体 "${record.name}" 仅限内部使用，不可用于对外发布`,
    };
  }
  return { ok: true };
}

/** 校验字体文件是否真实存在 */
export function isFontFileAvailable(registry: FontRegistry, fontName?: string): boolean {
  return resolveFontFile(registry, fontName) !== undefined;
}
