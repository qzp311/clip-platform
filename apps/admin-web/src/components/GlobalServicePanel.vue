<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h3>全局服务控制</h3>
        <p>作用于所有 Agent 客户端。单台设备可在「设备管理」页单独覆盖。</p>
      </div>
      <div class="sync-note">
        <span class="pulse" />
        约 60 秒心跳同步
      </div>
    </header>

    <div class="toggle-grid">
      <ServiceToggleCard
        v-model="local.agentEnabled"
        title="Agent 总开关"
        description="关闭后客户端停止 ASR 侧车，不再领取任务，仅保持心跳在线。"
        effect="关闭后该设备进入待命状态，可随时重新开启。"
        :icon="IconAgent"
        icon-tone="blue"
      />
      <ServiceToggleCard
        v-model="local.taskProcessing"
        title="任务处理"
        description="控制是否从服务端领取并执行剪辑任务。"
        effect="关闭后不再 claim 新任务；本地桌面端「暂停轮询」仍然生效。"
        :icon="IconTask"
        icon-tone="violet"
        :disabled="!local.agentEnabled"
        disabled-hint="请先开启 Agent 总开关"
      />
      <ServiceToggleCard
        v-model="local.asrSidecar"
        title="ASR 侧车"
        description="控制 FunASR 识别进程是否常驻运行。"
        effect="关闭可释放 GPU 显存；有新 ASR 任务时需重新拉起侧车。"
        :icon="IconAsr"
        icon-tone="amber"
        :disabled="!local.agentEnabled"
        disabled-hint="请先开启 Agent 总开关"
      />
    </div>

    <footer class="panel-foot">
      <p v-if="message" class="toast" :class="messageType">{{ message }}</p>
      <button class="btn" :disabled="saving" @click="save">
        {{ saving ? "保存中…" : "保存全局配置" }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { api } from "../api";
import ServiceToggleCard from "./ServiceToggleCard.vue";
import { IconAgent, IconAsr, IconTask } from "./icons/ServiceIcons.vue";

export interface ServiceFlags {
  agentEnabled: boolean;
  taskProcessing: boolean;
  asrSidecar: boolean;
}

const props = defineProps<{
  services: ServiceFlags;
}>();

const emit = defineEmits<{
  saved: [services: ServiceFlags];
}>();

const local = reactive({ ...props.services });
const saving = ref(false);
const message = ref("");
const messageType = ref<"ok" | "err">("ok");

watch(
  () => props.services,
  (s) => Object.assign(local, s),
  { deep: true },
);

watch(
  () => local.agentEnabled,
  (on) => {
    if (!on) {
      local.taskProcessing = false;
      local.asrSidecar = false;
    }
  },
);

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
    const payload: ServiceFlags = {
      agentEnabled: local.agentEnabled,
      taskProcessing: local.agentEnabled && local.taskProcessing,
      asrSidecar: local.agentEnabled && local.asrSidecar,
    };
    await api.updateGlobalConfig({ services: payload });
    Object.assign(local, payload);
    emit("saved", { ...payload });
    flash("已保存，Agent 将在下次心跳时同步");
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
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
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
.sync-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}
.toggle-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 20px;
}
@media (max-width: 1100px) {
  .toggle-grid {
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }
}
.panel-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 20px 18px;
  border-top: 1px solid #f1f5f9;
  background: #fafbfc;
}
.toast {
  margin: 0;
  margin-right: auto;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
}
.toast.ok {
  color: #047857;
  background: #ecfdf5;
}
.toast.err {
  color: #b91c1c;
  background: #fef2f2;
}
</style>
