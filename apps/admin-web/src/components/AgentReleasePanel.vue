<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h3>Agent 热更新</h3>
        <p>
          发布 JS 热更新包后，Windows Agent 在空闲心跳（约 60 秒）时自动下载并重启，无需用户手动 npm build。
          仅覆盖 clip-agent 与 @clip/* 编译产物，不含 FFmpeg / FunASR / 模型。
        </p>
      </div>
    </header>

    <div v-if="manifest.version" class="manifest">
      <div class="row">
        <span class="label">当前发布版本</span>
        <strong>{{ manifest.version }}</strong>
      </div>
      <div class="row">
        <span class="label">安装包状态</span>
        <span :class="manifest.artifactReady ? 'ok' : 'warn'">
          {{ manifest.artifactReady ? "已就绪" : "缺失（客户端不会收到更新）" }}
        </span>
      </div>
      <div class="row">
        <span class="label">SHA256</span>
        <code class="hash">{{ manifest.sha256 }}</code>
      </div>
      <div v-if="manifest.releaseNotes" class="row">
        <span class="label">说明</span>
        <span>{{ manifest.releaseNotes }}</span>
      </div>
      <div class="row">
        <span class="label">强制更新</span>
        <span>{{ manifest.mandatory ? "是" : "否" }}</span>
      </div>
    </div>
    <p v-else class="empty">尚未发布热更新包</p>

    <form class="form" @submit.prevent="upload">
      <div class="field">
        <label for="releaseVersion">版本号</label>
        <input
          id="releaseVersion"
          v-model="form.version"
          type="text"
          placeholder="0.3.1"
          required
        />
        <p class="hint">须高于线上 Agent 版本（如 0.3.0 → 0.3.1），设备心跳后会自动比对。</p>
      </div>
      <div class="field">
        <label for="releaseNotes">更新说明</label>
        <input id="releaseNotes" v-model="form.releaseNotes" type="text" placeholder="修复剪辑时长策略" />
      </div>
      <div class="form-check">
        <label class="form-check-label is-simple" for="releaseMandatory">
          <input id="releaseMandatory" v-model="form.mandatory" type="checkbox" class="form-check-input" />
          <span class="form-check-text">标记为强制更新</span>
        </label>
      </div>
      <div class="field">
        <label for="releaseZip">热更新 zip（全量包）</label>
        <input id="releaseZip" type="file" accept=".zip,application/zip" required @change="onFile" />
        <p class="hint">
          开发机构建: <code>npm run pack:agent-hotfix -- 0.3.1</code>
        </p>
      </div>
      <div class="field">
        <label for="incrementalZip">增量更新 zip（可选）</label>
        <input
          id="incrementalZip"
          type="file"
          accept=".zip,application/zip"
          @change="onIncrementalFile"
        />
        <p class="hint">
          仅包含变更文件，下载更快。开发机构建后位于 <code>dist/clip-agent-hotfix-{version}-incremental.zip</code>。
        </p>
      </div>
      <footer class="panel-foot">
        <p v-if="message" class="toast" :class="messageType">{{ message }}</p>
        <button class="btn" type="submit" :disabled="uploading || !form.file">
          {{ uploading ? "上传中…" : "上传并发布" }}
        </button>
      </footer>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../api";

const manifest = ref<Record<string, unknown>>({});
const uploading = ref(false);
const message = ref("");
const messageType = ref<"ok" | "err">("ok");
const form = reactive({
  version: "",
  releaseNotes: "",
  mandatory: false,
  file: null as File | null,
  incrementalFile: null as File | null,
});

async function load() {
  const res = await api.getAgentRelease();
  manifest.value = res.manifest ?? {};
  if (!form.version && manifest.value.version) {
    form.version = suggestNextVersion(String(manifest.value.version));
  }
}

function suggestNextVersion(current: string): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return current;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  form.file = input.files?.[0] ?? null;
}

function onIncrementalFile(e: Event) {
  const input = e.target as HTMLInputElement;
  form.incrementalFile = input.files?.[0] ?? null;
}

async function upload() {
  if (!form.file) return;
  uploading.value = true;
  message.value = "";
  try {
    const res = await api.uploadAgentRelease({
      version: form.version.trim(),
      releaseNotes: form.releaseNotes.trim(),
      mandatory: form.mandatory,
      file: form.file,
      incrementalFile: form.incrementalFile ?? undefined,
    });
    manifest.value = res.manifest ?? {};
    message.value = `已发布 v${manifest.value.version}`;
    messageType.value = "ok";
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    messageType.value = "err";
  } finally {
    uploading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.panel {
  margin-bottom: 24px;
  padding: 20px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}
.panel-head h3 {
  margin: 0 0 6px;
}
.panel-head p {
  margin: 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.5;
}
.manifest {
  margin: 16px 0;
  padding: 12px 14px;
  background: #f8fafc;
  border-radius: 8px;
  font-size: 13px;
}
.manifest .row {
  display: flex;
  gap: 12px;
  margin-bottom: 6px;
  align-items: baseline;
}
.manifest .label {
  min-width: 96px;
  color: #64748b;
}
.manifest .ok {
  color: #15803d;
  font-weight: 600;
}
.manifest .warn {
  color: #b45309;
  font-weight: 600;
}
.hash {
  font-size: 11px;
  word-break: break-all;
}
.empty {
  margin: 12px 0;
  font-size: 13px;
  color: #94a3b8;
}
.form .field {
  margin-bottom: 14px;
}
.form .field > label:not(.form-check-label) {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.form input[type="text"],
.form input[type="file"] {
  max-width: 420px;
  width: 100%;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
}
.panel-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
}
.toast {
  margin: 0;
  margin-right: auto;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
}
.toast.ok {
  color: #15803d;
}
.toast.err {
  color: #b91c1c;
}
</style>
