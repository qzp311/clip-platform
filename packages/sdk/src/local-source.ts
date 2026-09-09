/** Agent 本地原片引用，不上传 OSS */
export const CLIP_LOCAL_SOURCE_PREFIX = "clip-local:";

export function toClipLocalSourceUrl(localPath: string): string {
  return `${CLIP_LOCAL_SOURCE_PREFIX}${encodeURIComponent(localPath)}`;
}

export function parseClipLocalSourceUrl(sourceUrl: string): string | null {
  if (!sourceUrl.startsWith(CLIP_LOCAL_SOURCE_PREFIX)) return null;
  return decodeURIComponent(sourceUrl.slice(CLIP_LOCAL_SOURCE_PREFIX.length));
}

export function isClipLocalSource(sourceUrl: string): boolean {
  return sourceUrl.startsWith(CLIP_LOCAL_SOURCE_PREFIX);
}
