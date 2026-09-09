import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AsrSegment } from "@clip/sdk";
import { mergeHumanHighlightMarkersIntoSegments } from "@clip/agent-core";
import { dataRoot } from "./config.js";

export interface HumanMarker {
  id: string;
  source_path: string;
  start_sec: number;
  end_sec: number;
  label: string;
  highlight_type: string;
  usable_as_hook: boolean;
  source: string;
  created_at: string;
}

function normalizeHighlightType(raw: string): AsrSegment["highlightType"] {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "hook" || t === "片头" || t === "片头钩子" || t === "钩子") return "hook";
  if (t === "twist" || t === "反转") return "twist";
  if (t === "cliff" || t === "悬念") return "cliff";
  if (t === "conflict" || t === "冲突") return "conflict";
  return "conflict";
}

/** 读取桌面端本地人工高光标记（含 suppress，合并时 suppress 先于 human） */
export function loadHumanMarkers(): HumanMarker[] {
  const path = join(dataRoot(), "highlight-markers.json");
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf-8");
    const all = JSON.parse(text) as HumanMarker[];
    if (!Array.isArray(all)) return [];
    return all.filter(
      (m) =>
        (m.source === "human" || m.source === "suppress") &&
        m.start_sec >= 0 &&
        m.end_sec > m.start_sec,
    );
  } catch {
    return [];
  }
}

/** 按 source_path 分组（路径归一化：统一小写+正斜杠，兼容不同机器盘符/分隔符写法） */
export function humanMarkersByPath(markers?: HumanMarker[]): Map<string, HumanMarker[]> {
  const norm = (p: string) => String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  const map = new Map<string, HumanMarker[]>();
  for (const m of markers || loadHumanMarkers()) {
    const key = norm(m.source_path);
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  }
  return map;
}

/** 将本地人工 / suppress 标记合并到 ASR 片段（人工最高优先级，严格写入人工起点） */
export function mergeHumanMarkersIntoSegments(
  segments: AsrSegment[],
  markers: HumanMarker[],
): AsrSegment[] {
  if (!markers.length) return segments;
  const inputs = markers.map((m) => ({
    startMs: Math.round(m.start_sec * 1000),
    endMs: Math.round(m.end_sec * 1000),
    label: m.label,
    highlightType: normalizeHighlightType(m.highlight_type),
    usableAsHook: m.usable_as_hook || normalizeHighlightType(m.highlight_type) === "hook",
    source: m.source === "suppress" ? ("suppress" as const) : ("human" as const),
    markerId: m.id,
  }));
  return mergeHumanHighlightMarkersIntoSegments(segments, inputs);
}
