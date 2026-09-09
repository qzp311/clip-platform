import type { AsrHighlightType, AsrSegment } from "@clip/sdk";
import {
  isWorkstationClosingMarker,
  isWorkstationOpeningMarker,
  normalizeWorkstationMarkerType,
} from "./workstation-marker-types.js";

export const HUMAN_HIGHLIGHT_SCORE = 999;

export interface HumanHighlightMarkerInput {
  startMs: number;
  endMs: number;
  label?: string;
  highlightType?: AsrHighlightType;
  usableAsHook?: boolean;
  source: "human" | "suppress";
  markerId?: number | string;
}

function overlapsSegment(seg: AsrSegment, startMs: number, endMs: number): boolean {
  return seg.endMs > startMs && seg.startMs < endMs;
}

function resolveMarkerType(m: HumanHighlightMarkerInput): AsrHighlightType {
  return normalizeWorkstationMarkerType(m.highlightType, m.label);
}

function applySuppressToSegment(seg: AsrSegment): AsrSegment {
  return {
    ...seg,
    highlightType: undefined,
    highlightScore: 0,
    usableAsHook: false,
    highlightTags: [],
    humanMarkerStartMs: undefined,
    humanMarkerEndMs: undefined,
    labelSource: [seg.labelSource ?? "", "suppressed"].filter(Boolean).join("+"),
  };
}

function applyHumanToSegment(seg: AsrSegment, m: HumanHighlightMarkerInput): AsrSegment {
  const ht = resolveMarkerType(m);
  const opening = isWorkstationOpeningMarker(ht, m.label);
  const closing = isWorkstationClosingMarker(ht, m.label);
  const next: AsrSegment = {
    ...seg,
    highlightType: ht,
    highlightScore: Math.max(seg.highlightScore ?? 0, HUMAN_HIGHLIGHT_SCORE),
    // 片头标记授予 hook；片尾标记显式撤销（防旧 hook 资格残留）；其余类型不降级段上已有 hook 资格
    usableAsHook: opening ? true : closing ? false : Boolean(seg.usableAsHook),
    humanMarkerStartMs: m.startMs,
    humanMarkerEndMs: m.endMs,
    labelSource: [seg.labelSource ?? "", "human_marker"].filter(Boolean).join("+"),
  };
  if (opening) {
    next.speechStartMs = m.startMs;
  }
  if (!closing && !next.speechStartMs) {
    next.speechStartMs = seg.speechStartMs ?? seg.startMs;
  }
  if (!next.highlightTags?.length) {
    next.highlightTags = [m.label?.trim() || (opening ? "人工高光" : "人工钩子")];
  }
  return next;
}

/**
 * 人工高光 / suppress 合并到 ASR 段。
 * 顺序：先 suppress，再 human（人工优先级最高，可覆盖同区 suppress）。
 * 人工标记严格写入 humanMarkerStartMs / speechStartMs 供渲染与 hook 切点使用。
 */
export function mergeHumanHighlightMarkersIntoSegments(
  segments: AsrSegment[],
  markers: HumanHighlightMarkerInput[],
  episodeId?: string,
): AsrSegment[] {
  if (!markers.length) return segments;
  const out = segments.map((s) => ({ ...s }));

  const suppressMarkers = markers.filter((m) => m.source === "suppress");
  const humanMarkers = markers.filter((m) => m.source !== "suppress");

  for (const m of suppressMarkers) {
    for (let i = 0; i < out.length; i++) {
      if (overlapsSegment(out[i]!, m.startMs, m.endMs)) {
        out[i] = applySuppressToSegment(out[i]!);
      }
    }
  }

  for (const m of humanMarkers) {
    let overlapped = false;
    for (let i = 0; i < out.length; i++) {
      if (overlapsSegment(out[i]!, m.startMs, m.endMs)) {
        overlapped = true;
        out[i] = applyHumanToSegment(out[i]!, m);
      }
    }
    if (!overlapped) {
      const ht = resolveMarkerType(m);
      const opening = isWorkstationOpeningMarker(ht, m.label);
      out.push({
        segmentId: `human-${m.markerId ?? `${m.startMs}-${m.endMs}`}`,
        startMs: m.startMs,
        endMs: m.endMs,
        text: m.label?.trim() || (opening ? "人工高光" : "人工钩子"),
        episodeId,
        speechStartMs: opening ? m.startMs : m.startMs,
        humanMarkerStartMs: m.startMs,
        humanMarkerEndMs: m.endMs,
        highlightType: ht,
        highlightScore: HUMAN_HIGHLIGHT_SCORE,
        usableAsHook: opening,
        highlightTags: [m.label?.trim() || (opening ? "人工高光" : "人工钩子")],
        labelSource: "human_marker",
      });
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

/** Agent 侧已合并的人工字段覆盖到服务端段（按 segmentId；补 client 独有 human-* 段） */
export function applyClientHumanMarkerOverrides(
  serverSegments: AsrSegment[],
  clientSegments: AsrSegment[],
): AsrSegment[] {
  const clientHuman = clientSegments.filter((s) =>
    (s.labelSource ?? "").includes("human_marker"),
  );
  if (!clientHuman.length) return serverSegments;

  const byId = new Map(serverSegments.map((s) => [s.segmentId, { ...s }]));
  for (const c of clientHuman) {
    const existing = byId.get(c.segmentId);
    if (existing) {
      byId.set(c.segmentId, {
        ...existing,
        highlightType: c.highlightType ?? existing.highlightType,
        highlightScore: Math.max(existing.highlightScore ?? 0, c.highlightScore ?? HUMAN_HIGHLIGHT_SCORE),
        usableAsHook: c.usableAsHook ?? existing.usableAsHook,
        highlightTags: c.highlightTags?.length ? c.highlightTags : existing.highlightTags,
        humanMarkerStartMs: c.humanMarkerStartMs ?? existing.humanMarkerStartMs,
        humanMarkerEndMs: c.humanMarkerEndMs ?? existing.humanMarkerEndMs,
        speechStartMs: c.humanMarkerStartMs ?? c.speechStartMs ?? existing.speechStartMs,
        labelSource: [existing.labelSource ?? "", "human_marker"].filter(Boolean).join("+"),
      });
    } else if (c.segmentId.startsWith("human-")) {
      byId.set(c.segmentId, { ...c });
    }
  }
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
