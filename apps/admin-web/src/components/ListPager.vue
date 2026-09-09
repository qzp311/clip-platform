<template>
  <div v-if="total > 0" class="list-pager">
    <button type="button" class="btn secondary" :disabled="offset === 0" @click="emit('prev')">
      上一页
    </button>
    <span class="muted">{{ page }} / {{ totalPages }}（共 {{ total }} 条）</span>
    <button
      type="button"
      class="btn secondary"
      :disabled="offset + limit >= total"
      @click="emit('next')"
    >
      下一页
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  total: number;
  limit: number;
  offset: number;
}>();

const emit = defineEmits<{ prev: []; next: [] }>();

const page = computed(() => Math.floor(props.offset / props.limit) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));
</script>
