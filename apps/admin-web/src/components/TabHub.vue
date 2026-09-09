<template>
  <div class="tab-hub">
    <header class="tab-hub__head">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="description" class="tab-hub__desc">{{ description }}</p>
      </div>
    </header>
    <nav class="tab-hub__tabs" :aria-label="title">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="tab-hub__tab"
        :class="{ active: modelValue === tab.id }"
        @click="$emit('update:modelValue', tab.id)"
      >
        <b>{{ tab.label }}</b>
        <small v-if="tab.desc">{{ tab.desc }}</small>
      </button>
    </nav>
    <div class="tab-hub__body hub-embed">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  tabs: Array<{ id: string; label: string; desc?: string }>;
  modelValue: string;
}>();

defineEmits<{
  "update:modelValue": [id: string];
}>();
</script>

<style scoped>
.tab-hub__head {
  margin-bottom: 12px;
}
.tab-hub__head h2 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}
.tab-hub__desc {
  margin: 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;
}
.tab-hub__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.tab-hub__tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  min-width: 120px;
}
.tab-hub__tab b {
  font-size: 13px;
  font-weight: 700;
  color: #334155;
}
.tab-hub__tab small {
  font-size: 11px;
  color: #94a3b8;
}
.tab-hub__tab.active {
  border-color: #93c5fd;
  background: #eff6ff;
}
.tab-hub__tab.active b {
  color: #1d4ed8;
}
.hub-embed :deep(> h2:first-child),
.hub-embed :deep(> .page-head > div > h2),
.hub-embed :deep(> .page-head h2) {
  display: none;
}
.hub-embed :deep(> .page-head) {
  margin-bottom: 8px;
}
.hub-embed :deep(> .page-head .hint),
.hub-embed :deep(> p.hint:first-of-type) {
  margin-top: 0;
}
</style>
