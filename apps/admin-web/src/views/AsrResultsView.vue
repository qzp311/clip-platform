<template>
  <div>
    <h2>ASR 识别结果</h2>
    <div class="card dclip-toolbar">
      <input v-model="filterDramaId" placeholder="剧目 ID" />
      <input v-model="filterEpisodeId" placeholder="分集 ID" />
      <select v-model="filterTaskKind">
        <option value="">全部类型</option>
        <option value="single">single</option>
        <option value="episode_asr">episode_asr</option>
        <option value="drama_mix">drama_mix</option>
      </select>
      <button type="button" class="btn" @click="onSearch">查询</button>
      <span v-if="total" class="muted">共 {{ total }} 条</span>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>任务 ID</th>
            <th>剧目</th>
            <th>集</th>
            <th>类型</th>
            <th>段数</th>
            <th>预览</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in results" :key="String(r.taskId)">
            <td><RouterLink :to="`/asr-results/${r.taskId}`">{{ r.taskId }}</RouterLink></td>
            <td>{{ r.dramaId || "-" }}</td>
            <td>{{ r.episodeNo ?? r.episodeId ?? "-" }}</td>
            <td>{{ r.taskKind || "-" }}</td>
            <td>{{ r.finalSegmentCount }}</td>
            <td class="preview">{{ previewText(r.fullText) }}</td>
            <td>{{ r.updatedAt }}</td>
            <td>
              <RouterLink :to="`/tasks/${r.taskId}`">任务</RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!results.length">暂无 ASR 结果</p>
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
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api";
import { PAGE_SIZE } from "../constants/pagination";
import ListPager from "../components/ListPager.vue";

const results = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const limit = PAGE_SIZE;
const offset = ref(0);
const filterDramaId = ref("");
const filterEpisodeId = ref("");
const filterTaskKind = ref("");

function previewText(text: unknown): string {
  const value = String(text ?? "");
  return value.length > 80 ? `${value.slice(0, 80)}…` : value || "-";
}

async function load() {
  const res = await api.listAsrResults({
    dramaId: filterDramaId.value || undefined,
    episodeId: filterEpisodeId.value || undefined,
    taskKind: filterTaskKind.value || undefined,
    limit,
    offset: offset.value,
  });
  results.value = res.results;
  total.value = res.total;
}

function onSearch() {
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
.preview {
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
