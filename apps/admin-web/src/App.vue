<template>
  <RouterView v-if="isLoginPage" />
  <div v-else class="dclip-root dclip-app-shell">
    <aside class="dclip-sidebar">
      <div class="dclip-sidebar__inner">
        <div class="dclip-sidebar__brand">
          <div class="dclip-brand">
            <div class="dclip-brand__mark" aria-hidden="true">
              <img class="dclip-brand__logo" src="/logo.png" width="34" height="34" alt="" />
            </div>
            <div class="dclip-brand__text">
              <span class="dclip-brand__name">drama-clip</span>
              <span class="dclip-brand__tagline">短剧 AI 智能剪辑平台</span>
            </div>
          </div>
        </div>

        <nav class="dclip-sidebar__menu" aria-label="主导航">
          <section v-for="group in navGroups" :key="group.key" class="dclip-nav-section">
            <div class="dclip-nav-section__label">{{ group.title }}</div>
            <RouterLink
              v-for="item in group.items"
              :key="item.to"
              :to="item.to"
              class="dclip-nav-item"
              :class="{ 'is-active': isNavActive(item.to) }"
            >
              <span class="dclip-nav-icon">
                <DclipNavIcon :name="item.icon" />
              </span>
              <span class="dclip-nav-item-title">{{ item.title }}</span>
            </RouterLink>
          </section>
        </nav>
      </div>

      <div class="dclip-sidebar__footer">
        <div class="dclip-sidebar__user-row">
          <div class="dclip-sidebar__avatar" aria-hidden="true">{{ userInitial }}</div>
          <div class="dclip-sidebar__user-meta">
            <div class="dclip-sidebar__user-name">{{ displayName }}</div>
            <div class="dclip-sidebar__user-role">管理员</div>
          </div>
        </div>
        <button class="dclip-sidebar__logout" type="button" @click="onLogout">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke-linecap="round" />
            <path d="M16 17l5-5-5-5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M21 12H9" stroke-linecap="round" />
          </svg>
          退出登录
        </button>
      </div>
    </aside>

    <div class="dclip-shell-main">
      <header class="dclip-shell-header">
        <h1 class="dclip-page-title">{{ pageTitle }}</h1>
      </header>
      <main class="dclip-shell-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import DclipNavIcon from "./components/DclipNavIcon.vue";
import { logoutAndClear, useCurrentUser } from "./stores/user.js";

const route = useRoute();
const router = useRouter();
const { currentUser } = useCurrentUser();

const navGroups = [
  {
    key: "workspace",
    title: "工作台",
    items: [
      { to: "/", title: "仪表盘", icon: "dashboard" as const },
      { to: "/tasks", title: "任务看板", icon: "tasks" as const },
    ],
  },
  {
    key: "biz",
    title: "业务",
    items: [
      { to: "/dramas", title: "短剧库", icon: "dramas" as const },
      { to: "/drama-intake", title: "短剧入库", icon: "drama-intake" as const },
      { to: "/remix-replica", title: "案例复刻", icon: "remix" as const },
    ],
  },
  {
    key: "system",
    title: "系统",
    items: [
      { to: "/devices", title: "Agent 控制", icon: "devices" as const },
      { to: "/config", title: "系统配置", icon: "settings" as const },
    ],
  },
];

const isLoginPage = computed(() => route.path === "/login");
const pageTitle = computed(() => (route.meta.title as string | undefined) ?? "drama-clip");
const displayName = computed(() => currentUser.value?.nickname || "管理员");
const userInitial = computed(() => {
  const name = displayName.value.trim();
  return name ? name.charAt(0).toUpperCase() : "U";
});

function isNavActive(to: string): boolean {
  const path = route.path;
  if (to === "/") return path === "/";
  if (to === "/dramas") {
    return (
      path.startsWith("/dramas") ||
      path.startsWith("/package-cache") ||
      path.startsWith("/asr") ||
      path.startsWith("/asr-results") ||
      path.startsWith("/rule-sets")
    );
  }
  if (to === "/config") {
    return path.startsWith("/config");
  }
  return path === to || path.startsWith(`${to}/`);
}

async function onLogout() {
  await logoutAndClear();
  await router.replace("/login");
}
</script>
