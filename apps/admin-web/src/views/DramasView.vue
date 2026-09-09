<template>
  <div>
    <h2>短剧上传</h2>
    <p class="hint">
      上传剧级 <strong>.zip</strong> 压缩包至火山云 TOS，创建 <code>drama_package</code> 任务。Agent 领取后会下载 zip、解压、逐集 ASR 识别并混剪入库（流程与原先贴链接一致）。
    </p>

    <p v-if="!tosReady" class="msg err">
      TOS 未启用或配置不完整，请先在
      <RouterLink to="/config">系统配置</RouterLink>
      中开启「火山云 TOS」并填写 bucket / 密钥。
    </p>

    <p v-if="message" :class="['msg', messageOk ? 'ok' : 'err']">{{ message }}</p>

    <div class="card">
      <h3>单条录入</h3>
      <div class="card-body">
      <div class="form-grid">
        <div class="field field-full">
          <label>作品简介</label>
          <textarea
            v-model="synopsis"
            rows="5"
            placeholder="手工填写剧情简介：人物关系、核心冲突、卖点…（建议填写；留空则警告并继续，选段将仅依赖 ASR）"
          />
        </div>
        <div class="field">
          <label>剧名</label>
          <input v-model="title" placeholder="例如：霸道总裁爱上我" />
        </div>
        <div class="field">
          <label>压缩包（.zip）</label>
          <div class="upload-row">
            <input
              ref="fileInputRef"
              type="file"
              accept=".zip,application/zip"
              class="file-input"
              @change="onFileChange"
            />
            <button
              type="button"
              class="btn secondary"
              :disabled="!title.trim()"
              @click="pickFile"
            >
              选择 zip 文件
            </button>
            <span v-if="zipFile" class="file-name">{{ zipFile.name }}</span>
            <span v-else class="muted">未选择文件</span>
          </div>
          <p v-if="uploadProgress >= 0 && uploadProgress < 100" class="upload-progress">
            上传 TOS {{ uploadProgress }}%
          </p>
        </div>
        <div class="field">
          <label>预期集数（可选）</label>
          <input v-model.number="expectedEpisodeCount" type="number" min="1" placeholder="留空则不校验" />
        </div>
        <div class="field">
          <label>ASR 规则集</label>
          <select v-model="ruleSetId">
            <option v-for="r in ruleSets" :key="String(r.rule_set_id)" :value="r.rule_set_id">
              {{ r.rule_set_id }}
            </option>
          </select>
        </div>
      </div>
      <div class="dclip-actions dclip-actions--plain">
        <button
          class="btn"
          :disabled="submitting || !canSubmitSingle"
          @click="submitSingle"
        >
          {{ submitting ? submitLabel : "上传并创建入库任务" }}
        </button>
      </div>
      </div>
    </div>

    <div class="card">
      <h3>压缩包批量录入</h3>
      <div class="card-body">
      <p class="hint">
        每行一条，格式：<strong>剧名|zip下载链接|预期集数(可选)|简介(可选)</strong>。
        无集数时可写 <strong>剧名|zip链接|简介</strong>。批量仍使用外链（单条请用上方的 TOS 上传）。
      </p>
      <textarea
        v-model="batchText"
        rows="8"
        placeholder="霸道总裁爱上我|https://cdn.example.com/drama-a.zip|80|女主逆袭复仇&#10;重生之我在古代|https://cdn.example.com/drama-b.zip|50"
      />
      <div class="dclip-actions dclip-actions--plain">
        <button
          class="btn"
          :disabled="submitting || !parsedBatch.length"
          @click="submitBatch"
        >
          {{ submitting ? "提交中…" : `批量创建 ${parsedBatch.length} 个任务` }}
        </button>
      </div>
      </div>
    </div>

    <div class="card dclip-toolbar">
      <select v-model="dramaId" @change="onDramaFilterChange">
        <option value="">全部剧目</option>
        <option v-for="d in dramas" :key="d.dramaId" :value="d.dramaId">{{ d.title }}</option>
      </select>
      <button class="btn secondary" @click="loadTasks">刷新</button>
    </div>

    <div class="card">
      <h3>压缩包入库任务</h3>
      <p v-if="tasksLoading" class="hint">加载中…</p>
      <p v-else-if="tasksError" class="msg err">{{ tasksError }}</p>
      <table>
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>剧名</th>
            <th>简介</th>
            <th>优先级</th>
            <th>状态</th>
            <th>阶段</th>
            <th>压缩包链接</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!tasksLoading && !packageTasks.length && !tasksError">
            <td colspan="9" class="empty">暂无压缩包入库任务</td>
          </tr>
          <tr v-for="t in packageTasks" :key="String(t.taskId)">
            <td><RouterLink :to="`/tasks/${t.taskId}`">{{ t.taskId }}</RouterLink></td>
            <td>{{ formatTitle(t) }}</td>
            <td class="synopsis-cell" :title="formatSynopsis(t)">{{ formatSynopsis(t) }}</td>
            <td>
              <span v-if="isPriorityTask(t)" class="badge priority-badge">优先</span>
              <span v-else class="muted">普通</span>
            </td>
            <td><span :class="['badge', String(t.status)]">{{ t.status }}</span></td>
            <td>{{ formatPhase(t) }}</td>
            <td class="url-cell" :title="String(t.sourceUrl)">{{ t.sourceUrl }}</td>
            <td>{{ t.updatedAt }}</td>
            <td class="actions">
              <button
                v-if="t.status === 'pending'"
                class="btn btn-xs secondary"
                :disabled="priorityUpdatingId === String(t.taskId)"
                @click="setPriority(String(t.taskId), !isPriorityTask(t))"
              >
                {{ priorityUpdatingId === String(t.taskId) ? "处理中…" : isPriorityTask(t) ? "取消优先" : "设为优先" }}
              </button>
              <button
                v-if="t.status === 'failed' || t.status === 'completed'"
                class="btn btn-xs secondary"
                :disabled="retryingId === String(t.taskId)"
                @click="retry(String(t.taskId))"
              >
                {{ retryingId === String(t.taskId) ? "重跑中…" : "重跑" }}
              </button>
              <button
                class="btn btn-xs danger"
                :disabled="deletingId === String(t.taskId)"
                @click="deleteTaskItem(String(t.taskId))"
              >
                {{ deletingId === String(t.taskId) ? "删除中…" : "删除" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <ListPager
        :total="total"
        :limit="limit"
        :offset="offset"
        @prev="prevPage"
        @next="nextPage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";
import { uploadFileToPresignedUrl } from "../utils/drama-package-upload";

const ruleSets = ref<Record<string, unknown>[]>([]);
const packageTasks = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const limit = PAGE_SIZE;
const offset = ref(0);
const tasksLoading = ref(false);
const tasksError = ref("");

const title = ref("");
const synopsis = ref("");
const zipFile = ref<File | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const expectedEpisodeCount = ref<number | undefined>(undefined);
const ruleSetId = ref("drama-default-v1");
const batchText = ref("");
const submitting = ref(false);
const submitLabel = ref("提交中…");
const uploadProgress = ref(-1);
const tosReady = ref(true);
const message = ref("");
const messageOk = ref(true);
const dramas = ref<{ dramaId: string; title: string }[]>([]);
const dramaId = ref("");

const canSubmitSingle = computed(
  () => Boolean(title.value.trim() && zipFile.value && tosReady.value),
);

const parsedBatch = computed(() => {
  const items: Array<{
    title: string;
    sourceUrl: string;
    expectedEpisodeCount?: number;
    synopsis?: string;
  }> = [];
  for (const line of batchText.value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|").map((part) => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    let expectedEpisodeCount: number | undefined;
    let synopsis: string | undefined;
    if (parts.length === 2) {
      // title|url
    } else if (parts.length === 3) {
      const third = parts[2]!;
      const count = Number(third);
      if (Number.isFinite(count) && count > 0) {
        expectedEpisodeCount = count;
      } else {
        synopsis = third;
      }
    } else {
      const third = parts[2]!;
      const count = Number(third);
      if (Number.isFinite(count) && count > 0) {
        expectedEpisodeCount = count;
        synopsis = parts.slice(3).join("|").trim() || undefined;
      } else {
        synopsis = parts.slice(2).join("|").trim() || undefined;
      }
    }
    items.push({
      title: parts[0],
      sourceUrl: parts[1],
      expectedEpisodeCount,
      synopsis,
    });
  }
  return items;
});

onMounted(async () => {
  const [rs, dramasRes] = await Promise.all([
    api.listRuleSets({ limit: 200, offset: 0 }),
    api.listDramas({ limit: 1000, offset: 0 }),
    loadTasks(),
    loadTosStatus(),
  ]);
  ruleSets.value = rs.ruleSets;
  dramas.value = (dramasRes.dramas as { dramaId: string; title: string }[]) ?? [];
  if (ruleSets.value.length && !ruleSets.value.some((r) => r.rule_set_id === ruleSetId.value)) {
    ruleSetId.value = String(ruleSets.value[0]!.rule_set_id);
  }
});

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

async function loadTasks() {
  tasksLoading.value = true;
  tasksError.value = "";
  try {
    const res = await api.listTasks({
      taskKind: "drama_package",
      dramaId: dramaId.value || undefined,
      limit,
      offset: offset.value,
    });
    packageTasks.value = res.tasks;
    total.value = res.total;
  } catch (err) {
    tasksError.value = err instanceof Error ? err.message : String(err);
    packageTasks.value = [];
  } finally {
    tasksLoading.value = false;
  }
}

function onDramaFilterChange() {
  offset.value = 0;
  void loadTasks();
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit);
  void loadTasks();
}

function nextPage() {
  offset.value += limit;
  void loadTasks();
}

function pickFile() {
  fileInputRef.value?.click();
}

function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file) {
    zipFile.value = null;
    return;
  }
  if (!file.name.toLowerCase().endsWith(".zip")) {
    message.value = "仅支持 .zip 压缩包";
    messageOk.value = false;
    input.value = "";
    zipFile.value = null;
    return;
  }
  zipFile.value = file;
  message.value = "";
}

