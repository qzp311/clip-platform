<template>
  <span class="chip" :class="services?.agentEnabled === false ? 'off' : 'on'">
    <span class="dot" />
    {{ services?.agentEnabled === false ? '停用' : '正常' }}
  </span>
</template>

<script setup lang="ts">
defineProps<{
  services?: { agentEnabled?: boolean };
}>();
</script>

<style scoped>
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}
.chip.on {
  background: #ecfdf5;
  color: #047857;
  border-color: #a7f3d0;
}
.chip.off {
  background: #fef2f2;
  color: #b91c1c;
  border-color: #fecaca;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
</style>
