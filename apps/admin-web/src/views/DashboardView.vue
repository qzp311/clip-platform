<template>
  <div class="dashboard-page">
    <div class="page-header">
      <div class="page-header__text">
        <h2>仪表盘</h2>
        <p class="page-header__desc">平台任务总览、Agent 历史表现与执行趋势</p>
      </div>
      <div class="page-header__tools">
        <span class="last-updated">最后更新 {{ lastUpdated ? formatTime(lastUpdated) : "-" }}</span>
        <button class="btn secondary btn-sm" :disabled="loading" @click="loadAll">
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- 概览卡 -->
    <div class="overview-grid">
      <div class="overview-card" :class="{ loading: !summaryLoaded }">
        <div class="overview-card__icon icon-tasks">▦</div>
        <div class="overview-card__body">
          <div class="overview-card__value">{{ today.taskCount }}</div>
          <div class="overview-card__label">今日任务</div>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-card__icon icon-ok">✓</div>
        <div class="overview-card__body">
          <div class="overview-card__value text-ok">{{ today.taskSuccess }}</div>
          <div class="overview-card__label">今日成功</div>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-card__icon icon-fail">✕</div>
        <div class="overview-card__body">
          <div class="overview-card__value text-fail">{{ today.taskFail }}</div>
          <div class="overview-card__label">今日失败</div>
        </div>
      </div>
      <div class="overview-card">
        <div class="overview-card__icon icon-device">▣</div>
        <div class="overview-card__body">
          <div class="overview-card__value">{{ onlineAgents }}<span class="overview-card__sub">/{{ agents.length }}</span></div>
          <div class="overview-card__label">在线 Agent</div>
        </div>
      </div>
    </div>

    <!-- 图表区 -->
    <div class="charts-grid">
      <div class="card chart-card">
        <div class="card-head">
          <h3>任务趋势（近 14 天）</h3>
          <div class="trend-legend">
            <span class="legend-dot dot-total" />总量
            <span class="legend-dot dot-ok" />成功
            <span class="legend-dot dot-fail" />失败
          </div>
        </div>
        <div class="card-body chart-body">
          <ChartPanel v-if="trendOption" :option="trendOption" :height="280" />
          <p v-else class="chart-empty">暂无趋势数据</p>
        </div>
      </div>
      <div class="card chart-card">
        <div class="card-head">
          <h3>任务状态分布（全部）</h3>
        </div>
        <div class="card-body chart-body">
          <ChartPanel v-if="statusOption" :option="statusOption" :height="280" />
          <p v-else class="chart-empty">暂无任务数据</p>
        </div>
      </div>
    </div>

    <!-- Agent 历史表现 -->
    <div class="card agents-card">
      <div class="card-head">
        <h3>Agent 历史表现</h3>
        <div class="card-head__tools">
          <select v-model.number="agentDays" @change="loadAgents">
            <option :value="0">全部历史</option>
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
          </select>
        </div>
      </div>
      <div class="card-body">
        <table v-if="sortedAgents.length">
          <thead>
            <tr>
              <th class="sortable" @click="sortBy('machineName')">服务器</th>
              <th class="sortable" @click="sortBy('taskTotal')">任务总数</th>
              <th>成功 / 失败</th>
              <th class="sortable" @click="sortBy('successRate')">成功率</th>
              <th class="sortable" @click="sortBy('avgWallSec')">平均耗时</th>
              <th class="sortable" @click="sortBy('p95WallSec')">P95 耗时</th>
              <th class="sortable" @click="sortBy('lastActiveAt')">最近执行</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in sortedAgents" :key="a.deviceId">
              <td>
                <span class="agent-name">
                  <span :class="['presence-dot', a.online ? 'on' : 'off']" />
                  {{ a.machineName }}
                </span>
              </td>
              <td>
                {{ a.taskTotal }}
                <span v-if="a.running > 0" class="running-badge">{{ a.running }} 执行中</span>
              </td>
              <td>
                <span class="text-ok">{{ a.taskSuccess }}</span>
                <span class="muted"> / </span>
                <span class="text-fail">{{ a.taskFail }}</span>
              </td>
              <td>
                <span v-if="a.successRate == null" class="muted">-</span>
                <template v-else>
                  <span class="rate-pill" :class="rateClass(a.successRate)">{{ a.successRate }}%</span>
                </template>
              </td>
              <td>
                <div class="duration-cell">
                  <span>{{ a.avgWallSec != null ? formatDuration(a.avgWallSec) : "-" }}</span>
                  <span
                    v-if="a.avgWallSec != null"
                    class="duration-bar"
                    :style="{ width: durationBarWidth(a.avgWallSec) }"
                  />
                </div>
              </td>
              <td>{{ a.p95WallSec != null ? formatDuration(a.p95WallSec) : "-" }}</td>
              <td class="muted">{{ a.lastActiveAt ? formatTime(a.lastActiveAt) : "-" }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="table-empty">暂无 Agent 执行记录</p>
      </div>
    </div>

    <div class="page-actions">
      <button class="btn secondary" @click="resetDemo">重置演示任务</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { EChartsCoreOption } from "echarts/core";
import { api } from "../api";
import ChartPanel from "../components/ChartPanel.vue";
import { formatDurationSec as formatDuration } from "../utils/format-duration";

interface AgentRow {
  deviceId: string;
  machineName: string;
  online: boolean;
  taskTotal: number;
  taskSuccess: number;
  taskFail: number;
  running: number;
  successRate: number | null;
  avgWallSec: number | null;
  p50WallSec: number | null;
  p95WallSec: number | null;
  firstSeenAt: string | null;
  lastActiveAt: string | null;
}

const REFRESH_MS = 15_000;

const loading = ref(false);
const summaryLoaded = ref(false);
const lastUpdated = ref<Date | null>(null);
const today = ref({ taskCount: 0, taskSuccess: 0, taskFail: 0, deviceCount: 0 });
const agents = ref<AgentRow[]>([]);
const agentDays = ref(0);
const trend = ref<Array<{ day: string; total: number; success: number; fail: number }>>([]);
const statusCounts = ref<Record<string, number>>({});

const sortKey = ref<keyof AgentRow>("taskTotal");
const sortDesc = ref(true);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const onlineAgents = computed(() => agents.value.filter((a) => a.online).length);

const sortedAgents = computed(() => {
  const rows = [...agents.value];
  const key = sortKey.value;
  rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
    return sortDesc.value ? -cmp : cmp;
  });
  return rows;
});

