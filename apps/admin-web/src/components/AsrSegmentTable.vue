<template>
  <div class="asr-seg-panel">
    <div class="toolbar">
      <label>
        筛选
        <select v-model="filter">
          <option value="all">全部</option>
          <option value="hook">可作片头</option>
          <option value="conflict">冲突</option>
          <option value="twist">反转</option>
          <option value="cliff">悬念</option>
          <option value="labeled">有高光</option>
        </select>
      </label>
      <span class="muted">共 {{ filtered.length }} / {{ segments.length }} 段 · 片头候选 {{ hookCount }}</span>
    </div>
    <table v-if="filtered.length">
      <thead>
        <tr>
          <th>ID</th>
          <th>时间</th>
          <th>高光</th>
          <th>情绪</th>
          <th>场面</th>
          <th>说话人</th>
          <th>文本</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in filtered"
          :key="String(s.segmentId)"
          :class="{ 'is-hook': Boolean(s.usableAsHook) }"
        >
          <td class="mono">{{ s.segmentId }}</td>
          <td class="mono time">{{ formatMs(s) }}</td>
          <td>
            <span v-if="s.highlightType || s.usableAsHook" class="tag" :data-hl="String(s.highlightType || '')">
              {{ highlightLabel(s) }}
            </span>
            <span v-else class="muted">—</span>
          </td>
          <td>{{ emotionLabel(s.emotion) }}</td>
          <td>{{ sceneLabel(s.sceneType) }}</td>
          <td>{{ s.speakerId || "—" }}</td>
          <td class="text">{{ s.text }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">暂无片段</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

export type AsrSegRow = {
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  speechStartMs?: number;
  text?: string;
  highlightType?: string;
  highlightScore?: number;
  highlightTags?: string[];
  usableAsHook?: boolean;
  emotion?: string;
  sceneType?: string;
  speakerId?: string;
};

const props = defineProps<{
  segments: AsrSegRow[];
}>();

const filter = ref<"all" | "hook" | "conflict" | "twist" | "cliff" | "labeled">("all");

const hookCount = computed(() => props.segments.filter((s) => s.usableAsHook).length);

const filtered = computed(() => {
  const list = props.segments;
  switch (filter.value) {
    case "hook":
      return list.filter((s) => s.usableAsHook);
    case "conflict":
      return list.filter((s) => s.highlightType === "conflict");
    case "twist":
      return list.filter((s) => s.highlightType === "twist");
    case "cliff":
      return list.filter((s) => s.highlightType === "cliff");
    case "labeled":
      return list.filter((s) => Boolean(s.highlightType));
    default:
      return list;
  }
});

function formatMs(s: AsrSegRow): string {
  const start = Number(s.startMs ?? 0);
  const end = Number(s.endMs ?? 0);
  const onset = s.speechStartMs != null && Number(s.speechStartMs) > start + 200
    ? `口${Number(s.speechStartMs)}·`
    : "";
  return `${onset}${start}–${end}ms`;
}

function highlightLabel(s: AsrSegRow): string {
  const parts: string[] = [];
  if (s.usableAsHook) parts.push("片头");
  if (s.highlightType) parts.push(String(s.highlightType));
  if (s.highlightScore != null) parts.push(`分${s.highlightScore}`);
  return parts.join(" · ") || "—";
}

const EMOTION_ZH: Record<string, string> = {
  anger: "怒",
  sad: "悲",
  fear: "惧",
  joy: "喜",
  tender: "柔",
  suspense: "悬",
  neutral: "中",
};

const SCENE_ZH: Record<string, string> = {
  conflict_dialogue: "对峙",
  reveal: "揭露",
  suspense: "悬念场",
  setup: "铺垫",
  monologue: "旁白/长述",
  cta: "口播",
  unknown: "未定",
};

function emotionLabel(v: unknown): string {
  if (!v) return "—";
  return EMOTION_ZH[String(v)] ?? String(v);
}

function sceneLabel(v: unknown): string {
  if (!v) return "—";
  return SCENE_ZH[String(v)] ?? String(v);
}
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.muted { color: #868e96; font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.time { white-space: nowrap; }
.text { max-width: 420px; }
.tag {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  background: #eef2ff;
  color: #364fc7;
  font-size: 12px;
  white-space: nowrap;
}
.tag[data-hl="twist"] { background: #fff3bf; color: #e67700; }
.tag[data-hl="cliff"] { background: #e5dbff; color: #5f3dc4; }
.tag[data-hl="conflict"],
.tag[data-hl="hook"] { background: #ffe3e3; color: #c92a2a; }
tr.is-hook td { background: #fff5f5; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
</style>
