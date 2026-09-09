<template>
  <div class="remix-replica-page">
    <!-- 页面标题区 -->
    <div class="page-header">
      <div class="page-header__text">
        <h2>案例复刻</h2>
        <p class="page-header__desc">
          上传案例视频，系统在原片里找到相同画面并 1:1 复刻输出成片。
          支持「已有短剧」直接复刻，或「新短剧入库并复刻」。
        </p>
      </div>
    </div>

    <!-- 全局提示 -->
    <div class="page-alerts">
      <p v-if="!tosReady" class="msg err">
        TOS 未启用或配置不完整，请先在
        <RouterLink to="/config">系统配置</RouterLink>
        中开启「火山云 TOS」并填写 bucket / 密钥。
      </p>
      <p v-if="message" :class="['msg', messageOk ? 'ok' : 'err']">{{ message }}</p>
    </div>

    <!-- 创建表单 -->
    <div class="card remix-form-card">
      <div class="card-head">
        <h3>创建复刻任务</h3>
        <div class="mode-tabs">
          <button
            type="button"
            class="mode-tab"
            :class="{ active: mode === 'existing' }"
            @click="mode = 'existing'"
          >
            已有短剧
          </button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: mode === 'new' }"
            @click="mode = 'new'"
          >
            新短剧入库并复刻
          </button>
        </div>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <div class="field field-full">
            <label>案例视频 <span class="required">*</span></label>
            <div class="file-picker">
              <input
                ref="caseFileInputRef"
                type="file"
                accept="video/*"
                class="file-input"
                @change="onCaseFileChange"
              />
              <button type="button" class="btn secondary" @click="pickCaseFile">
                选择视频文件
              </button>
              <span v-if="caseFile" class="file-name">{{ caseFile.name }}</span>
              <span v-else class="muted">支持 mp4 / mov 等常见视频格式</span>
            </div>
            <div v-if="caseUploadProgress >= 0 && caseUploadProgress < 100" class="upload-progress">
              <div class="upload-progress__bar">
                <div class="upload-progress__fill" :style="{ width: `${caseUploadProgress}%` }" />
              </div>
              <span class="upload-progress__text">上传案例视频 TOS {{ caseUploadProgress }}%</span>
            </div>
          </div>

          <template v-if="mode === 'existing'">
            <div class="field">
              <label>选择短剧 <span class="required">*</span></label>
              <select v-model="selectedDramaId" :disabled="dramasLoading">
                <option value="">请选择已入库短剧</option>
                <option v-for="d in dramas" :key="d.dramaId" :value="d.dramaId">
                  {{ d.title }}
                </option>
              </select>
              <p class="field-hint">原片直接使用该剧已入库的分集 URL</p>
            </div>
          </template>

          <template v-else>
            <div class="field">
              <label>短剧名称 <span class="required">*</span></label>
              <input v-model="newDramaTitle" placeholder="例如：霸道总裁爱上我" />
            </div>
            <div class="field">
              <label>短剧 ID（外部平台 ID） <span class="required">*</span></label>
              <input v-model="externalDramaId" placeholder="例如：123456" />
            </div>
            <div class="field">
              <label>类型 <span class="required">*</span></label>
              <select v-model="dramaType">
                <option value="short">短剧</option>
                <option value="paid_short">付费短剧</option>
                <option value="comic">漫画</option>
                <option value="paid_comic">付费漫画</option>
              </select>
            </div>
            <div class="field field-full">
              <div class="info-box">
                <p>
                  提交后先创建「短剧入库」记录，运营按
                  <RouterLink to="/drama-intake">短剧入库</RouterLink>
                  流程上传原片 zip 并激活后，系统会自动为本案例视频创建复刻任务。
                </p>
              </div>
            </div>
          </template>
        </div>

        <!-- 高级选项：裂变 + 上传专辑 -->
        <div class="advanced-section">
          <div class="advanced-toggle" @click="showAdvanced = !showAdvanced">
            <span class="advanced-title">高级选项（裂变）</span>
            <span class="advanced-arrow" :class="{ open: showAdvanced }">▶</span>
          </div>

          <div v-if="showAdvanced" class="advanced-body">
            <div class="form-grid">
              <!-- 裂变开关 -->
              <div class="field field-full fission-header">
                <label class="switch">
                  <input v-model="fissionEnabled" type="checkbox" />
                  <span class="switch-slider" />
                  <span class="switch-label">启用裂变</span>
                </label>
                <p class="field-hint">复刻完成后，对主成片进行自动裂变</p>
              </div>

              <!-- 裂变数量 -->
              <div v-if="fissionEnabled" class="field">
                <label>裂变数量 <span class="required">*</span></label>
                <input v-model.number="fissionCount" type="number" min="1" max="500" placeholder="例如：5" />
                <p class="field-hint">每个成片生成多少条裂变素材</p>
              </div>

              <!-- 裂变维度 -->
              <div v-if="fissionEnabled" class="field field-full">
                <label>裂变维度（默认全部）</label>
                <div class="op-checkboxes">
                  <label
                    v-for="op in fissionOps"
                    :key="op.kind"
                    class="op-checkbox"
                    :class="{ checked: selectedFissionOps.includes(op.kind) }"
                  >
                    <input v-model="selectedFissionOps" type="checkbox" :value="op.kind" />
                    <span>{{ op.label }}</span>
                  </label>
                </div>
              </div>

            </div>
          </div>
        </div>

        <div class="dclip-actions dclip-actions--plain">
          <button class="btn" :disabled="submitting || !canSubmit" @click="submit">
            {{ submitting ? submitLabel : "创建复刻任务" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 列表 -->
    <div class="card remix-list-card">
      <div class="card-head">
        <h3>复刻任务列表</h3>
        <div class="card-head__tools">
          <select v-model="listDramaId" @change="loadJobs">
            <option value="">全部剧目</option>
            <option v-for="d in dramas" :key="d.dramaId" :value="d.dramaId">{{ d.title }}</option>
          </select>
          <button class="btn secondary btn-sm" :disabled="jobsLoading" @click="loadJobs">刷新</button>
        </div>
      </div>

      <p v-if="jobsLoading" class="hint table-loading">加载中…</p>
      <p v-else-if="jobsError" class="msg err table-empty">{{ jobsError }}</p>
      <table v-else>
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>短剧</th>
            <th>案例视频</th>
            <th>状态</th>
            <th>成片链接</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!displayJobs.length">
            <td colspan="7" class="empty">暂无复刻任务</td>
          </tr>
          <tr v-for="job in displayJobs" :key="job.jobId">
            <td class="mono">{{ job.jobId }}</td>
            <td>{{ dramaTitle(job.dramaId) }}</td>
            <td class="url-cell" :title="job.caseVideoUrl">{{ job.caseVideoUrl }}</td>
            <td><span :class="['badge', job.status]">{{ job.status }}</span></td>
            <td class="url-cell">
              <a v-if="job.outputUrl" :href="job.outputUrl" target="_blank" rel="noopener">下载成片</a>
              <span v-else class="muted">-</span>
            </td>
            <td>{{ formatDate(job.updatedAt) }}</td>
            <td class="actions">
              <button
                class="btn btn-xs secondary"
                :disabled="retryingId === job.jobId || job.status === 'waiting_intake'"
                @click="retry(job.jobId)"
              >
                {{ retryingId === job.jobId ? "重跑中…" : "重跑" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { uploadFileToPresignedUrl } from "../utils/drama-package-upload";

interface DramaOption {
  dramaId: string;
  title: string;
}

interface RemixJob {
  jobId: string;
  dramaId: string | null;
  caseVideoUrl: string;
  status: string;
  outputUrl?: string;
  createdAt: string;
  updatedAt: string;
}

const mode = ref<"existing" | "new">("existing");

const dramas = ref<DramaOption[]>([]);
const dramasLoading = ref(false);
const selectedDramaId = ref("");
const newDramaTitle = ref("");
const externalDramaId = ref("");
const dramaType = ref("short");

const caseFile = ref<File | null>(null);
const caseFileInputRef = ref<HTMLInputElement | null>(null);
const caseUploadProgress = ref(-1);

const jobs = ref<RemixJob[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const listDramaId = ref("");

const submitting = ref(false);
const submitLabel = ref("提交中…");
const message = ref("");
const messageOk = ref(true);
const tosReady = ref(true);
const retryingId = ref("");

// 高级选项
const showAdvanced = ref(false);
const fissionEnabled = ref(false);
const fissionCount = ref<number | undefined>(undefined);
const fissionOps = [
  { kind: "color", label: "智能调色" },
  { kind: "sharpen", label: "画面锐化" },
  { kind: "zoom", label: "缩放画面" },
  { kind: "speed", label: "视频加速" },
  { kind: "drop_frames", label: "随机抽帧" },
  { kind: "trim_ends", label: "掐头去尾" },
  { kind: "mirror", label: "视频镜像" },
];
const selectedFissionOps = ref<string[]>([]);


const canSubmit = computed(() => {
  // 素材库模式也必须有剧目上下文（已有短剧 or 新短剧表单完整）
  const dramaReady =
    mode.value === "existing"
      ? Boolean(selectedDramaId.value)
      : Boolean(newDramaTitle.value.trim()) && Boolean(externalDramaId.value.trim());
  return Boolean(caseFile.value) && dramaReady;
});

const filteredJobs = computed(() => {
  if (!listDramaId.value) return jobs.value;
  return jobs.value.filter((j) => j.dramaId === listDramaId.value);
});

const displayJobs = computed(() => {
  // 后端按剧目筛选，前端只做排序兜底
  return filteredJobs.value.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
});

onMounted(async () => {
  dramasLoading.value = true;
  try {
    await Promise.all([loadDramas(), loadTosStatus()]);
    await loadJobs();
  } finally {
    dramasLoading.value = false;
  }
});

async function loadDramas() {
  const res = await api.listDramas({ limit: 1000, offset: 0 });
  dramas.value = ((res.dramas ?? []) as unknown as DramaOption[]);
}

async function loadTosStatus() {
  try {
    const global = await api.getGlobalConfig();
    const render = global.render as Record<string, unknown> | undefined;
    const tos = (render?.storage as Record<string, unknown> | undefined)?.tos as
      | Record<string, unknown>
      | undefined;
    tosReady.value = tos?.enabled === true && Boolean(String(tos.bucket ?? "").trim());
  } catch {
    tosReady.value = false;
  }
}

async function loadJobs() {
  jobsLoading.value = true;
  jobsError.value = "";
  try {
    jobs.value = await api.listRemixReplicas(listDramaId.value || undefined);
  } catch (err) {
    jobsError.value = err instanceof Error ? err.message : String(err);
    jobs.value = [];
  } finally {
    jobsLoading.value = false;
  }
}

function pickCaseFile() {
  caseFileInputRef.value?.click();
}

function onCaseFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  caseFile.value = input.files?.[0] ?? null;
  message.value = "";
}

function dramaTitle(dramaId: string | null) {
  if (!dramaId) return "（等待短剧入库）";
  return dramas.value.find((d) => d.dramaId === dramaId)?.title ?? dramaId;
}

function formatDate(iso: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

async function submit() {
  if (!canSubmit.value) return;
  if (!caseFile.value) return;
  if (!tosReady.value) {
    message.value = "TOS 未启用或配置不完整，请先在系统配置中开启「火山云 TOS」并填写 bucket / 密钥。";
    messageOk.value = false;
    return;
  }
  submitting.value = true;
  message.value = "";
  caseUploadProgress.value = -1;

  try {
    submitLabel.value = "上传案例视频…";
    const casePolicy = await api.getMediaTosUploadPolicy({
      title: mode.value === "new" ? newDramaTitle.value.trim() : selectedDramaId.value,
      filename: caseFile.value!.name,
    });
    caseUploadProgress.value = 0;
    await uploadFileToPresignedUrl(casePolicy.uploadUrl, caseFile.value!, casePolicy.contentType, (p) => {
      caseUploadProgress.value = p;
    });
    caseUploadProgress.value = 100;
    const caseVideoUrls = [casePolicy.sourceUrl];

    submitLabel.value = "创建复刻任务…";
    const commonPayload = {
      caseVideoUrl: caseVideoUrls[0],
      caseVideoUrls,
      fissionEnabled: fissionEnabled.value,
      fissionOps: fissionEnabled.value && selectedFissionOps.value.length ? selectedFissionOps.value : undefined,
      fissionCount: fissionEnabled.value ? fissionCount.value || undefined : undefined,
    };
    const res = await api.createRemixReplica(
      mode.value === "existing"
        ? {
            dramaId: selectedDramaId.value,
            ...commonPayload,
          }
        : {
            title: newDramaTitle.value.trim(),
            externalDramaId: externalDramaId.value.trim(),
            dramaType: dramaType.value as "short" | "paid_short" | "comic" | "paid_comic",
            ...commonPayload,
          },
    );

    // 重置表单
    caseFile.value = null;
    if (caseFileInputRef.value) caseFileInputRef.value.value = "";
    caseUploadProgress.value = -1;
    selectedDramaId.value = "";
    newDramaTitle.value = "";
    externalDramaId.value = "";
    dramaType.value = "short";
    fissionEnabled.value = false;
    fissionCount.value = undefined;
    selectedFissionOps.value = [];

    message.value =
      res.status === "waiting_intake"
        ? `已创建短剧入库记录 ${res.externalDramaId}，案例视频已保存；请在短剧入库流程激活原片后，系统会自动创建复刻任务。`
        : `复刻任务已创建：${res.jobId}，状态 ${res.status}`;
    messageOk.value = true;
    if (res.dramaId) listDramaId.value = res.dramaId;
    await loadJobs();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    submitting.value = false;
    submitLabel.value = "提交中…";
  }
}

async function retry(jobId: string) {
  retryingId.value = jobId;
  message.value = "";
  try {
    await api.retryTask(jobId);
    message.value = `任务 ${jobId} 已重置，等待 Agent 重新领取`;
    messageOk.value = true;
    await loadJobs();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    retryingId.value = "";
  }
}
</script>

<style scoped>
.remix-replica-page {
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
  line-height: 1.6;
  max-width: 720px;
}

.page-alerts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg {
  margin: 0;
  padding: 10px 14px;
  font-size: 13px;
  border-radius: var(--radius-sm);
}
.msg.ok {
  color: #047857;
  background: #d1fae5;
}
.msg.err {
  color: #b91c1c;
  background: #fee2e2;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
}

.card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}

.card-head__tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-head__tools select {
  min-width: 140px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: var(--bg-surface);
}

.remix-form-card .card-body {
  padding: 18px 16px 16px;
}

.mode-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
}

.mode-tab {
  padding: 5px 12px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}

.mode-tab:hover {
  color: var(--text);
}

.mode-tab.active {
  color: var(--brand);
  background: var(--bg-surface);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-full {
  grid-column: 1 / -1;
}

.field > label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.required {
  color: var(--danger);
  margin-left: 2px;
}

.field-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.field input,
.field select {
  width: 100%;
  max-width: none;
}

.file-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.file-picker .file-input {
  display: none;
}

.file-picker .file-name {
  font-size: 13px;
  color: var(--text);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.upload-progress__bar {
  height: 6px;
  background: var(--bg-muted);
  border-radius: 999px;
  overflow: hidden;
}

.upload-progress__fill {
  height: 100%;
  background: var(--dclip-brand-gradient);
  border-radius: 999px;
  transition: width 0.2s ease;
}

.upload-progress__text {
  font-size: 12px;
  color: var(--text-secondary);
}

.info-box {
  padding: 12px 14px;
  background: var(--brand-soft);
  border: 1px solid rgba(79, 70, 229, 0.12);
  border-radius: var(--radius-sm);
}

.info-box p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.dclip-actions {
  margin-top: 18px;
  justify-content: flex-end;
}

.remix-list-card .card-head__tools select {
  min-width: 160px;
}

.table-loading,
.table-empty {
  padding: 16px;
  margin: 0;
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .card-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .mode-tabs {
    width: 100%;
  }

  .mode-tab {
    flex: 1;
  }
}

/* 高级选项 */
.advanced-section {
  margin-top: 18px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.advanced-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.advanced-toggle:hover {
  background: var(--bg-hover);
}

.advanced-arrow {
  font-size: 12px;
  transition: transform 0.2s ease;
  color: var(--text-secondary);
}

.advanced-arrow.open {
  transform: rotate(90deg);
}

.advanced-body {
  padding: 0 14px 14px;
  border-top: 1px dashed var(--border);
}

.fission-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.switch input {
  display: none;
}

.switch-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: #e5e7eb;
  border: 1px solid #d1d5db;
  border-radius: 12px;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.switch input:checked + .switch-slider {
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
  border-color: #4f46e5;
}

.switch-slider::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease;
}

.switch input:checked + .switch-slider::before {
  transform: translateX(20px);
}

.switch-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.op-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

.op-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.op-checkbox:hover {
  background: var(--bg-hover);
}

.op-checkbox.checked {
  border-color: var(--primary);
  background: rgba(59, 130, 246, 0.08);
}

.op-checkbox input {
  display: none;
}

/* 专辑下拉 + 刷新：刷新固定在下拉框右侧 */
.album-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.album-row > :deep(.searchable-select),
.album-row > select {
  flex: 1;
  min-width: 0;
}

.album-row__refresh,
.album-row > .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.field-hint.err {
  color: #b91c1c;
}

/* 素材库选择 */
.case-source-tabs {
  margin-bottom: 2px;
}

.material-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.material-toolbar > label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.material-toolbar__ops {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--brand);
  cursor: pointer;
}

.link-btn:hover {
  color: var(--brand-hover);
  text-decoration: underline;
}

.material-count {
  font-size: 12px;
  color: var(--text-muted);
}

.material-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 22px 14px;
  font-size: 13px;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.material-empty__spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: material-spin 0.8s linear infinite;
}

@keyframes material-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 专辑素材：固定 9:16 竖卡，多了自动换行往下排 */
.material-waterfall {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-content: flex-start;
  max-height: min(56vh, 640px);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.material-card {
  display: flex;
  flex-direction: column;
  flex: 0 0 120px;
  width: 120px;
  max-width: 120px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-elevated);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.material-card:hover {
  border-color: var(--border-strong);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
}

.material-card.checked {
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand) inset;
}

/* padding-bottom 锁死 9:16，避免视频元数据把卡片撑成横版 */
.material-card__media {
  position: relative;
  display: block;
  width: 100%;
  height: 0;
  padding-bottom: 177.78%; /* 16/9 ≈ 177.78% → 9:16 */
  background: #0c1018;
  overflow: hidden;
  flex-shrink: 0;
}

.material-card__media video {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  pointer-events: none;
  background: #0c1018;
}

.material-card__media video::-webkit-media-controls {
  display: none !important;
}

.material-card__check {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  display: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--brand);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}

.material-card.checked .material-card__check {
  display: inline-flex;
}

.material-card__play {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 999px;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0.8;
  pointer-events: none;
  transition: opacity 0.15s;
}

.material-card:hover .material-card__play,
.material-card.checked .material-card__play {
  opacity: 0;
}

.material-card__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 7px 7px;
  min-width: 0;
}

.material-card__name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-card__meta {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-card.checked .material-card__name {
  color: var(--brand-hover);
}
</style>
