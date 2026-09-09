<template>
  <div v-if="loadError" class="card">
    <h2>任务不存在</h2>
    <p class="muted">{{ loadError }}</p>
    <RouterLink :to="{ path: '/dramas', query: { tab: 'cache' } }">返回剧包缓存</RouterLink>
  </div>
  <div v-else-if="!task" class="card">
    <p class="muted">加载中…</p>
  </div>
  <div v-else>
    <h2>任务 {{ task.taskId }}</h2>
    <div class="card">
      <div class="card-body">
      <p>类型: {{ formatTaskKind(task) }}</p>
      <p>状态: <span :class="['badge', String(task.status)]">{{ task.status }}</span></p>
      <p>源视频: {{ task.sourceUrl }}</p>
      <p v-if="task.totalWallTimeSec != null">
        全流程耗时（识别→剪辑完成）: {{ formatDuration(Number(task.totalWallTimeSec)) }}
        <span class="muted">（{{ task.processingStartedAt }} → {{ task.processingCompletedAt }}）</span>
      </p>
      <p v-if="task.outputUrl">
        主成品:
        <template v-if="isLocalUrl(String(task.outputUrl))">
          <span class="local-badge">本地</span>
          <code>{{ localPathFromUrl(String(task.outputUrl)) }}</code>
        </template>
        <a v-else :href="String(task.outputUrl)" target="_blank">{{ task.outputUrl }}</a>
      </p>
      <p v-if="task.subtitleUrl">字幕 SRT: <a :href="String(task.subtitleUrl)" target="_blank">{{ task.subtitleUrl }}</a></p>
      <p v-if="task.subtitlesJsonUrl">字幕 JSON: <a :href="String(task.subtitlesJsonUrl)" target="_blank">下载</a></p>
      <p v-if="task.failMessage" class="error-text">失败: {{ task.failMessage }}</p>
      <div v-if="task.status === 'failed' || task.status === 'completed'" class="dclip-actions dclip-actions--plain">
        <button class="btn" @click="retry">重跑任务</button>
      </div>
      </div>
    </div>

    <div v-if="showSynopsisPanel" class="card">
      <h3>作品简介</h3>
      <div class="card-body">
      <p v-if="synopsisMissing" class="synopsis-warn">⚠ 未填写简介，仅依赖 ASR 台词选段</p>
      <textarea v-model="synopsisDraft" rows="5" placeholder="剧情简介：人物关系、核心冲突、卖点…" />
      <div class="dclip-actions dclip-actions--plain">
        <button
          class="btn"
          :disabled="savingSynopsis || !task.dramaId"
          @click="saveSynopsis"
        >
          {{ savingSynopsis ? "保存中…" : "保存简介" }}
        </button>
      </div>
      </div>
    </div>

    <div v-if="mixRenders.length" class="card">
      <h3>混剪成片 ({{ mixRenders.length }})</h3>
      <table class="mix-table">
        <thead>
          <tr>
           <th>#</th>
           <th>轮次</th>
            <th>预览</th>
            <th>题材</th>
            <th>剪辑形式</th>
            <th>目标</th>
            <th>时长状态</th>
            <th>时长(s)</th>
            <th>上传</th>
            <th>输出</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, idx) in mixRendersSorted" :key="`${r.round}-${r.planIndex}-${idx}`">
            <td>{{ r.planIndex ?? idx + 1 }}</td>
            <td>R{{ r.round }}</td>
            <td>
              <template v-if="!isLocalUrl(String(r.outputUrl))">
                <video controls :src="String(r.outputUrl)" preload="metadata" style="max-width: 240px; max-height: 160px; display: block; border-radius: 4px; background: #000;" />
              </template>
              <span v-else class="muted">本地输出，无法在线预览</span>
            </td>
            <td>{{ formatGenre(r.genreProfile) }}</td>
            <td>{{ formatEditForm(r.editForm) }}</td>
            <td>{{ r.targetDurationLabel ?? r.durationTier ?? "-" }}</td>
            <td>{{ r.durationStatus ?? "-" }}</td>
            <td>{{ r.durationSec ?? r.estimatedDurationSec ?? "-" }}</td>
            <td>
              <span :class="['badge', r.uploaded === false ? 'local' : 'uploaded']">
                {{ r.uploaded === false ? "本地" : "已上传" }}
              </span>
            </td>
            <td class="output-cell">
              <template v-if="isLocalUrl(String(r.outputUrl))">
                <code>{{ r.localOutputPath ?? localPathFromUrl(String(r.outputUrl)) }}</code>
              </template>
              <a v-else :href="String(r.outputUrl)" target="_blank">{{ r.outputUrl }}</a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>ASR 片段与标签 ({{ (task.segments as any[])?.length || 0 }})</h3>
      <div class="card-body">
        <AsrSegmentTable v-if="(task.segments as any[])?.length" :segments="(task.segments as any[])" />
        <p v-else>暂无 ASR 结果</p>
      </div>
    </div>
    <div class="card">
      <h3>剪辑方案 (clipPlan)</h3>
      <div class="card-body">
        <textarea v-model="planJson" rows="12" />
        <div class="dclip-actions dclip-actions--plain">
          <button class="btn" @click="savePlan">保存方案</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../api";
