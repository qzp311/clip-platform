import { getAccessToken } from "../utils/auth.js";

export class ApiAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function buildHeaders(init?: RequestInit): HeadersInit {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  // 仅有 body 时声明 JSON；DELETE/GET 空 body + application/json 会被 Fastify 拒绝
  const hasBody = init?.body != null && init.body !== "";
  if (hasBody && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new ApiAuthError(res.status, `${res.status} empty response`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiAuthError(res.status, text);
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : text;
    throw new Error(`${res.status} ${msg}`);
  }
  return body as T;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: buildHeaders(init),
  });
  return parseResponse<T>(res);
}

export async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const res = await fetch(path, {
    ...init,
    headers: buildHeaders(init),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.blob();
}
