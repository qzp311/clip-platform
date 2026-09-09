<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h3>{{ title }}</h3>
        <p>{{ description }}</p>
      </div>
    </header>

    <div class="body">
      <div v-if="allowInherit" class="field">
        <label class="field-label">策略来源</label>
        <select v-model="preset">
          <option value="inherit">继承全局</option>
          <option value="always_full">始终满载</option>
          <option value="always_throttled">始终限流</option>
          <option value="custom">自定义时段</option>
        </select>
      </div>

      <template v-if="!allowInherit || preset !== 'inherit'">
        <div class="form-check">
          <label class="form-check-label">
            <input v-model="local.scheduleEnabled" type="checkbox" :disabled="presetLocked" />
            <span>
              <strong>按时间段控制</strong>
              <small>关闭后固定使用「固定档位」；开启后工作时段/其余时段分别选档。</small>
            </span>
          </label>
        </div>

        <div class="field-grid">
          <div class="field">
            <label class="field-label">时区</label>
            <input v-model="local.timezone" type="text" placeholder="Asia/Shanghai" :disabled="presetLocked" />
          </div>
          <div class="field">
            <label class="field-label">固定档位（关闭时段控制时）</label>
            <select v-model="local.fixedMode" :disabled="presetLocked || local.scheduleEnabled">
              <option value="full">满载</option>
              <option value="throttled">限流</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label">工作时段档位</label>
            <select v-model="local.workMode" :disabled="!local.scheduleEnabled || presetLocked">
              <option value="full">满载</option>
              <option value="throttled">限流</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label">其余时段档位</label>
            <select v-model="local.offMode" :disabled="!local.scheduleEnabled || presetLocked">
              <option value="full">满载</option>
              <option value="throttled">限流</option>
            </select>
          </div>
        </div>

        <div class="windows" v-if="local.scheduleEnabled">
          <div class="windows-head">
            <label class="field-label">工作时段（半开区间，可跨午夜）</label>
            <button type="button" class="btn-link" :disabled="presetLocked" @click="addWindow">+ 添加时段</button>
          </div>
          <div v-for="(w, i) in local.workWindows" :key="i" class="window-row">
            <input v-model="w.start" type="time" :disabled="presetLocked" />
            <span>至</span>
            <input v-model="w.end" type="time" :disabled="presetLocked" />
            <button
              type="button"
              class="btn-link danger"
              :disabled="presetLocked || local.workWindows.length <= 1"
              @click="removeWindow(i)"
            >
              删除
            </button>
          </div>
        </div>

        <div class="profiles">
          <div class="profile-card">
            <h4>满载档</h4>
            <div class="field-grid compact">
              <label>渲染并发 <input v-model.number="local.profiles.full.maxConcurrentRenders" type="number" min="1" max="8" /></label>
              <label>上传并发 <input v-model.number="local.profiles.full.maxConcurrentUploads" type="number" min="1" max="8" /></label>
              <label>进程优先级
                <select v-model="local.profiles.full.processPriority">
                  <option value="normal">普通</option>
                  <option value="below_normal">低于普通</option>
                </select>
              </label>
              <label>FFmpeg 线程（0=不限） <input v-model.number="local.profiles.full.ffmpegThreads" type="number" min="0" max="16" /></label>
            </div>
          </div>
          <div class="profile-card">
            <h4>限流档</h4>
            <div class="field-grid compact">
              <label>渲染并发 <input v-model.number="local.profiles.throttled.maxConcurrentRenders" type="number" min="1" max="8" /></label>
              <label>上传并发 <input v-model.number="local.profiles.throttled.maxConcurrentUploads" type="number" min="1" max="8" /></label>
              <label>进程优先级
                <select v-model="local.profiles.throttled.processPriority">
                  <option value="normal">普通</option>
                  <option value="below_normal">低于普通</option>
                </select>
              </label>
              <label>FFmpeg 线程（0=不限） <input v-model.number="local.profiles.throttled.ffmpegThreads" type="number" min="0" max="16" /></label>
            </div>
          </div>
        </div>
      </template>
    </div>

    <footer class="panel-foot">
      <p v-if="message" class="toast" :class="messageType">{{ message }}</p>
      <button type="button" class="btn" :disabled="saving" @click="save">
        {{ saving ? "保存中…" : saveLabel }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

export type ResourceLoadMode = "full" | "throttled";
export type ResourceProcessPriority = "normal" | "below_normal";

export interface ResourcePolicyForm {
  scheduleEnabled: boolean;
  timezone: string;
  workWindows: Array<{ start: string; end: string }>;
  fixedMode: ResourceLoadMode;
  workMode: ResourceLoadMode;
  offMode: ResourceLoadMode;
  profiles: {
    full: {
      maxConcurrentRenders: number;
      maxConcurrentUploads: number;
      processPriority: ResourceProcessPriority;
      ffmpegThreads: number;
    };
    throttled: {
      maxConcurrentRenders: number;
      maxConcurrentUploads: number;
      processPriority: ResourceProcessPriority;
      ffmpegThreads: number;
    };
  };
}

const DEFAULT_FORM: ResourcePolicyForm = {
  scheduleEnabled: true,
  timezone: "Asia/Shanghai",
  workWindows: [{ start: "09:00", end: "20:00" }],
  fixedMode: "full",
  workMode: "throttled",
  offMode: "full",
  profiles: {
    full: {
      maxConcurrentRenders: 2,
      maxConcurrentUploads: 2,
      processPriority: "normal",
      ffmpegThreads: 0,
    },
    throttled: {
      maxConcurrentRenders: 1,
      maxConcurrentUploads: 1,
      processPriority: "below_normal",
      ffmpegThreads: 2,
    },
  },
};

type Preset = "inherit" | "always_full" | "always_throttled" | "custom";

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    saveLabel?: string;
    /** 允许「继承全局」（设备覆盖用） */
    allowInherit?: boolean;
    /** 初始策略；设备覆盖为 null/undefined 且 allowInherit 时显示继承 */
    modelValue?: Partial<ResourcePolicyForm> | null;
    /** 是否已有设备级覆盖（非继承） */
    hasOverride?: boolean;
  }>(),
  {
    title: "资源策略",
    description: "工作时段给用户留资源，其余时段可满载。约 60 秒心跳后 Agent 生效。",
    saveLabel: "保存资源策略",
    allowInherit: false,
    hasOverride: false,
  },
);

