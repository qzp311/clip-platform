<template>
  <div class="tasks-page">
    <div class="page-header">
      <div class="page-header__text">
        <h2>任务看板</h2>
        <p class="page-header__desc">按剧聚合的执行管线：剧包下载 → 分集识别 → 混剪成片</p>
      </div>
      <div class="page-header__tools">
        <span class="last-updated">最后更新 {{ lastUpdated ? formatTime(lastUpdated) : "-" }}</span>
        <label class="auto-refresh">
          <input v-model="autoRefresh" type="checkbox" />
          自动刷新
        </label>
        <button class="btn secondary btn-sm" :disabled="loading" @click="load">
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </div>

    <div class="board-toolbar">
      <div class="status-chips">
        <button
          type="button"
          class="status-chip"
          :class="{ active: !filter.status }"
          @click="setStatus('')"
        >
          全部 <span class="chip-count">{{ total }}</span>
        </button>
        <button
          v-for="s in AGG_STATUS_META"
          :key="s.key"
          type="button"
          class="status-chip"
          :class="[{ active: filter.status === s.key }, s.key]"
          @click="setStatus(filter.status === s.key ? '' : s.key)"
        >
          {{ s.label }} <span class="chip-count">{{ aggCounts[s.key] ?? 0 }}</span>
        </button>
      </div>
      <div class="board-toolbar__right">
        <select v-model="filter.deviceId" @change="onFilterChange">
          <option value="">全部服务器</option>
          <option v-for="d in devices" :key="d.deviceId" :value="d.deviceId">
            {{ d.machineName || d.deviceId }}
          </option>
        </select>
      </div>
    </div>

    <!-- 按剧聚合的看板卡片列表 -->
    <div v-if="groups.length" class="board-list">
      <article v-for="g in groups" :key="g.dramaId" class="drama-card" :class="g.aggStatus">
        <header class="drama-card__head">
          <div class="drama-card__title-wrap">
            <h3 class="drama-card__title">{{ g.title }}</h3>
            <span class="drama-card__id" :title="g.dramaId">{{ g.dramaId }}</span>
          </div>
          <div class="drama-card__meta">
            <span :class="['agg-badge', g.aggStatus]">{{ aggStatusLabel(g.aggStatus) }}</span>
            <span v-for="s in g.servers" :key="s" class="server-badge" :title="s">
              {{ serverNameOf(s) }}
            </span>
            <span class="meta-text">共 {{ g.taskCount }} 个任务</span>
            <span class="meta-text muted">最近活动 {{ formatTime(g.lastActiveAt) }}</span>
          </div>
        </header>

        <!-- 三段管线 -->
        <div class="pipeline">
          <template v-for="(st, i) in g.stages" :key="st.key">
            <div v-if="i > 0" class="pipeline__arrow" :class="stageArrowClass(g, i)">→</div>
            <div class="stage" :class="st.status" @click="st.taskId && goTask(st.taskId)">
              <div class="stage__top">
                <span class="stage__label">{{ st.label }}</span>
                <span :class="['stage__status', st.status]">{{ stageStatusLabel(st) }}</span>
              </div>
              <div class="stage__bar">
                <div class="stage__bar-fill" :style="{ width: stagePercent(st) + '%' }"></div>
              </div>
              <div class="stage__bottom">
                <span class="stage__count">{{ st.done }}/{{ st.total || "—" }}</span>
                <span v-if="st.phase && st.status === 'running'" class="stage__phase">{{ phaseLabel(st.phase) }}</span>
                <span v-else-if="st.claimedBy" class="stage__server">{{ serverNameOf(st.claimedBy) }}</span>
              </div>
            </div>
          </template>
        </div>

        <p v-if="g.failMessage" class="drama-card__fail" :title="g.failMessage">{{ g.failMessage }}</p>

        <!-- 分集明细（可折叠） -->
        <div v-if="g.episodes.length" class="episodes">
          <button type="button" class="episodes__toggle" @click="toggleExpand(g.dramaId)">
            <span class="episodes__toggle-icon" :class="{ open: expanded.has(g.dramaId) }">▸</span>
            分集明细（{{ g.episodes.length }} 集）
          </button>
          <div v-if="expanded.has(g.dramaId)" class="episodes__grid">
            <div
              v-for="ep in g.episodes"
              :key="ep.taskId"
              class="episode-chip"
              :class="epStatusClass(ep.status)"
              :title="`第${ep.episodeNo ?? '?'}集 · ${formatStatus(ep.status)}${ep.server ? ' · ' + ep.server : ''}${ep.elapsed != null ? ' · ' + formatDuration(ep.elapsed) : ''}`"
              @click="goTask(ep.taskId)"
            >
              <span class="episode-chip__no">{{ ep.episodeNo ?? "?" }}</span>
              <span class="episode-chip__dot"></span>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="!loading" class="board-empty">
      <p>暂无任务</p>
      <p class="muted">剧目任务创建后会按剧展示执行管线</p>
    </div>

    <ListPager :total="total" :limit="limit" :offset="offset" @prev="prevPage" @next="nextPage" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";
