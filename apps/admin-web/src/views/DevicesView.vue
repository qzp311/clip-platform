<template>
  <div class="devices-page">
    <header class="page-head">
      <div>
        <h2>Agent 控制中心</h2>
        <p>远程管理剪辑客户端，在设备列表中点击「控制」设置该设备是否可领取任务。</p>
      </div>
      <button type="button" class="btn secondary" :disabled="loading" @click="loadDevices">
        {{ loading ? "刷新中…" : "刷新列表" }}
      </button>
    </header>

    <section class="stats">
      <div class="stat-card">
        <span class="num">{{ stats.total }}</span>
        <span class="lbl">注册设备</span>
      </div>
      <div class="stat-card accent-green">
        <span class="num">{{ stats.online }}</span>
        <span class="lbl">当前在线</span>
      </div>
      <div class="stat-card accent-blue">
        <span class="num">{{ stats.mixCount }}</span>
        <span class="lbl">混剪队列</span>
      </div>
      <div class="stat-card accent-purple">
        <span class="num">{{ stats.replicaCount }}</span>
        <span class="lbl">复刻队列</span>
      </div>
      <div class="stat-card accent-amber">
        <span class="num">{{ stats.agentOff }}</span>
        <span class="lbl">已停用</span>
      </div>
    </section>

    <section class="table-panel">
      <div class="table-toolbar">
        <input
          v-model="query"
          type="search"
          class="search"
          placeholder="搜索机器名、GPU、设备 ID…"
          @input="onSearchInput"
        />
        <label class="filter">
          <input v-model="onlineOnly" type="checkbox" @change="onFilterChange" />
          仅在线
        </label>
      </div>

      <div class="table-wrap">
        <table v-if="devices.length">
          <thead>
            <tr>
              <th>设备</th>
              <th>硬件</th>
              <th>服务器</th>
              <th>Agent</th>
              <th>任务队列</th>
              <th>资源</th>
              <th>最后心跳</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="d in devices"
              :key="String(d.deviceId)"
              :class="{ offline: !d.online }"
            >
              <td>
                <div class="machine">{{ d.machineId }}</div>
                <code class="device-id">{{ d.deviceId }}</code>
              </td>
              <td>
                <div>{{ d.gpuName }}</div>
                <div class="muted">{{ d.vramMb }}MB · {{ d.os }}</div>
              </td>
              <td>
                <span class="status-pill" :class="d.online ? 'on' : 'off'">
                  <span class="dot" />
                  {{ d.online ? "在线" : "离线" }}
                </span>
              </td>
              <td class="agent-col">
                <label class="toggle" :class="{ active: d.services?.agentEnabled !== false }">
                  <input type="checkbox" :checked="d.services?.agentEnabled !== false" @change="toggleAgent(d, ($event.target as HTMLInputElement).checked)" />
                  <span class="slider" />
                </label>
                <span class="muted">v{{ d.agentVersion }}</span>
              </td>
              <td class="queue-col">
                <select
                  class="queue-select"
                  :value="d.services?.taskQueue ?? 'all'"
                  :title="queueLabel(d.services?.taskQueue)"
                  @change="changeQueue(d, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="all">全部任务</option>
                  <option value="mix">混剪队列</option>
                  <option value="replica">复刻队列</option>
                </select>
              </td>
              <td>
                <span class="muted">{{ resourceLabel(d) }}</span>
              </td>
              <td>
                <span>{{ formatRelativeTime(String(d.lastSeenAt ?? "")) }}</span>
              </td>
              <td class="actions">
                <button type="button" class="btn btn-sm secondary" @click="openResource(d)">
                  资源
                </button>
                <button type="button" class="btn btn-sm secondary" @click="showTimeline(String(d.deviceId))">
                  时间线
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">
          {{ query || onlineOnly ? "没有匹配的设备" : "暂无注册设备" }}
        </div>
      </div>
      <ListPager
        :total="total"
        :limit="limit"
        :offset="offset"
        @prev="prevPage"
        @next="nextPage"
      />
    </section>

    <div v-if="timeline" class="card timeline-card">
      <div class="card-head">
        <h3>设备时间线 · {{ timeline.deviceId }}</h3>
        <button type="button" class="btn btn-sm secondary" @click="timeline = null">关闭</button>
      </div>
      <table>
        <thead>
          <tr><th>任务 ID</th><th>状态</th><th>更新时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in (timeline.tasks as Record<string, string>[])" :key="t.taskId">
            <td><code>{{ t.taskId }}</code></td>
            <td><span class="badge" :class="t.status">{{ t.status }}</span></td>
            <td>{{ t.updatedAt }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!(timeline.tasks as unknown[])?.length" class="muted empty-inline">该日暂无任务记录</p>
      <ListPager
        v-if="timelineDeviceId"
        :total="timelineTotal"
        :limit="timelineLimit"
        :offset="timelineOffset"
        @prev="prevTimelinePage"
        @next="nextTimelinePage"
      />
    </div>

    <Teleport to="body">
      <div v-if="resourceDevice" class="overlay" @click.self="resourceDevice = null">
        <aside class="drawer" role="dialog">
          <header class="drawer-head">
            <div>
              <p class="eyebrow">单设备资源策略</p>
              <h2>{{ resourceDevice.machineId }}</h2>
            </div>
            <button type="button" class="close" @click="resourceDevice = null">×</button>
          </header>
          <div class="drawer-body">
            <ResourcePolicyPanel
              title="设备覆盖"
              description="可继承全局，或设为始终满载/限流，或自定义时段。"
              save-label="保存设备策略"
              allow-inherit
              :has-override="resourceHasOverride"
              :model-value="resourceOverride"
              @save="saveDeviceResource"
            />
          </div>
        </aside>
      </div>
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";
import ResourcePolicyPanel, { type ResourcePolicyForm } from "../components/ResourcePolicyPanel.vue";
import { formatRelativeTime } from "../utils/format-time";

interface DeviceRow extends Record<string, unknown> {
  deviceId: string;
  machineId?: string;
  gpuName?: string;
  vramMb?: number;
  os?: string;
  agentVersion?: string;
  online?: boolean;
  lastSeenAt?: string;
  services?: {
    agentEnabled?: boolean;
    taskQueue?: "all" | "mix" | "replica";
    resourcePolicy?: ResourcePolicyForm;
  };
  resourcePolicyOverride?: boolean;
}

const devices = ref<DeviceRow[]>([]);
const total = ref(0);
const limit = PAGE_SIZE;
const offset = ref(0);
const timeline = ref<Record<string, unknown> | null>(null);
const timelineDeviceId = ref("");
const timelineTotal = ref(0);
const timelineLimit = PAGE_SIZE;
const timelineOffset = ref(0);
const loading = ref(false);
const query = ref("");
const onlineOnly = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const stats = reactive({
  total: 0,
  online: 0,
  agentOff: 0,
  mixCount: 0,
  replicaCount: 0,
});

const resourceDevice = ref<DeviceRow | null>(null);
const resourceOverride = ref<Partial<ResourcePolicyForm> | null>(null);
const resourceHasOverride = ref(false);
const globalResourcePolicy = ref<Partial<ResourcePolicyForm> | null>(null);

async function loadGlobal() {
  const global = await api.getGlobalConfig();
  const services = (global.services ?? {}) as Record<string, unknown>;
  globalResourcePolicy.value =
    (services.resourcePolicy as Partial<ResourcePolicyForm> | undefined) ?? null;
}

async function loadDevices() {
  loading.value = true;
  try {
    const res = await api.listDevices({
      limit,
      offset: offset.value,
      q: query.value.trim() || undefined,
      onlineOnly: onlineOnly.value,
    });
    devices.value = res.devices as DeviceRow[];
    total.value = res.total;
    Object.assign(stats, res.stats);
  } finally {
    loading.value = false;
  }
}

function onFilterChange() {
  offset.value = 0;
  void loadDevices();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    offset.value = 0;
    void loadDevices();
  }, 300);
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit);
  void loadDevices();
}

