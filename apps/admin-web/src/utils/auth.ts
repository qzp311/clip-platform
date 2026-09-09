/**
 * 简单本地会话：开源版默认不做服务端登录鉴权，
 * 仅保留 token 存取工具以满足路由守卫与请求头拼装。
 */

const TOKEN_KEY = "clip_admin_token";

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
