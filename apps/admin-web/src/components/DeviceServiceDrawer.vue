<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <aside class="drawer" role="dialog" aria-labelledby="drawer-title">
        <header class="drawer-head">
          <div>
            <p class="eyebrow">单设备覆盖</p>
            <h2 id="drawer-title">{{ device?.machineId ?? "设备" }}</h2>
            <p class="sub">
              {{ device?.gpuName }} · {{ device?.vramMb }}MB · Agent {{ device?.agentVersion }}
            </p>
          </div>
          <button type="button" class="close" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div class="drawer-body">
          <div class="device-meta">
            <span class="online-pill" :class="device?.online ? 'on' : 'off'">
              <span class="dot" />
              {{ device?.online ? "在线" : "离线" }}
            </span>
            <span class="meta-text">最后心跳 {{ formatRelativeTime(String(device?.lastSeenAt ?? "")) }}</span>
          </div>

          <div class="switch-section">
            <div class="switch-row">
              <div class="switch-info">
                <div class="switch-title">允许领取任务</div>
                <div class="switch-desc">关闭后该设备不再从服务端领取剪辑任务，保存后约 60 秒生效。</div>
              </div>
              <label class="toggle">
                <input type="checkbox" :checked="mode === 'on'" @change="mode = ($event.target as HTMLInputElement).checked ? 'on' : 'off'" />
                <span class="slider" />
              </label>
            </div>
          </div>
        </div>

        <footer class="drawer-foot">
          <p v-if="message" class="toast" :class="messageType">{{ message }}</p>
          <div class="actions">
            <button type="button" class="btn ghost" :disabled="saving" @click="clearOverride">
              恢复默认
            </button>
            <div class="spacer" />
            <button type="button" class="btn secondary" @click="emit('close')">取消</button>
            <button type="button" class="btn" :disabled="saving" @click="save">
              {{ saving ? "保存中…" : "保存" }}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../api";
import { formatRelativeTime } from "../utils/format-time";

interface DeviceRow {
  deviceId: string;
  machineId?: string;
  gpuName?: string;
  vramMb?: number;
  agentVersion?: string;
  online?: boolean;
  lastSeenAt?: string;
  services?: { agentEnabled?: boolean };
}

const props = defineProps<{
  open: boolean;
  device: DeviceRow | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [];
}>();

const mode = ref<"inherit" | "on" | "off">("inherit");

const saving = ref(false);
const message = ref("");
const messageType = ref<"ok" | "err">("ok");

watch(
  () => [props.open, props.device?.deviceId] as const,
  async ([open, id]) => {
    if (!open || !id) return;
    message.value = "";
    const override = await api.getDeviceOverride(id);
    const s = (override.services ?? {}) as Record<string, boolean | undefined>;
    mode.value = s.agentEnabled === undefined ? "inherit" : s.agentEnabled ? "on" : "off";
  },
);

function flash(text: string, type: "ok" | "err" = "ok") {
  message.value = text;
  messageType.value = type;
}

function buildServices(): Record<string, boolean> {
  if (mode.value === "inherit") return {};
  return { agentEnabled: mode.value === "on" };
}

async function save() {
  if (!props.device) return;
  saving.value = true;
  try {
    await api.updateDeviceOverride(props.device.deviceId, { services: buildServices() });
    flash("已保存，约 60 秒后生效");
    emit("saved");
  } catch (e) {
    flash(e instanceof Error ? e.message : "保存失败", "err");
  } finally {
    saving.value = false;
  }
}

async function clearOverride() {
  if (!props.device) return;
  saving.value = true;
  try {
    await api.updateDeviceOverride(props.device.deviceId, { services: {} });
    mode.value = "inherit";
    flash("已清除覆盖，恢复默认");
    emit("saved");
  } catch (e) {
    flash(e instanceof Error ? e.message : "操作失败", "err");
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  background: rgba(15, 23, 42, 0.45);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
  backdrop-filter: blur(2px);
}
.drawer {
  width: min(480px, 100vw);
  height: 100%;
  max-height: 100dvh;
  background: #fff;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 32px rgba(15, 23, 42, 0.12);
  animation: slideIn 0.22s ease-out;
}
@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid #f1f5f9;
}
.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #64748b;
}
.drawer-head h2 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}
.sub {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}
.close {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: #f1f5f9;
  color: #475569;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  background: #e2e8f0;
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}
.device-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 20px;
  border-bottom: 1px solid #f1f5f9;
  margin-bottom: 20px;
}
.online-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.online-pill.on {
  background: #ecfdf5;
  color: #047857;
}
.online-pill.off {
  background: #f1f5f9;
  color: #64748b;
}
.online-pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.meta-text {
  font-size: 12px;
  color: #94a3b8;
}
.switch-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}
.switch-info {
  flex: 1;
  min-width: 0;
}
.switch-title {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 2px;
}
.switch-desc {
  font-size: 12px;
  color: #64748b;
  line-height: 1.5;
}
.toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}
.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #cbd5e1;
  transition: 0.2s;
  border-radius: 999px;
}
.slider::before {
  content: "";
  position: absolute;
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: 0.2s;
}
.toggle input:checked + .slider {
  background: #3b82f6;
}
.toggle input:checked + .slider::before {
  transform: translateX(20px);
}
.drawer-foot {
  padding: 14px 20px 18px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfc;
}
.toast {
  margin: 0 0 10px;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
}
.toast.ok { color: #047857; background: #ecfdf5; }
.toast.err { color: #b91c1c; background: #fef2f2; }
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.spacer {
  flex: 1;
}
.btn.ghost {
  margin-right: auto;
  background: transparent;
  color: #64748b;
  border: 1px dashed #cbd5e1;
}
.btn.ghost:hover {
  background: #f8fafc;
  color: #334155;
}
</style>