import { formatDurationSec as formatDuration } from "../utils/format-duration";

const REFRESH_MS = 15_000;

/** 看板聚合状态（区别于单任务状态） */
const AGG_STATUS_META = [
  { key: "running", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
] as const;

interface BoardStage {
  key: string;
  label: string;
  total: number;
  done: number;
  status: "pending" | "running" | "completed" | "failed";
  phase?: string;
  taskId?: string;
  claimedBy?: string;
  claimedAt?: string;
}

interface BoardGroup {
  dramaId: string;
  title: string;
  taskCount: number;
  lastActiveAt: string;
  aggStatus: "running" | "completed" | "failed";
  servers: string[];
  failMessage?: string;
  stages: BoardStage[];
  episodes: Array<{ episodeNo?: number; status: string; taskId: string; server?: string; elapsed?: number }>;
}

const router = useRouter();
const groups = ref<BoardGroup[]>([]);
const total = ref(0);
const limit = PAGE_SIZE;
const offset = ref(0);
const filter = ref<{ status: string; deviceId: string }>({ status: "", deviceId: "" });
const deviceNames = ref<Record<string, string>>({});
const devices = ref<Array<{ deviceId: string; machineName: string }>>([]);
const aggCounts = ref<Record<string, number>>({});
const expanded = ref(new Set<string>());
const loading = ref(false);
const lastUpdated = ref<Date | null>(null);
const autoRefresh = ref(true);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function aggStatusLabel(s: string): string {
  return AGG_STATUS_META.find((m) => m.key === s)?.label ?? s;
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    pending: "待领取",
    claimed: "已领取",
    processing: "执行中",
    completed: "已完成",
    failed: "失败",
  };
  return map[status] ?? status;
}

function stageStatusLabel(st: BoardStage): string {
  if (st.total === 0) return "无";
  if (st.status === "completed") return "完成";
  if (st.status === "failed") return "失败";
  if (st.status === "running") return "进行中";
  return "待开始";
}

const PHASE_LABELS: Record<string, string> = {
  pending: "待开始",
  downloading: "下载中",
  extracting: "解压中",
  asr_episodes: "分集识别中",
  mixing: "混剪中",
  uploading: "上传中",
  cleaning: "清理中",
  completed: "完成",
  failed: "失败",
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

function stagePercent(st: BoardStage): number {
  if (!st.total) return 0;
  return Math.min(100, Math.round((st.done / st.total) * 100));
}

/** 管线箭头：上一阶段完成后高亮 */
function stageArrowClass(g: BoardGroup, i: number): string {
  return g.stages[i - 1]?.status === "completed" ? "done" : "";
}

function epStatusClass(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "processing" || status === "claimed") return "running";
  return "pending";
}

function formatTime(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("zh-CN", { hour12: false });
}

function serverNameOf(deviceId: string): string {
  return deviceNames.value[deviceId] ?? deviceId;
}

function goTask(taskId: string) {
  void router.push(`/tasks/${taskId}`);
}

function toggleExpand(dramaId: string) {
  const next = new Set(expanded.value);
  if (next.has(dramaId)) next.delete(dramaId);
  else next.add(dramaId);
  expanded.value = next;
}

async function load() {
  loading.value = true;
  try {
    const res = await api.getTaskBoard({
      aggStatus: filter.value.status || undefined,
      deviceId: filter.value.deviceId || undefined,
      limit,
      offset: offset.value,
    });
    groups.value = res.groups;
    total.value = res.total;
    deviceNames.value = res.deviceNames ?? {};
    lastUpdated.value = new Date();
  } finally {
    loading.value = false;
  }
}

/** 聚合状态计数：并行取各聚合状态 total */
async function loadAggCounts() {
  const entries = await Promise.all(
    AGG_STATUS_META.map(async (s) => {
      const res = await api.getTaskBoard({ aggStatus: s.key, limit: 1, offset: 0 });
      return [s.key, res.total] as const;
    }),
  );
  aggCounts.value = Object.fromEntries(entries) as Record<string, number>;
}

async function loadDevices() {
  const res = await api.listDevices({ limit: 200, offset: 0 });
  devices.value = (res.devices as Array<{ deviceId: string; machineId?: string }>).map((d) => ({
    deviceId: String(d.deviceId),
    machineName: String(d.machineId || d.deviceId),
  }));
}

function setStatus(status: string) {
  filter.value.status = status;
  offset.value = 0;
  void load();
}

