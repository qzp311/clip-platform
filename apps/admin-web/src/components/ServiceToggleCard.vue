<template>
  <div class="toggle-card" :class="{ off: !modelValue, dimmed: disabled }">
    <div class="icon-wrap" :class="iconTone">
      <component :is="icon" />
    </div>
    <div class="body">
      <div class="head">
        <div>
          <h4>{{ title }}</h4>
          <p>{{ description }}</p>
        </div>
        <label class="switch" :title="disabled ? disabledHint : undefined">
          <input
            type="checkbox"
            :checked="modelValue"
            :disabled="disabled"
            @change="onChange"
          />
          <span class="slider" />
        </label>
      </div>
      <p v-if="effect" class="effect">{{ effect }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type Component } from "vue";

defineProps<{
  title: string;
  description: string;
  effect?: string;
  modelValue: boolean;
  disabled?: boolean;
  disabledHint?: string;
  icon: Component;
  iconTone?: "blue" | "violet" | "amber";
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

function onChange(e: Event) {
  emit("update:modelValue", (e.target as HTMLInputElement).checked);
}
</script>

<style scoped>
.toggle-card {
  display: flex;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  background: linear-gradient(180deg, #fff 0%, #f8fafc 100%);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.toggle-card:not(.dimmed):hover {
  border-color: #cbd5e1;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
}
.toggle-card.off {
  background: #f8fafc;
}
.toggle-card.dimmed {
  opacity: 0.55;
}
.icon-wrap {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: #fff;
}
.icon-wrap :deep(svg) {
  width: 22px;
  height: 22px;
}
.icon-wrap.blue { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.icon-wrap.violet { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
.icon-wrap.amber { background: linear-gradient(135deg, #f59e0b, #d97706); }
.body { flex: 1; min-width: 0; }
.head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
h4 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}
.head p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #64748b;
}
.effect {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 11px;
  line-height: 1.45;
}
.toggle-card.off .effect {
  background: #fff7ed;
  color: #c2410c;
}
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #cbd5e1;
  border-radius: 999px;
  transition: 0.2s;
}
.slider::before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
input:checked + .slider {
  background: #3b82f6;
}
input:disabled + .slider {
  cursor: not-allowed;
  opacity: 0.6;
}
input:checked + .slider::before {
  transform: translateX(20px);
}
</style>
