<template>
  <div>
    <div class="page-head">
      <div>
        <h2>剧包缓存</h2>
        <p class="hint">查看 TOS 剧包在各设备上的下载、解压缓存状态。ZIP 与解压视频由 Agent 保存在本地，重跑时优先复用。</p>
      </div>
      <button class="btn secondary" @click="load">刷新</button>
    </div>

    <div class="card dclip-toolbar">
      <input v-model="dramaId" placeholder="剧目 ID" @keyup.enter="search" />
      <select v-model="status" @change="search">
        <option value="">全部状态</option>
        <option value="missing">missing</option>
        <option value="downloading">downloading</option>
        <option value="ready">ready</option>
        <option value="stale">stale</option>
        <option value="deleting">deleting</option>
        <option value="delete_failed">delete_failed</option>
      </select>
      <button class="btn" @click="search">查询</button>
      <span class="muted">共 {{ total }} 条缓存记录</span>
    </div>

    <div class="card cache-guide">
      <div><strong>缓存策略</strong><span>首次任务下载并解压；后续重跑复用本地 ZIP/分集目录。</span></div>
      <div class="cache-legend"><span class="dot blue" />下载/解压 <span class="dot green" />已就绪 <span class="dot gray" />本地保留</div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>关联任务</th>
            <th>剧目</th>
            <th>剧包</th>
            <th>设备</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>缓存说明</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="rowKey(item)">
            <td>
              <RouterLink v-if="taskIdOf(item)" :to="`/tasks/${taskIdOf(item)}`">{{ taskIdOf(item) }}</RouterLink>
              <span v-else class="muted">未关联</span>
            </td>
            <td>{{ item.dramaId || "-" }}</td>
            <td>{{ packageName(item) }}</td>
            <td><code>{{ item.deviceId || "-" }}</code></td>
            <td><span :class="['badge', String(item.status)]">{{ item.status }}</span></td>
            <td><span :class="['phase', phaseClass(item)]">{{ phase(item) }}</span></td>
            <td>{{ cacheHint(item) }}</td>
            <td>{{ item.updatedAt || "-" }}</td>
            <td>
              <RouterLink v-if="taskIdOf(item)" :to="`/tasks/${taskIdOf(item)}`">查看任务</RouterLink>
              <span v-else class="muted">无任务</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!items.length" class="empty">暂无剧包缓存</p>
      <ListPager :total="total" :limit="limit" :offset="offset" @prev="prevPage" @next="nextPage" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";

const items = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const offset = ref(0);
const limit = PAGE_SIZE;
const dramaId = ref("");
const status = ref("");

/** 缓存记录字段是 packageTaskId，不是 taskId */
function taskIdOf(item: Record<string, unknown>): string {
  const id = item.packageTaskId ?? item.taskId;
  return id ? String(id) : "";
}

function rowKey(item: Record<string, unknown>): string {
  return String(item.cacheId ?? `${item.cacheKey}-${item.deviceId}`);
}

function packageName(item: Record<string, unknown>): string {
  return String(item.packageName ?? "-");
}

function phase(item: Record<string, unknown>): string {
  const value = String(item.status ?? "-");
  const labels: Record<string, string> = {
    missing: "未发现",
    downloading: "下载中",
    ready: "已缓存",
    stale: "待复核",
    deleting: "删除中",
    delete_failed: "删除失败",
  };
  return labels[value] ?? value;
}

function phaseClass(item: Record<string, unknown>): string {
  const p = String(item.status ?? "");
  if (p === "delete_failed") return "bad";
  if (p === "ready") return "done";
  if (p === "deleting" || p === "stale") return "warn";
  return "active";
}

function cacheHint(item: Record<string, unknown>): string {
  if (item.extracted) {
    return `已解压 ${item.episodeCount ?? "?"} 集 · ${Number(item.sizeBytes ?? 0).toLocaleString()} bytes`;
  }
  if (item.zipExists) return "ZIP 已缓存，待解压";
  return "等待 Agent 上报";
}

async function load() {
  const res = await api.listPackageCaches({
    status: status.value || undefined,
    dramaId: dramaId.value || undefined,
    limit,
    offset: offset.value,
  });
  items.value = res.items;
  total.value = res.total;
}

function search() {
  offset.value = 0;
  void load();
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit);
  void load();
}

function nextPage() {
  offset.value += limit;
  void load();
}

onMounted(load);
</script>

<style scoped>
.page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:14px; }
.cache-guide { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:14px; color:var(--text-secondary); font-size:13px; }
.cache-guide strong { color:var(--text); margin-right:12px; }
.cache-legend { white-space:nowrap; font-size:12px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin:0 4px 0 10px; }
.dot:first-child { margin-left:0; }
.dot.blue { background:#3b82f6; }
.dot.green { background:#16a34a; }
.dot.gray { background:#94a3b8; }
.phase { font-size:12px; padding:4px 8px; border-radius:999px; background:#eff6ff; color:#2563eb; }
.phase.done { background:#ecfdf5; color:#15803d; }
.phase.warn { background:#fff7ed; color:#c2410c; }
.phase.bad { background:#fef2f2; color:#b91c1c; }
.muted { color:var(--text-secondary); }
@media(max-width:900px){
  .cache-guide { display:block; }
  .cache-legend { margin-top:10px; }
  .page-head { align-items:center; }
}
</style>
