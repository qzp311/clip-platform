function normalizeBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (hostname.startsWith("192.168.")) return true;
  if (hostname.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

/** Resolve the URL written into clip_task.source_url (must be a complete download URL for agents). */
export function resolvePublicApiBase(port: number): string {
  const localBase = `http://127.0.0.1:${port}`;

  const explicit = process.env.CLIP_API_PUBLIC_BASE?.trim();
  if (explicit) {
    return normalizeBase(explicit);
  }

  const envBase = process.env.CLIP_API_BASE?.trim();
  if (envBase) {
    try {
      const { hostname } = new URL(envBase);
      if (isPrivateOrLocalHost(hostname)) {
        return normalizeBase(envBase);
      }
    } catch {
      // ignore invalid URL
    }
  }

  return localBase;
}

export function isLocalhostDownloadUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function warnIfLocalhostDownloadUrl(url: string, context: string): void {
  if (!isLocalhostDownloadUrl(url)) return;
  console.warn(
    `[clip-api] ${context}: download URL uses localhost (${url}). ` +
      "Remote agents cannot fetch this file. Set CLIP_API_PUBLIC_BASE to your LAN/public API address.",
  );
}