function onFilterChange() {
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

onMounted(() => {
  void load();
  void loadDevices();
  void loadAggCounts();
});

watch(autoRefresh, (on) => {
  if (on) {
    refreshTimer = setInterval(() => {
      void load();
    }, REFRESH_MS);
  } else if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}, { immediate: true });

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-header h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
}

.page-header__desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.page-header__tools {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.last-updated {
  font-size: 12px;
  color: var(--text-muted);
}

.auto-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.auto-refresh input {
  accent-color: var(--brand);
}

.board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.board-toolbar__right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.board-toolbar__right select {
  min-width: 150px;
}

.status-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-surface);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.status-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.status-chip.active {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.status-chip.active.running { border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); color: #d97706; }
.status-chip.active.completed { border-color: #10b981; background: rgba(16, 185, 129, 0.1); color: #059669; }
.status-chip.active.failed { border-color: #ef4444; background: rgba(239, 68, 68, 0.1); color: #dc2626; }

.chip-count {
  font-size: 12px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.status-chip.active .chip-count {
  background: #fff;
}

/* ===== 剧卡片 ===== */
.board-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.drama-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 20px;
  transition: box-shadow 0.15s, border-color 0.15s;
}

.drama-card:hover {
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
}

.drama-card.failed { border-color: rgba(239, 68, 68, 0.35); }
.drama-card.completed { border-color: rgba(16, 185, 129, 0.3); }

.drama-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.drama-card__title-wrap {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.drama-card__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

.drama-card__id {
  font-size: 12px;
  color: var(--text-muted);
  font-family: monospace;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.drama-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.meta-text.muted {
  color: var(--text-muted);
}

.agg-badge {
  display: inline-block;
  padding: 3px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.agg-badge.running {
  color: #d97706;
  background: rgba(245, 158, 11, 0.12);
}

.agg-badge.completed {
  color: #059669;
  background: rgba(16, 185, 129, 0.12);
}

.agg-badge.failed {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.12);
}

.server-badge {
  display: inline-block;
  max-width: 140px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #0284c7;
  background: rgba(56, 189, 248, 0.12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

/* ===== 管线 ===== */
.pipeline {
  display: flex;
  align-items: stretch;
  gap: 10px;
  flex-wrap: wrap;
}

.stage {
  flex: 1 1 200px;
  min-width: 180px;
  max-width: 320px;
  background: var(--bg-muted);
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.stage:hover {
  border-color: var(--border-strong);
}

.stage.pending { opacity: 0.65; }

.stage.running {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.05);
}

.stage.completed {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.05);
}

.stage.failed {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.05);
}

.stage__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.stage__label {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.stage__status {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.stage__status.running { color: #d97706; }
.stage__status.completed { color: #059669; }
.stage__status.failed { color: #dc2626; }

.stage__bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.25);
  overflow: hidden;
  margin-bottom: 8px;
}

.stage__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--brand);
  transition: width 0.4s ease;
}

.stage.completed .stage__bar-fill { background: #10b981; }
.stage.failed .stage__bar-fill { background: #ef4444; }

.stage__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stage__count {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.stage__phase {
  font-size: 12px;
  color: #d97706;
  font-weight: 600;
}

.stage__server {
  font-size: 12px;
  color: var(--text-muted);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pipeline__arrow {
  align-self: center;
  font-size: 18px;
  color: var(--text-muted);
  opacity: 0.5;
}

.pipeline__arrow.done {
  color: #10b981;
  opacity: 1;
}

.drama-card__fail {
  margin: 12px 0 0;
  font-size: 12px;
  color: #dc2626;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 8px;
  padding: 8px 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== 分集明细 ===== */
.episodes {
  margin-top: 12px;
  border-top: 1px dashed var(--border);
  padding-top: 12px;
}

.episodes__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
}

.episodes__toggle:hover {
  color: var(--brand);
}

.episodes__toggle-icon {
  display: inline-block;
  transition: transform 0.15s;
  color: var(--text-muted);
}

.episodes__toggle-icon.open {
  transform: rotate(90deg);
}

.episodes__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.episode-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-muted);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}

.episode-chip:hover {
  transform: translateY(-1px);
}

.episode-chip__no {
  font-variant-numeric: tabular-nums;
}

.episode-chip__dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
}

.episode-chip.running .episode-chip__dot {
  background: #f59e0b;
  animation: pulse 1.2s ease-in-out infinite;
}

.episode-chip.completed { border-color: rgba(16, 185, 129, 0.4); color: #059669; }
.episode-chip.completed .episode-chip__dot { background: #10b981; }

.episode-chip.failed { border-color: rgba(239, 68, 68, 0.4); color: #dc2626; }
.episode-chip.failed .episode-chip__dot { background: #ef4444; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.board-empty {
  background: var(--bg-surface);
  border: 1px dashed var(--border);
  border-radius: 14px;
  padding: 40px;
  text-align: center;
}

.board-empty p {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.board-empty .muted {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
}
</style>