const maxAvgSec = computed(() =>
  Math.max(1, ...agents.value.map((a) => a.avgWallSec ?? 0)),
);

function durationBarWidth(sec: number): string {
  return `${Math.max(4, Math.round((sec / maxAvgSec.value) * 100))}%`;
}

function rateClass(rate: number): string {
  if (rate >= 95) return "good";
  if (rate >= 80) return "mid";
  return "bad";
}

function sortBy(key: keyof AgentRow): void {
  if (sortKey.value === key) {
    sortDesc.value = !sortDesc.value;
  } else {
    sortKey.value = key;
    sortDesc.value = true;
  }
}

function formatTime(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("zh-CN", { hour12: false });
}

/** 趋势数据补零：起止日期之间缺失的天填 0 */
const filledTrend = computed(() => {
  const byDay = new Map(trend.value.map((t) => [t.day, t]));
  const out: Array<{ day: string; total: number; success: number; fail: number }> = [];
  const end = new Date();
  const start = new Date(Date.now() - 13 * 86_400_000);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    out.push({ day: key, total: hit?.total ?? 0, success: hit?.success ?? 0, fail: hit?.fail ?? 0 });
  }
  return out;
});

const trendOption = computed<EChartsCoreOption | null>(() => {
  if (!filledTrend.value.length) return null;
  const rows = filledTrend.value;
  return {
    grid: { left: 40, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.day.slice(5)),
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#94a3b8", fontSize: 11 },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      splitLine: { lineStyle: { color: "#eef2f7" } },
      axisLabel: { color: "#94a3b8", fontSize: 11 },
    },
    series: [
      {
        name: "总量",
        type: "line",
        smooth: true,
        symbolSize: 6,
        data: rows.map((r) => r.total),
        lineStyle: { width: 2.5, color: "#4f46e5" },
        itemStyle: { color: "#4f46e5" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(79,70,229,0.18)" },
              { offset: 1, color: "rgba(79,70,229,0.01)" },
            ],
          },
        },
      },
      {
        name: "成功",
        type: "line",
        smooth: true,
        symbolSize: 5,
        data: rows.map((r) => r.success),
        lineStyle: { width: 2, color: "#059669" },
        itemStyle: { color: "#059669" },
      },
      {
        name: "失败",
        type: "line",
        smooth: true,
        symbolSize: 5,
        data: rows.map((r) => r.fail),
        lineStyle: { width: 2, color: "#dc2626" },
        itemStyle: { color: "#dc2626" },
      },
    ],
  };
});

