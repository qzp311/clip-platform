<template>
  <div>
    <h2>短剧入库</h2>
    <p class="hint">
      批量登记来源平台 <strong>剧名 + 短剧 ID</strong>，跟踪读取、下载、上传、入库等运营进度。与
      <RouterLink to="/dramas">短剧库</RouterLink>
      的 zip 压缩包任务相互独立。
    </p>

    <p v-if="message" :class="['msg', messageOk ? 'ok' : 'err']">{{ message }}</p>

    <div class="card">
      <h3>批量录入</h3>
      <div class="card-body">
        <p class="hint">
          每行一条，格式：<strong>剧名|短剧ID</strong>，类型统一使用下方默认类型。
          仅当某行需要不同类型时，可写 <strong>剧名|短剧ID|类型</strong> 单独覆盖。
        </p>
        <div class="filters-row">
          <label>
            默认类型
            <select v-model="defaultDramaType">
              <option v-for="opt in dramaTypeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
        </div>
        <textarea
          v-model="batchText"
          rows="8"
          placeholder="霸道总裁爱上我|123456&#10;重生之我在古代|789012"
        />
        <div class="dclip-actions dclip-actions--plain">
          <button
            class="btn"
            :disabled="submitting || !parsedBatch.length"
            @click="submitBatch"
          >
            {{ submitting ? "提交中…" : `批量录入 ${parsedBatch.length} 条` }}
          </button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>清单列表</h3>
      <div v-if="statusSummary.length" class="status-summary">
        <button
          v-for="item in statusSummary"
          :key="item.status"
          type="button"
          :class="['chip', { active: statusFilter === item.status }]"
          @click="toggleStatusFilter(item.status)"
        >
          {{ item.label }} {{ item.count }}
        </button>
        <button
          type="button"
          :class="['chip', { active: !statusFilter }]"
          @click="toggleStatusFilter('')"
        >
          全部 {{ total }}
        </button>
      </div>
      <div class="card-body filters-row">
        <label>
          状态
          <select v-model="statusFilter" @change="reload">
            <option value="">全部</option>
            <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <label>
          类型
          <select v-model="typeFilter" @change="reload">
            <option value="">全部</option>
            <option v-for="opt in dramaTypeOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <label>
          搜索
          <input v-model="search" placeholder="剧名或短剧 ID" @keyup.enter="reload" />
        </label>
        <button type="button" class="btn secondary" @click="reload">查询</button>
      </div>
      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="msg err">{{ error }}</p>
      <table>
        <thead>
          <tr>
            <th>剧名</th>
            <th>简介</th>
            <th>短剧 ID</th>
            <th>类型</th>
            <th>状态</th>
            <th>备注</th>
            <th>关联任务</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !items.length && !error">
            <td colspan="9" class="empty">暂无待入库条目</td>
          </tr>
          <tr v-for="item in items" :key="String(item.intakeId)">
            <td>{{ item.title }}</td>
            <td class="synopsis-cell" :title="String(item.synopsis ?? '')">
              {{ item.synopsis || "（未填）" }}
            </td>
            <td class="mono">{{ item.externalDramaId }}</td>
            <td>
              <select
                class="status-select"
                :value="String(item.dramaType ?? 'short')"
                :disabled="updatingId === String(item.intakeId)"
                @change="onFieldChange(item, 'dramaType', $event)"
              >
                <option v-for="opt in dramaTypeOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </td>
            <td>
              <select
                class="status-select"
                :value="String(item.status)"
                :disabled="updatingId === String(item.intakeId)"
                @change="onFieldChange(item, 'status', $event)"
              >
                <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </td>
            <td class="note-cell" :title="String(item.note ?? '')">{{ item.note || "-" }}</td>
            <td>
              <RouterLink v-if="item.linkedTaskId" :to="`/tasks/${item.linkedTaskId}`">
                {{ item.linkedTaskId }}
              </RouterLink>
              <span v-else class="muted">-</span>
            </td>
            <td>{{ item.updatedAt }}</td>
            <td class="actions">
              <button
                v-if="item.status === 'downloaded' || item.status === 'uploaded'"
                class="btn btn-xs"
                :disabled="activatingId === String(item.intakeId)"
                @click="openActivateDialog(item)"
              >
                {{ activatingId === String(item.intakeId) ? "激活中…" : "激活" }}
              </button>
              <button
                class="btn btn-xs danger"
                :disabled="deletingId === String(item.intakeId)"
                @click="deleteItem(String(item.intakeId))"
              >
                {{ deletingId === String(item.intakeId) ? "删除中…" : "删除" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <ListPager :total="total" :limit="limit" :offset="offset" @prev="prevPage" @next="nextPage" />
    </div>

    <!-- 手动激活剧包弹窗：用于 tos-auto-upload 上传成功后激活接口失败等兜底场景 -->
    <div v-if="activateDialog.open" class="modal-overlay" @click.self="closeActivateDialog">
      <div class="modal-card">
        <h3>手动激活剧包</h3>
        <p class="hint">
          把已上传到 TOS 的 zip 下载地址填进去，系统会创建 drama_package 混剪任务。
        </p>
        <label>
          剧名
          <input :value="activateDialog.item?.title" disabled />
        </label>
        <label>
          短剧 ID
          <input :value="activateDialog.item?.externalDramaId" disabled />
        </label>
        <label>
          zip 下载地址（sourceUrl）
          <input v-model="activateDialog.sourceUrl" placeholder="https://bucket.tos-xxx.volces.com/sources/packages/xxx.zip" />
        </label>
        <label>
          packageName（可选）
          <input v-model="activateDialog.packageName" placeholder="剧名_短剧ID.zip" />
        </label>
        <label>
          ASR 规则集（可选）
          <input v-model="activateDialog.asrRuleSetId" placeholder="drama-default-v1" />
        </label>
        <label>
          预期集数（可选）
          <input v-model.number="activateDialog.expectedEpisodeCount" type="number" min="1" placeholder="不填则按 zip 内容自动识别" />
        </label>
        <div class="dclip-actions dclip-actions--plain">
          <button class="btn" :disabled="activatingId !== ''" @click="submitActivate">
            {{ activatingId !== "" ? "激活中…" : "确认激活" }}
          </button>
          <button class="btn secondary" @click="closeActivateDialog">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";

const items = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const limit = PAGE_SIZE;
const offset = ref(0);
const loading = ref(false);
const error = ref("");
const message = ref("");
const messageOk = ref(true);
const batchText = ref("");
const submitting = ref(false);
const statusFilter = ref("");
const typeFilter = ref("");
const search = ref("");
const defaultDramaType = ref("short");
const statusCounts = ref<Record<string, number>>({});
const updatingId = ref("");
const deletingId = ref("");
const activatingId = ref("");
const activateDialog = ref<{
  open: boolean;
  item: Record<string, unknown> | null;
  sourceUrl: string;
  packageName: string;
  asrRuleSetId: string;
  expectedEpisodeCount: number | undefined;
}>({
  open: false,
  item: null,
  sourceUrl: "",
  packageName: "",
  asrRuleSetId: "drama-default-v1",
  expectedEpisodeCount: undefined,
});

const DRAMA_TYPE_OPTIONS = [
  { value: "comic", label: "漫剧" },
  { value: "short", label: "短剧" },
  { value: "paid_comic", label: "付费漫剧" },
  { value: "paid_short", label: "付费短剧" },
] as const;

const dramaTypeOptions = DRAMA_TYPE_OPTIONS;

const STATUS_OPTIONS = [
  { value: "pending", label: "待处理" },
  { value: "read", label: "已读取" },
  { value: "downloaded", label: "已下载" },
  { value: "uploaded", label: "已上传" },
  { value: "queued", label: "已建任务" },
  { value: "ingesting", label: "入库中" },
  { value: "ingested", label: "已入库" },
  { value: "failed", label: "失败" },
  { value: "skipped", label: "已跳过" },
] as const;

const statusOptions = STATUS_OPTIONS;

function normalizeDramaType(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const aliases: Record<string, string> = {
    comic: "comic",
    short: "short",
    paid_comic: "paid_comic",
    paid_short: "paid_short",
    漫剧: "comic",
    短剧: "short",
    付费漫剧: "paid_comic",
    付费短剧: "paid_short",
  };
  return aliases[value] ?? aliases[value.toLowerCase()];
}

const parsedBatch = computed(() => {
  const rows: Array<{ title: string; externalDramaId: string; dramaType: string }> = [];
  for (const line of batchText.value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|").map((part) => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const dramaType = normalizeDramaType(parts[2]) ?? defaultDramaType.value;
    rows.push({ title: parts[0], externalDramaId: parts[1], dramaType });
  }
  return rows;
});

const statusSummary = computed(() =>
  STATUS_OPTIONS.map((opt) => ({
    status: opt.value,
    label: opt.label,
    count: statusCounts.value[opt.value] ?? 0,
  })).filter((item) => item.count > 0),
);

onMounted(() => {
  void loadItems();
});

async function loadItems() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api.listDramaIntake({
      limit,
      offset: offset.value,
      status: statusFilter.value || "all",
      dramaType: typeFilter.value || undefined,
      q: search.value.trim() || undefined,
    });
    items.value = res.items;
    total.value = res.total;
    statusCounts.value = res.statusCounts ?? {};
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

function reload() {
  offset.value = 0;
  void loadItems();
}

function toggleStatusFilter(status: string) {
  statusFilter.value = status;
  reload();
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit);
  void loadItems();
}

function nextPage() {
  offset.value += limit;
  void loadItems();
}

function wrapDramaTitle(title: string): string {
  const t = title.trim();
  if (!t) return t;
  const start = t.startsWith("《");
  const end = t.endsWith("》");
  if (start && end) return t;
  return `《${t.replace(/^《|》$/g, "")}》`;
}

async function submitBatch() {
  if (!parsedBatch.value.length) return;
  submitting.value = true;
  message.value = "";
  try {
    const res = await api.batchCreateDramaIntake(
      parsedBatch.value.map((item) => ({
        ...item,
        title: wrapDramaTitle(item.title),
      })),
    );
    const createdCount = Array.isArray(res.created) ? res.created.length : 0;
    const dupCount = Array.isArray(res.duplicates) ? res.duplicates.length : 0;
    const autoQueuedCount = Array.isArray(res.autoQueued) ? res.autoQueued.length : 0;
    const errCount = Array.isArray(res.errors) ? res.errors.length : 0;
    batchText.value = "";
    const parts = [`成功录入 ${createdCount} 条`];
    if (autoQueuedCount > 0) parts.push(`重复剧直接建任务 ${autoQueuedCount} 条`);
    if (dupCount > 0) parts.push(`跳过重复 ${dupCount} 条`);
    if (errCount > 0) {
      parts.push(
        `校验失败 ${errCount} 条：${res.errors!.map((e) => `第${e.line}行 ${e.error}`).join("；")}`,
      );
    }
    message.value = parts.join("，");
    messageOk.value = (createdCount > 0 || autoQueuedCount > 0) && errCount === 0;
    void loadItems();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    submitting.value = false;
  }
}

async function onFieldChange(
  item: Record<string, unknown>,
  field: "status" | "dramaType",
  ev: Event,
) {
  const intakeId = String(item.intakeId);
  const nextValue = (ev.target as HTMLSelectElement).value;
  if (nextValue === String(item[field])) return;
  updatingId.value = intakeId;
  message.value = "";
  try {
    await api.updateDramaIntake(intakeId, { [field]: nextValue });
    await loadItems();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
    await loadItems();
  } finally {
    updatingId.value = "";
  }
}

async function deleteItem(intakeId: string) {
  if (!window.confirm("确定删除该待入库条目？")) return;
  deletingId.value = intakeId;
  message.value = "";
  try {
    await api.deleteDramaIntake(intakeId);
    message.value = "已删除";
    messageOk.value = true;
    await loadItems();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    deletingId.value = "";
  }
}

function openActivateDialog(item: Record<string, unknown>) {
  const title = String(item.title ?? "").trim();
  const externalDramaId = String(item.externalDramaId ?? "").trim();
  // 默认按命名规则生成 packageName，用户可改
  const defaultPackageName = title && externalDramaId ? `${title}_${externalDramaId}.zip` : "";
  activateDialog.value = {
    open: true,
    item,
    sourceUrl: "",
    packageName: defaultPackageName,
    asrRuleSetId: "drama-default-v1",
    expectedEpisodeCount: undefined,
  };
}

function closeActivateDialog() {
  activateDialog.value.open = false;
  activateDialog.value.item = null;
}

async function submitActivate() {
  const item = activateDialog.value.item;
  if (!item) return;
  const externalDramaId = String(item.externalDramaId ?? "").trim();
  const title = String(item.title ?? "").trim();
  const sourceUrl = activateDialog.value.sourceUrl.trim();
  const packageName = activateDialog.value.packageName.trim() || `${title}_${externalDramaId}.zip`;
  if (!externalDramaId) {
    message.value = "缺少短剧 ID";
    messageOk.value = false;
    return;
  }
  if (!title) {
    message.value = "缺少剧名";
    messageOk.value = false;
    return;
  }
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    message.value = "请输入正确的 zip 下载地址（http(s)）";
    messageOk.value = false;
    return;
  }

  // 从 sourceUrl 解析 objectKey；若解析失败可让用户后续在服务端兜底
  let packageObjectKey = "";
  try {
    const url = new URL(sourceUrl);
    packageObjectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    packageObjectKey = "";
  }

  activatingId.value = String(item.intakeId ?? "");
  message.value = "";
  try {
    const res = await api.activateDramaPackage({
      externalDramaId,
      title,
      sourceUrl,
      packageObjectKey: packageObjectKey || undefined,
      packageName,
      asrRuleSetId: activateDialog.value.asrRuleSetId.trim() || "drama-default-v1",
      expectedEpisodeCount: activateDialog.value.expectedEpisodeCount,
    });
    message.value = `已激活：taskId=${res.taskId}${res.dramaId ? ` dramaId=${res.dramaId}` : ""}`;
    messageOk.value = true;
    closeActivateDialog();
    await loadItems();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    activatingId.value = "";
  }
}
</script>

<style scoped>
.hint {
  margin: -8px 0 16px;
  color: #64748b;
  font-size: 14px;
}
.msg {
  margin: 0 0 16px;
  font-size: 14px;
}
.msg.ok {
  color: #2b8a3e;
}
.msg.err {
  color: #c92a2a;
}
.empty {
  text-align: center;
  color: #94a3b8;
  padding: 24px !important;
}
.status-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.filters-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 12px;
}
.filters-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: #475569;
}
.filters-row input,
.filters-row select {
  min-width: 160px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.note-cell {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #64748b;
}
.synopsis-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #475569;
}
.status-select {
  min-width: 108px;
  font-size: 12px;
  padding: 4px 6px;
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-card {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  width: 90%;
  max-width: 560px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
}
.modal-card h3 {
  margin: 0 0 12px;
  font-size: 18px;
}
.modal-card label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  color: #475569;
}
.modal-card input {
  padding: 6px 8px;
  font-size: 14px;
}
.modal-card input:disabled {
  background: #f1f5f9;
  color: #64748b;
}
</style>