async function submitSingle() {
  if (!canSubmitSingle.value || !zipFile.value) return;
  submitting.value = true;
  message.value = "";
  uploadProgress.value = -1;
  try {
    const file = zipFile.value;
    submitLabel.value = "申请上传…";
    const policy = await api.getDramaPackageTosUploadPolicy({
      title: title.value.trim(),
      filename: file.name,
    });

    submitLabel.value = "上传 TOS…";
    uploadProgress.value = 0;
    await uploadFileToPresignedUrl(policy.uploadUrl, file, policy.contentType, (p) => {
      uploadProgress.value = p;
    });
    uploadProgress.value = 100;

    submitLabel.value = "创建任务…";
    const synopsisText = synopsis.value.trim();
    const res = await api.createDramaPackage({
      title: title.value.trim(),
      synopsis: synopsisText || undefined,
      sourceUrl: policy.sourceUrl,
      packageObjectKey: policy.objectKey,
      packageName: policy.packageName,
      dedupSeq: policy.dedupSeq,
      expectedEpisodeCount: expectedEpisodeCount.value || undefined,
      asrRuleSetId: ruleSetId.value,
    });

    title.value = "";
    synopsis.value = "";
    zipFile.value = null;
    uploadProgress.value = -1;
    if (fileInputRef.value) fileInputRef.value.value = "";
    expectedEpisodeCount.value = undefined;
    const warn = !synopsisText ? "（⚠ 未填作品简介，将仅依赖 ASR 选段）" : "";
    message.value = `任务已创建：${res.taskId}（${res.packageName ?? policy.packageName}）${warn}`;
    messageOk.value = true;
    void loadTasks();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
    uploadProgress.value = -1;
  } finally {
    submitting.value = false;
    submitLabel.value = "提交中…";
  }
}