const STATUS_META: Array<{ key: string; label: string; color: string }> = [
  { key: "pending", label: "待领取", color: "#f59e0b" },
  { key: "claimed", label: "已领取", color: "#3b82f6" },
  { key: "processing", label: "执行中", color: "#6366f1" },
  { key: "completed", label: "已完成", color: "#059669" },
  { key: "failed", label: "失败", color: "#dc2626" },
];

const statusOption = computed<EChartsCoreOption | null>(() => {
  const data = STATUS_META.map((s) => ({
    name: s.label,
    value: statusCounts.value[s.key] ?? 0,
    itemStyle: { color: s.color },
  })).filter((d) => d.value > 0);
  if (!data.length) return null;
  return {
    tooltip: { trigger: "item", formatter: "{b}: {c}（{d}%）" },
    legend: { bottom: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: "#64748b", fontSize: 12 } },
    series: [
      {
        type: "pie",
        radius: ["52%", "74%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 4 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 14, fontWeight: 600, formatter: "{b}\n{c} 个" },
        },
        data,
      },
    ],
  };
});

async function loadSummary() {
  const res = await api.getDailyStats({ limit: 1, offset: 0 });
  today.value = res.summary;
  summaryLoaded.value = true;
}

async function loadAgents() {
  const res = await api.getAgentSummary(agentDays.value ? { days: agentDays.value } : undefined);
  agents.value = res.agents ?? [];
}

async function loadTrend() {
  const res = await api.getTaskTrend({ days: 14 });
  trend.value = res.trend ?? [];
}

/** 状态分布：一次拉全量各状态计数（limit=1 只取 total） */
async function loadStatusCounts() {
  const entries = await Promise.all(
    STATUS_META.map(async (s) => {
      const res = await api.listTasks({ status: s.key, limit: 1, offset: 0 });
      return [s.key, res.total] as const;
    }),
  );
  statusCounts.value = Object.fromEntries(entries);
}

async function loadAll() {
  loading.value = true;
  try {
    await Promise.all([loadSummary(), loadAgents(), loadTrend(), loadStatusCounts()]);
    lastUpdated.value = new Date();
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadAll();
  refreshTimer = setInterval(() => void loadAll(), REFRESH_MS);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

async function resetDemo() {
  await api.resetDemo();
  void loadAll();
}
</script>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  gap: 10px;
  flex-shrink: 0;
}

.last-updated {
  font-size: 12px;
  color: var(--text-muted);
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.overview-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

.overview-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  font-size: 18px;
  color: #fff;
  flex-shrink: 0;
}

.icon-tasks { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.icon-ok { background: linear-gradient(135deg, #10b981, #059669); }
.icon-fail { background: linear-gradient(135deg, #f87171, #dc2626); }
.icon-device { background: linear-gradient(135deg, #38bdf8, #0284c7); }

.overview-card__value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.1;
}

.overview-card__sub {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted);
}

.overview-card__label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.text-ok { color: #059669; }
.text-fail { color: #dc2626; }

.charts-grid {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 14px;
}

.chart-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chart-card .card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.chart-card .card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.chart-body {
  padding: 12px 10px 8px;
}

.chart-empty {
  margin: 0;
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

.trend-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-total { background: #4f46e5; }
.dot-ok { background: #059669; }
.dot-fail { background: #dc2626; }

.agents-card .card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.agents-card .card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.card-head__tools select {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: var(--bg-surface);
}

.agents-card .card-body {
  padding: 6px 16px 14px;
  overflow-x: auto;
}

th.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

th.sortable:hover {
  color: var(--brand);
}

.agent-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text);
}

.presence-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.presence-dot.on {
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
}

.presence-dot.off {
  background: #cbd5e1;
}

.running-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--brand);
  background: var(--brand-soft);
}

.rate-pill {
  display: inline-block;
  min-width: 48px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.rate-pill.good { color: #047857; background: #d1fae5; }
.rate-pill.mid { color: #b45309; background: #fef3c7; }
.rate-pill.bad { color: #b91c1c; background: #fee2e2; }

.duration-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 140px;
}

.duration-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(90deg, #6366f1, #8b5cf6);
}

.table-empty {
  margin: 0;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

.page-actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 1080px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .charts-grid {
    grid-template-columns: 1fr;
  }
}
</style>
