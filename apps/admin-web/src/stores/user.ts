import { ref } from "vue";
import { getAccessToken, removeToken } from "../utils/auth.js";

export interface CurrentUser {
  username: string;
  nickname: string;
}

const currentUser = ref<CurrentUser | null>(null);

export function useCurrentUser() {
  return { currentUser };
}

/** 开源版无服务端鉴权：有本地 token 即视为已登录 */
export async function loadCurrentUser(): Promise<CurrentUser | null> {
  if (!getAccessToken()) {
    currentUser.value = null;
    return null;
  }
  currentUser.value = currentUser.value ?? { username: "local", nickname: "本地用户" };
  return currentUser.value;
}

export async function logoutAndClear(): Promise<void> {
  removeToken();
  currentUser.value = null;
}