function nextPage() {
  offset.value += limit;
  void loadDevices();
}

onMounted(async () => {
  await Promise.all([loadGlobal(), loadDevices()]);
});


async function toggleAgent(d: DeviceRow, enabled: boolean) {
  try {
    await api.updateDeviceOverride(d.deviceId, { services: { agentEnabled: enabled } });
    d.services = { ...(d.services ?? {}), agentEnabled: enabled };
  } catch (e) {
    console.error('toggle agent failed', e);
    // 恢复：刷新列表拿到真实状态
    void loadDevices();
  }
}

function queueLabel(queue?: string) {
  if (queue === "mix") return "只领取混剪/短剧剪辑任务";
  if (queue === "replica") return "只领取案例复刻任务";
  return "领取全部任务";
}

function resourceLabel(d: DeviceRow): string {
  if (!d.resourcePolicyOverride) return "跟随全局";
  const p = d.services?.resourcePolicy;
  if (!p) return "跟随全局";
  if (p.scheduleEnabled === false) {
    return p.fixedMode === "throttled" ? "始终限流" : "始终满载";
  }
  return "自定义时段";
}

async function openResource(d: DeviceRow) {
  resourceDevice.value = d;
  const override = await api.getDeviceOverride(d.deviceId);
  const services = (override?.services ?? {}) as Record<string, unknown>;
  const policy = services.resourcePolicy as Partial<ResourcePolicyForm> | undefined;
  resourceHasOverride.value = Boolean(policy);
  resourceOverride.value = policy ?? globalResourcePolicy.value;
}

