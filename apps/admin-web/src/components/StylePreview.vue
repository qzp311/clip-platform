<template>
  <div class="style-preview" :class="`style-preview--${kind}`">
    <div class="style-preview-label">样式预览</div>
    <div
      class="style-preview-box"
      :class="previewClasses"
      :style="boxStyle"
    >
      <span class="style-preview-text" :style="textStyle">{{ displayText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

interface Props {
  config: Record<string, unknown>;
  kind: "title" | "disclaimer" | "corner";
}

const props = defineProps<Props>();

const displayText = computed(() => {
  const raw = String(props.config.text ?? "").trim();
  if (raw) return raw;
  if (props.kind === "title") return "标题预览";
  if (props.kind === "disclaimer") return "免责声明预览";
  return "角标预览";
});

const style = computed(() => String(props.config.style ?? "standard"));
const color = computed(() => String(props.config.color ?? "#FFFFFF"));
const outlineColor = computed(() => String(props.config.outlineColor ?? "#000000"));
const backgroundColor = computed(() => String(props.config.backgroundColor ?? "#000000"));
const backgroundAlpha = computed(() => Math.max(0, Math.min(1, Number(props.config.backgroundAlpha ?? 0.35))));
const fontSize = computed(() => Math.max(12, Math.min(120, Number(props.config.fontSize ?? (props.kind === "title" ? 64 : 28)))));
const fontName = computed(() => {
  const name = String(props.config.fontName ?? "").trim();
  if (!name || name === "__custom__") return "";
  return name;
});

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const previewClasses = computed(() => ({
  "style-standard": style.value === "standard",
  "style-glow": style.value === "glow",
  "style-stroke3d": style.value === "stroke3d",
  "style-ribbon": style.value === "ribbon",
  "style-badge": style.value === "badge",
  "style-bar": style.value === "bar",
  "style-vertical": style.value === "vertical",
  "style-tape": style.value === "tape",
  "style-flag": style.value === "flag",
  "style-pulsing": style.value === "pulsing",
  "style-corner": props.kind === "corner",
  "style-title": props.kind === "title",
  "style-disclaimer": props.kind === "disclaimer",
}));

const boxStyle = computed(() => {
  const base: Record<string, string> = {
    color: color.value,
    fontSize: `${fontSize.value}px`,
    fontFamily: fontName.value
      ? `"${fontName.value}", "Microsoft YaHei", "PingFang SC", sans-serif`
      : `"Microsoft YaHei", "PingFang SC", sans-serif`,
    backgroundColor: hexToRgba(backgroundColor.value, backgroundAlpha.value),
    borderColor: outlineColor.value,
  };

  if (style.value === "glow") {
    const c = outlineColor.value;
    const r1 = Math.max(4, fontSize.value * 0.2);
    const r2 = Math.max(8, fontSize.value * 0.4);
    const r3 = Math.max(12, fontSize.value * 0.6);
    base.textShadow = `0 0 ${r1}px ${c}, 0 0 ${r2}px ${c}, 0 0 ${r3}px ${c}`;
  } else if (style.value === "stroke3d") {
    const off = Math.max(1, Math.round(fontSize.value * 0.06));
    const c = outlineColor.value;
    base.textShadow = `${off}px ${off}px 0 ${c}, ${off * 2}px ${off * 2}px 0 ${c}, ${off * 3}px ${off * 3}px 0 rgba(0,0,0,0.35)`;
  } else if (style.value === "ribbon") {
    base.padding = `${Math.round(fontSize.value * 0.35)}px ${Math.round(fontSize.value * 0.7)}px`;
    base.borderRadius = "4px";
  } else if (style.value === "badge") {
    base.padding = `${Math.round(fontSize.value * 0.45)}px`;
    base.borderRadius = "50%";
    base.minWidth = `${fontSize.value * 3}px`;
    base.minHeight = `${fontSize.value * 1.5}px`;
    base.display = "flex";
    base.alignItems = "center";
    base.justifyContent = "center";
  } else if (style.value === "bar") {
    base.padding = `${Math.round(fontSize.value * 0.3)}px ${Math.round(fontSize.value * 0.7)}px`;
    base.borderRadius = "3px";
  } else if (style.value === "tape") {
    base.padding = `${Math.round(fontSize.value * 0.3)}px ${Math.round(fontSize.value * 0.5)}px`;
    base.borderRadius = "2px";
    base.transform = "rotate(-8deg)";
  } else if (style.value === "flag") {
    base.padding = `${Math.round(fontSize.value * 0.3)}px ${Math.round(fontSize.value * 0.6)}px`;
    base.borderRadius = "0 4px 4px 0";
  } else if (style.value === "pulsing") {
    base.animation = "style-preview-pulse 1.5s ease-in-out infinite";
    base.padding = `${Math.round(fontSize.value * 0.3)}px ${Math.round(fontSize.value * 0.6)}px`;
    base.borderRadius = "4px";
  } else if (style.value === "vertical") {
    base.writingMode = "vertical-rl";
  }

  return base;
});

const textStyle = computed(() => {
  const s: Record<string, string> = {};
  if (style.value === "standard" || style.value === "bar" || style.value === "ribbon" || style.value === "tape" || style.value === "flag" || style.value === "badge" || style.value === "pulsing") {
    s.textShadow = `0 0 ${Math.max(1, Math.round(fontSize.value * 0.1))}px ${outlineColor.value}, 0 0 ${Math.max(2, Math.round(fontSize.value * 0.2))}px ${outlineColor.value}`;
  }
  return s;
});
</script>

<style scoped>
.style-preview {
  grid-column: 1 / -1;
  margin-top: 8px;
  padding: 12px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.style-preview-label {
  font-size: 12px;
  color: #aaa;
}
.style-preview-box {
  display: inline-block;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  white-space: nowrap;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
}
.style-standard {
  padding: 4px 10px;
  border-radius: 4px;
}
@keyframes style-preview-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
</style>
