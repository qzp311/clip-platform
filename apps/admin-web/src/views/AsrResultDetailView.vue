<template>
  <div v-if="record">
    <h2>ASR {{ record.taskId }}</h2>
    <div class="card">
      <div class="card-body">
      <p>剧目: {{ record.dramaId || "-" }} / 分集: {{ record.episodeId || "-" }} (#{{ record.episodeNo ?? "-" }})</p>
      <p>类型: {{ record.taskKind || "-" }} · 设备: {{ record.deviceId || "-" }}</p>
      <p>原始段: {{ record.rawSegmentCount ?? "-" }} · 最终段: {{ record.finalSegmentCount }}</p>
      <p v-if="record.subtitleUrl">
        字幕 SRT: <a :href="String(record.subtitleUrl)" target="_blank">{{ record.subtitleUrl }}</a>
      </p>
      <p v-if="record.subtitlesJsonUrl">
        字幕 JSON: <a :href="String(record.subtitlesJsonUrl)" target="_blank">下载</a>
      </p>
      <p>保存: {{ record.savedAt }} · 更新: {{ record.updatedAt }}</p>
      <RouterLink :to="`/tasks/${record.taskId}`">查看关联任务</RouterLink>
      </div>
    </div>
    <div class="card">
      <h3>全文预览</h3>
      <div class="card-body">
      <pre class="full-text">{{ record.fullText || "（无文本）" }}</pre>
      </div>
    </div>
    <div class="card">
      <h3>句级片段与标签 ({{ segments.length }})</h3>
      <div class="card-body">
        <AsrSegmentTable :segments="segments" />
      </div>
    </div>
  </div>
  <p v-else-if="error" style="color:#c92a2a">{{ error }}</p>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../api";
import AsrSegmentTable, { type AsrSegRow } from "../components/AsrSegmentTable.vue";

const route = useRoute();
const record = ref<Record<string, unknown> | null>(null);
const error = ref("");

const segments = computed(
  () => (record.value?.segments as AsrSegRow[] | undefined) ?? [],
);

onMounted(async () => {
  try {
    const res = await api.getAsrResult(route.params.id as string);
    record.value = res.asrResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<style scoped>
.full-text {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
  background: #f8f9fa;
  padding: 12px;
  border-radius: 6px;
}
</style>