import AsrSegmentTable from "../components/AsrSegmentTable.vue";
import { formatDurationSec as formatDuration } from "../utils/format-duration";

type MixRenderRow = Record<string, unknown>;

const route = useRoute();
const task = ref<Record<string, unknown> | null>(null);
const loadError = ref("");
const planJson = ref("{}");
const synopsisDraft = ref("");
const savingSynopsis = ref(false);
const mixRenders = computed(() => (task.value?.mixRenders as MixRenderRow[] | undefined) ?? []);

const mixRendersSorted = computed(() => {
  const renders = [...mixRenders.value];
  renders.sort(
    (a, b) =>
      Number(a.planSeqInRound ?? a.planIndex ?? 0) - Number(b.planSeqInRound ?? b.planIndex ?? 0),
  );
  return renders;
});

const showSynopsisPanel = computed(() => {
  const kind = String(task.value?.taskKind ?? "");
  return kind === "drama_package" || kind === "drama_mix";
});

const synopsisMissing = computed(() => !synopsisDraft.value.trim());

function formatTaskKind(t: Record<string, unknown>): string {
  const kind = String(t.taskKind ?? "single");
  if (kind === "drama_package") return "剧级压缩包";
  if (kind === "drama_mix") return "混剪";
  if (kind === "episode_asr") return "单集ASR";
  return "单集直剪";
}

function isLocalUrl(url: string): boolean {
  return url.startsWith("local:");
}

function localPathFromUrl(url: string): string {
  return url.startsWith("local:") ? url.slice("local:".length) : url;
}

const GENRE_LABELS: Record<string, string> = {
  urban_male: "都市男频",
  era_male: "年代重生",
  sweet_romance: "甜宠闪婚",
  revenge_female: "女频复仇",
  palace_intrigue: "宫斗权谋",
  system_transmigration: "穿越系统流",
  // 兼容旧别名
  period_male: "年代男频",
  flash_marriage: "闪婚甜宠",
  revenge_rise: "复仇逆袭",
};

const EDIT_FORM_LABELS: Record<string, string> = {
  sequential: "顺序剪辑",
  skip_episode: "跳集剪辑",
  hook_first: "精彩前置",
  commentary: "解说剪辑",
};

function formatGenre(value: unknown): string {
  if (!value) return "-";
  const key = String(value);
  return GENRE_LABELS[key] ?? key;
}

function formatEditForm(value: unknown): string {
  if (!value) return "-";
  const key = String(value);
  return EDIT_FORM_LABELS[key] ?? key;
}

onMounted(async () => {
  const taskId = String(route.params.id ?? "");
  if (!taskId || taskId === "undefined" || taskId === "null") {
    loadError.value = "无效的任务 ID（剧包缓存请使用关联的 packageTaskId）";
    return;
  }
  try {
    task.value = await api.getTask(taskId);
    planJson.value = JSON.stringify(task.value.plan ?? { version: "1.0", clips: [], output: { ratio: "9:16", maxDurationSec: 60 } }, null, 2);
    const meta = task.value.dramaMeta as Record<string, unknown> | undefined;
    synopsisDraft.value = typeof meta?.synopsis === "string" ? meta.synopsis : "";

  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

async function saveSynopsis() {
  const dramaId = String(task.value?.dramaId ?? "");
  if (!dramaId) return;
  savingSynopsis.value = true;
  try {
    await api.updateDramaMeta(dramaId, { synopsis: synopsisDraft.value.trim() || undefined });
    task.value = await api.getTask(route.params.id as string);
    const meta = task.value.dramaMeta as Record<string, unknown> | undefined;
    synopsisDraft.value = typeof meta?.synopsis === "string" ? meta.synopsis : synopsisDraft.value;
  } finally {
    savingSynopsis.value = false;
  }
}

async function retry() {
  await api.retryTask(route.params.id as string);
  task.value = await api.getTask(route.params.id as string);
}

async function savePlan() {
  const plan = JSON.parse(planJson.value);
  await api.updatePlan(route.params.id as string, plan);
  alert("方案已保存");
}
</script>

<style scoped>
.local-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: #fef3c7;
  color: #92400e;
}
.mix-table {
  width: 100%;
  font-size: 13px;
}
.mix-table th,
.mix-table td {
  text-align: left;
  vertical-align: top;
  padding: 6px 8px;
}
.output-cell code {
  font-size: 11px;
  word-break: break-all;
}
.badge.local {
  background: #fef3c7;
  color: #92400e;
}
.badge.uploaded {
  background: #dcfce7;
  color: #166534;
}
.synopsis-warn {
  margin: 0 0 8px;
  color: #b45309;
  font-size: 13px;
}
.muted {
  color: #868e96;
}
</style>
