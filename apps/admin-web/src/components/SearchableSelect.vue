<template>
  <div ref="rootRef" class="searchable-select" :class="{ open: open, disabled }">
    <button
      type="button"
      class="searchable-select__trigger"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="searchable-select__value" :class="{ placeholder: !selectedLabel }">
        {{ selectedLabel || placeholder }}
      </span>
      <span class="searchable-select__caret" aria-hidden="true">▾</span>
    </button>
    <div v-if="open" class="searchable-select__dropdown">
      <input
        ref="searchRef"
        v-model="keyword"
        type="text"
        class="searchable-select__search"
        :placeholder="searchPlaceholder"
        @keydown.esc.prevent="close"
        @keydown.enter.prevent="pickFirst"
      />
      <div class="searchable-select__list" role="listbox">
        <button
          v-if="allowEmpty"
          type="button"
          class="searchable-select__option"
          :class="{ active: modelValue == null || modelValue === '' }"
          role="option"
          @click="pick(undefined)"
        >
          {{ placeholder }}
        </button>
        <button
          v-for="opt in filtered"
          :key="String(opt.value)"
          type="button"
          class="searchable-select__option"
          :class="{ active: opt.value === modelValue }"
          role="option"
          @click="pick(opt.value)"
        >
          {{ opt.label }}
        </button>
        <div v-if="filtered.length === 0" class="searchable-select__empty">无匹配项</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

export type SearchableOption = { value: string | number; label: string };

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    options: SearchableOption[];
    placeholder?: string;
    searchPlaceholder?: string;
    disabled?: boolean;
    allowEmpty?: boolean;
  }>(),
  {
    modelValue: undefined,
    placeholder: "请选择",
    searchPlaceholder: "输入关键词搜索…",
    disabled: false,
    allowEmpty: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | number | undefined];
  change: [value: string | number | undefined];
}>();

const open = ref(false);
const keyword = ref("");
const rootRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);

const selectedLabel = computed(() => {
  const hit = props.options.find((o) => o.value === props.modelValue);
  return hit?.label ?? "";
});

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

function toggle() {
  if (props.disabled) return;
  if (open.value) close();
  else void openDropdown();
}

async function openDropdown() {
  open.value = true;
  keyword.value = "";
  await nextTick();
  searchRef.value?.focus();
}

function close() {
  open.value = false;
  keyword.value = "";
}

function pick(value: string | number | undefined) {
  emit("update:modelValue", value);
  emit("change", value);
  close();
}

function pickFirst() {
  const first = filtered.value[0];
  if (first) pick(first.value);
}

function onDocPointerDown(ev: Event) {
  const el = rootRef.value;
  if (!el || !open.value) return;
  if (ev.target instanceof Node && !el.contains(ev.target)) close();
}

watch(
  () => props.disabled,
  (v) => {
    if (v) close();
  },
);

onMounted(() => document.addEventListener("pointerdown", onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointerDown));
</script>

<style scoped>
.searchable-select {
  position: relative;
  width: 100%;
  min-width: 0;
}

.searchable-select__trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-surface, #fff);
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.searchable-select.open .searchable-select__trigger,
.searchable-select__trigger:hover:not(:disabled) {
  border-color: var(--border-strong, #94a3b8);
}

.searchable-select__trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.searchable-select__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.searchable-select__value.placeholder {
  color: var(--text-muted, #94a3b8);
  font-weight: 400;
}

.searchable-select__caret {
  flex-shrink: 0;
  color: var(--text-muted, #94a3b8);
  font-size: 11px;
}

.searchable-select__dropdown {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  max-height: 280px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-surface, #fff);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
  overflow: hidden;
}

.searchable-select__search {
  width: 100%;
  margin: 0;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  font-size: 13px;
  outline: none;
  background: var(--bg-elevated, #f8fafc);
}

.searchable-select__search:focus {
  background: #fff;
}

.searchable-select__list {
  overflow-y: auto;
  max-height: 220px;
  padding: 4px;
}

.searchable-select__option {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.searchable-select__option:hover,
.searchable-select__option.active {
  background: var(--brand-soft, #eef2ff);
  color: var(--brand-hover, #4338ca);
}

.searchable-select__empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--text-muted, #94a3b8);
  text-align: center;
}
</style>