async function saveDeviceResource(payload: ResourcePolicyForm | null) {
  if (!resourceDevice.value) return;
  await api.updateDeviceOverride(resourceDevice.value.deviceId, {
    services: { resourcePolicy: payload },
  });
  resourceHasOverride.value = payload != null;
  resourceOverride.value = payload ?? globalResourcePolicy.value;
  await loadDevices();
}

async function changeQueue(d: DeviceRow, queue: string) {
  const value = (queue === "mix" || queue === "replica" ? queue : "all") as "all" | "mix" | "replica";
  try {
    await api.updateDeviceOverride(d.deviceId, { services: { taskQueue: value } });
    d.services = { ...(d.services ?? {}), taskQueue: value };
  } catch (e) {
    console.error('change queue failed', e);
    void loadDevices();
  }
}

async function showTimeline(id: string) {
  timelineDeviceId.value = id;
  timelineOffset.value = 0;
  await loadTimeline();
}

async function loadTimeline() {
  if (!timelineDeviceId.value) return;
  timeline.value = await api.deviceTimeline(timelineDeviceId.value, {
    limit: timelineLimit,
    offset: timelineOffset.value,
  });
  timelineTotal.value = Number(timeline.value?.total ?? 0);
}

function prevTimelinePage() {
  timelineOffset.value = Math.max(0, timelineOffset.value - timelineLimit);
  void loadTimeline();
}

function nextTimelinePage() {
  timelineOffset.value += timelineLimit;
  void loadTimeline();
}
</script>

<style scoped>
.devices-page {
  width: 100%;
  min-height: calc(100vh - 48px);
  min-height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}
.page-head h2 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.02em;
}
.page-head p {
  margin: 0;
  font-size: 14px;
  color: #64748b;
  line-height: 1.5;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.stat-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-card .num {
  font-size: 26px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1;
}
.stat-card .lbl {
  font-size: 12px;
  color: #64748b;
}
.stat-card.accent-green .num { color: #059669; }
.stat-card.accent-amber .num { color: #d97706; }
.stat-card.accent-red .num { color: #dc2626; }
.stat-card.accent-blue .num { color: #2563eb; }
.stat-card.accent-purple .num { color: #7c3aed; }
.table-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 320px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
}
.table-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid #f1f5f9;
  background: #fafbfc;
}
.search {
  flex: 1;
  max-width: 360px;
  padding: 9px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  font-size: 14px;
  background: #fff;
}
.search:focus {
  outline: none;
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}
.filter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #475569;
  cursor: pointer;
  user-select: none;
}
.table-wrap {
  flex: 1;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  text-align: left;
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #64748b;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}
td {
  padding: 14px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
  font-size: 13px;
}
tr:last-child td {
  border-bottom: none;
}
tr.offline .machine {
  color: #94a3b8;
}
tr.offline .device-id {
  color: #c8d1dc;
}
.machine {
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 2px;
}
.device-id {
  font-size: 10px;
  color: #94a3b8;
  background: #f8fafc;
  padding: 2px 5px;
  border-radius: 4px;
}
.agent-col {
  white-space: nowrap;
}
.queue-col {
  white-space: nowrap;
}
.queue-select {
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 13px;
  background: #fff;
  color: #0f172a;
  cursor: pointer;
}
.queue-select:focus {
  outline: none;
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}
.agent-col .toggle {
  vertical-align: middle;
  margin-right: 8px;
}
.agent-col .muted {
  vertical-align: middle;
}
.toggle {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
  cursor: pointer;
}
.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #cbd5e1;
  transition: 0.2s;
  border-radius: 999px;
}
.slider::before {
  content: "";
  position: absolute;
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: 0.2s;
}
.toggle.active .slider {
  background: #3b82f6;
}
.toggle.active input:checked + .slider::before {
  transform: translateX(16px);
}
.muted {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}
.mono {
  font-family: ui-monospace, monospace;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.status-pill.on {
  background: #ecfdf5;
  color: #047857;
}
.status-pill.disabled {
  background: #fef3c7;
  color: #92400e;
}
.status-pill.off {
  background: #f1f5f9;
  color: #64748b;
}
.status-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.empty {
  padding: 48px 20px;
  text-align: center;
  color: #94a3b8;
  font-size: 14px;
}
.timeline-card {
  margin-top: 16px;
}
.empty-inline {
  margin: 8px 0 0;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(560px, 100vw);
  height: 100%;
  background: #fff;
  box-shadow: -8px 0 32px rgba(15, 23, 42, 0.12);
  display: flex;
  flex-direction: column;
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 18px 20px;
  border-bottom: 1px solid #f1f5f9;
}
.drawer-head h2 {
  margin: 0;
  font-size: 18px;
}
.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
}
.close {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: #f1f5f9;
  font-size: 22px;
  cursor: pointer;
}
.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
@media (max-width: 900px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .page-head {
    flex-direction: column;
  }
}
</style>
