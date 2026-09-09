<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
    <g v-if="name === 'dashboard'">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </g>
    <g v-else-if="name === 'tasks'">
      <path d="M8 6h13" stroke-linecap="round" />
      <path d="M8 12h13" stroke-linecap="round" />
      <path d="M8 18h13" stroke-linecap="round" />
      <path d="M3 6h.01" stroke-linecap="round" />
      <path d="M3 12h.01" stroke-linecap="round" />
      <path d="M3 18h.01" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'dramas'">
      <path d="M4 7h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
      <path d="m10 12 3 2-3 2v-4z" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="name === 'drama-intake'">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6" stroke-linecap="round" />
      <path d="M9 16h6" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'drama-ranking'">
      <path d="M4 19V9" stroke-linecap="round" />
      <path d="M10 19V5" stroke-linecap="round" />
      <path d="M16 19v-7" stroke-linecap="round" />
      <path d="M22 19H2" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'asr'">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" stroke-linecap="round" />
      <path d="M12 18v3" stroke-linecap="round" />
      <path d="M8 21h8" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'skill'">
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.813 1.912a2 2 0 0 1 1.287 1.288L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.813-1.912a2 2 0 0 1-1.287-1.288L12 3z" />
    </g>
    <g v-else-if="name === 'remix'">
      <path d="M4 7h6v10H4z" />
      <path d="M14 7h6v10h-6z" />
      <path d="M10 12h4" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'devices'">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" stroke-linecap="round" />
      <path d="M12 17v4" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'rules'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" stroke-linecap="round" />
      <path d="M16 17H8" stroke-linecap="round" />
      <path d="M10 9H8" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke-linecap="round" />
    </g>
  </svg>
</template>

<script setup lang="ts">
defineProps<{
  name:
    | "dashboard"
    | "tasks"
    | "dramas"
    | "drama-intake"
    | "drama-ranking"
    | "asr"
    | "skill"
    | "remix"
    | "devices"
    | "rules"
    | "settings";
}>();
</script>
