<template>
  <div class="segment-row">
    <div class="meta">
      <div class="icon" :class="tone">
        <component :is="icon" />
      </div>
      <div>
        <div class="title">{{ title }}</div>
        <div class="desc">{{ description }}</div>
      </div>
    </div>
    <div class="segments" role="group" :aria-label="title">
      <button
        type="button"
        class="seg"
        :class="{ active: mode === 'inherit' }"
        @click="setMode('inherit')"
      >
        跟随全局
      </button>
      <button
        type="button"
        class="seg on"
        :class="{ active: mode === 'on' }"
        @click="setMode('on')"
      >
        开启
      </button>
      <button
        type="button"
        class="seg off"
        :class="{ active: mode === 'off' }"
        @click="setMode('off')"
      >
        关闭
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type Component } from "vue";

export type SegmentMode = "inherit" | "on" | "off";

const props = defineProps<{
  title: string;
  description: string;
  mode: SegmentMode;
  icon: Component;
  tone?: "blue" | "violet" | "amber";
}>();

const emit = defineEmits<{
  "update:mode": [value: SegmentMode];
}>();

const tone = computed(() => props.tone ?? "blue");

function setMode(mode: SegmentMode) {
  emit("update:mode", mode);
}
</script>

<style scoped>
.segment-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid #f1f5f9;
}
.segment-row:last-child {
  border-bottom: none;
}
.meta {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  flex: 1;
  min-width: 0;
}
.icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  flex-shrink: 0;
}
.icon :deep(svg) {
  width: 18px;
  height: 18px;
}
.icon.blue { background: #3b82f6; }
.icon.violet { background: #8b5cf6; }
.icon.amber { background: #f59e0b; }
.title {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 2px;
}
.desc {
  font-size: 12px;
  color: #64748b;
  line-height: 1.45;
}
.segments {
  display: inline-flex;
  background: #f1f5f9;
  border-radius: 10px;
  padding: 3px;
  flex-shrink: 0;
}
.seg {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.seg:hover:not(.active) {
  color: #334155;
}
.seg.active {
  background: #fff;
  color: #0f172a;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
}
.seg.active.on {
  color: #047857;
}
.seg.active.off {
  color: #b91c1c;
}
@media (max-width: 720px) {
  .segment-row {
    flex-direction: column;
    align-items: stretch;
  }
  .segments {
    width: 100%;
    justify-content: stretch;
  }
  .seg {
    flex: 1;
    padding-inline: 8px;
  }
}
</style>