async function submitBatch() {
  if (!parsedBatch.value.length) return;
  submitting.value = true;
  message.value = "";
  try {
    const res = await api.createDramaPackage({
      packages: parsedBatch.value.map((item) => ({
        ...item,
        asrRuleSetId: ruleSetId.value,
      })),
    });
    const okCount = Array.isArray(res.results) ? res.results.length : 0;
    const errCount = Array.isArray(res.errors) ? res.errors.length : 0;
    batchText.value = "";
    message.value =
      errCount > 0
        ? `成功 ${okCount} 个，失败 ${errCount} 个：${(res.errors as Array<{ title: string; error: string }>).map((e) => `${e.title}: ${e.error}`).join("；")}`
        : `已成功创建 ${okCount} 个压缩包入库任务`;
    messageOk.value = errCount === 0;
    void loadTasks();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    submitting.value = false;
  }
}

const retryingId = ref("");
const deletingId = ref("");
const priorityUpdatingId = ref("");

async function setPriority(taskId: string, priority: boolean) {
  priorityUpdatingId.value = taskId;
  message.value = "";
  try {
    await api.updateDramaPackagePriority(taskId, priority);
    message.value = priority ? `任务 ${taskId} 已设为优先剪辑` : `任务 ${taskId} 已取消优先剪辑`;
    messageOk.value = true;
    await loadTasks();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    priorityUpdatingId.value = "";
  }
}