const emit = defineEmits<{
  save: [payload: ResourcePolicyForm | null];
}>();

const local = reactive<ResourcePolicyForm>(cloneForm(DEFAULT_FORM));
const preset = ref<Preset>(props.allowInherit && !props.hasOverride ? "inherit" : "custom");
const saving = ref(false);
const message = ref("");
const messageType = ref<"ok" | "err">("ok");

const presetLocked = computed(
  () => props.allowInherit && (preset.value === "always_full" || preset.value === "always_throttled"),
);

watch(
  () => [props.modelValue, props.hasOverride] as const,
  () => {
    applyIncoming();
  },
  { immediate: true, deep: true },
);

watch(preset, (p) => {
  if (p === "always_full") {
    Object.assign(local, cloneForm(DEFAULT_FORM));
    local.scheduleEnabled = false;
    local.fixedMode = "full";
  } else if (p === "always_throttled") {
    Object.assign(local, cloneForm(DEFAULT_FORM));
    local.scheduleEnabled = false;
    local.fixedMode = "throttled";
  } else if (p === "custom" && !props.modelValue) {
    Object.assign(local, cloneForm(DEFAULT_FORM));
  }
});

function cloneForm(src: ResourcePolicyForm): ResourcePolicyForm {
  return JSON.parse(JSON.stringify(src)) as ResourcePolicyForm;
}

