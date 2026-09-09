import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import TasksView from "./views/TasksView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";
import DevicesView from "./views/DevicesView.vue";
import ConfigView from "./views/ConfigView.vue";
import AsrResultDetailView from "./views/AsrResultDetailView.vue";
import DramaLibraryView from "./views/DramaLibraryView.vue";
import DramaIntakeView from "./views/DramaIntakeView.vue";
import LoginView from "./views/LoginView.vue";
import RemixReplicaView from "./views/RemixReplicaView.vue";
import { getAccessToken, setAccessToken } from "./utils/auth.js";
import { loadCurrentUser } from "./stores/user.js";

const router = createRouter({
  history: createWebHistory("/admin/"),
  routes: [
    { path: "/login", component: LoginView, meta: { public: true, title: "登录" } },
    { path: "/", component: DashboardView, meta: { title: "仪表盘" } },
    { path: "/dramas", component: DramaLibraryView, meta: { title: "短剧库" } },
    { path: "/package-cache", redirect: { path: "/dramas", query: { tab: "cache" } } },
    { path: "/drama-intake", component: DramaIntakeView, meta: { title: "短剧入库" } },
    { path: "/tasks", component: TasksView, meta: { title: "任务看板" } },
    { path: "/tasks/:id", component: TaskDetailView, meta: { title: "任务详情" } },
    { path: "/asr", redirect: { path: "/dramas", query: { tab: "results" } } },
    { path: "/asr-results", redirect: { path: "/dramas", query: { tab: "results" } } },
    { path: "/asr-results/:id", component: AsrResultDetailView, meta: { title: "ASR 详情" } },
    { path: "/devices", component: DevicesView, meta: { title: "Agent 控制" } },
    { path: "/rule-sets", redirect: { path: "/dramas", query: { tab: "rules" } } },
    { path: "/config", component: ConfigView, meta: { title: "系统配置" } },
    { path: "/remix-replica", component: RemixReplicaView, meta: { title: "案例复刻" } },
  ],
});

router.beforeEach(async (to) => {
  // 开源版无服务端鉴权：首次访问自动写入本地会话，仅保留路由结构
  if (!getAccessToken()) {
    setAccessToken("local-session");
  }
  if (to.meta.public) {
    if (to.path === "/login") {
      return "/";
    }
    return true;
  }
  await loadCurrentUser();
  return true;
});

export default router;