async function retry(taskId: string) {
  retryingId.value = taskId;
  message.value = "";
  try {
    await api.retryTask(taskId);
    message.value = `任务 ${taskId} 已重置为 pending，等待 Agent 重新领取`;
    messageOk.value = true;
    await loadTasks();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    retryingId.value = "";
  }
}

async function deleteTaskItem(taskId: string) {
  if (!window.confirm(`确定删除任务 ${taskId}？关联的子任务和产出数据也会被清理。`)) return;
  deletingId.value = taskId;
  message.value = "";
  try {
    const res = await api.deleteTask(taskId);
    message.value = `已删除 ${res.deletedIds.length} 条任务`;
    messageOk.value = true;
    await loadTasks();
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageOk.value = false;
  } finally {
    deletingId.value = "";
  }
}

function formatTitle(t: Record<string, unknown>): string {
  const pkg = t.dramaPackage as Record<string, unknown> | undefined;
  return String(pkg?.title ?? (t.dramaMeta as Record<string, unknown> | undefined)?.title ?? t.dramaId ?? "-");
}

function formatSynopsis(t: Record<string, unknown>): string {
  const meta = t.dramaMeta as Record<string, unknown> | undefined;
  const text = typeof meta?.synopsis === "string" ? meta.synopsis.trim() : "";
  return text || "（未填）";
}

function isPriorityTask(t: Record<string, unknown>): boolean {
  const pkg = t.dramaPackage as Record<string, unknown> | undefined;
  return Number(pkg?.priority ?? t.priority ?? 0) > 0;
}

function formatPhase(t: Record<string, unknown>): string {
  const pkg = t.dramaPackage as Record<string, unknown> | undefined;
  return pkg?.phase ? String(pkg.phase) : "-";
}
</script>

<style scoped>
.hint {
  margin: -8px 0 16px;
  color: #64748b;
  font-size: 14px;
}
.upload-progress {
  margin: 6px 0 0;
  font-size: 13px;
  color: #2563eb;
}
.synopsis-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #475569;
}
.msg {
  margin: 0 0 16px;
  font-size: 14px;
}
.msg.ok { color: #2b8a3e; }
.msg.err { color: #c92a2a; }
.url-cell {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #64748b;
}
.empty {
  text-align: center;
  color: #94a3b8;
  padding: 24px !important;
}
.priority-badge {
  color: #92400e;
  background: #fef3c7;
}
</style>