function applyIncoming() {
  if (props.allowInherit && !props.hasOverride) {
    preset.value = "inherit";
    Object.assign(local, cloneForm(DEFAULT_FORM), normalizeIncoming(props.modelValue));
    return;
  }
  const next = normalizeIncoming(props.modelValue);
  Object.assign(local, cloneForm(DEFAULT_FORM), next);
  if (!props.allowInherit) {
    preset.value = "custom";
    return;
  }
  if (!next.scheduleEnabled && next.fixedMode === "full") preset.value = "always_full";
  else if (!next.scheduleEnabled && next.fixedMode === "throttled") preset.value = "always_throttled";
  else preset.value = "custom";
}

function normalizeIncoming(raw?: Partial<ResourcePolicyForm> | null): Partial<ResourcePolicyForm> {
  if (!raw) return {};
  const windows = Array.isArray(raw.workWindows) && raw.workWindows.length
    ? raw.workWindows.map((w) => ({
        start: String(w.start || "09:00").slice(0, 5),
        end: String(w.end || "20:00").slice(0, 5),
      }))
    : undefined;
  return {
    scheduleEnabled: raw.scheduleEnabled !== false,
    timezone: raw.timezone || "Asia/Shanghai",
    workWindows: windows,
    fixedMode: raw.fixedMode === "throttled" ? "throttled" : "full",
    workMode: raw.workMode === "full" ? "full" : "throttled",
    offMode: raw.offMode === "throttled" ? "throttled" : "full",
    profiles: {
      full: { ...DEFAULT_FORM.profiles.full, ...(raw.profiles?.full ?? {}) },
      throttled: { ...DEFAULT_FORM.profiles.throttled, ...(raw.profiles?.throttled ?? {}) },
    },
  };
}

function addWindow() {
  local.workWindows.push({ start: "09:00", end: "20:00" });
}

function removeWindow(i: number) {
  if (local.workWindows.length <= 1) return;
  local.workWindows.splice(i, 1);
}

function flash(text: string, type: "ok" | "err" = "ok") {
  message.value = text;
  messageType.value = type;
  window.setTimeout(() => {
    if (message.value === text) message.value = "";
  }, 4000);
}

async function save() {
  saving.value = true;
  try {
    if (props.allowInherit && preset.value === "inherit") {
      emit("save", null);
      flash("已恢复继承全局");
      return;
    }
    const payload = cloneForm(local);
    if (!payload.workWindows.length) {
      payload.workWindows = [{ start: "09:00", end: "20:00" }];
    }
    emit("save", payload);
    flash("已保存");
  } catch (e) {
    flash(e instanceof Error ? e.message : "保存失败", "err");
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.panel {
  background: #fff;
  border-radius: 14px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  overflow: hidden;
}
.panel-head {
  padding: 20px 20px 0;
}
.panel-head h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}
.panel-head p {
  margin: 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;
}
.body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.field-grid.compact {
  grid-template-columns: 1fr 1fr;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 6px;
}
.field input,
.field select,
.profile-card input,
.profile-card select,
.window-row input {
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.form-check-label {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 13px;
  color: #334155;
}
.form-check-label small {
  display: block;
  color: #64748b;
  margin-top: 2px;
}
.windows-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.window-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.window-row input {
  width: auto;
  min-width: 120px;
}
.btn-link {
  border: none;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 13px;
}
.btn-link.danger {
  color: #dc2626;
}
.btn-link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.profiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.profile-card {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 14px;
  background: #f8fafc;
}
.profile-card h4 {
  margin: 0 0 10px;
  font-size: 13px;
  color: #0f172a;
}
.profile-card label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #64748b;
}
.panel-foot {
  padding: 14px 20px 18px;
  border-top: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
}
.toast {
  margin-right: auto;
  font-size: 13px;
  padding: 6px 10px;
  border-radius: 8px;
}
.toast.ok { color: #047857; background: #ecfdf5; }
.toast.err { color: #b91c1c; background: #fef2f2; }
.btn {
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
