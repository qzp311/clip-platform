import type { AsrHighlightType } from "@clip/sdk";

/**
 * 工位语义：高光=片头(opening/hook)，钩子=片尾(closing/cliff)。
 * 兼容存量：label 含「钩子」且 type=hook 时按片尾 cliff 解读。
 */
export function normalizeWorkstationMarkerType(
  highlightType?: string | null,
  label?: string | null,
): AsrHighlightType {
  const lb = String(label ?? "").trim();
  const t = String(highlightType ?? "")
    .trim()
    .toLowerCase();

  if (/钩子|悬念/.test(lb) || t === "cliff") return "cliff";
  if (/高光/.test(lb) || t === "hook" || /片头/.test(lb)) return "hook";
  if (t === "twist" || /反转/.test(lb)) return "twist";
  if (t === "conflict" || /冲突/.test(lb)) return "conflict";
  return "conflict";
}

export function isWorkstationOpeningMarker(
  highlightType?: string | null,
  label?: string | null,
): boolean {
  return normalizeWorkstationMarkerType(highlightType, label) === "hook";
}

export function isWorkstationClosingMarker(
  highlightType?: string | null,
  label?: string | null,
): boolean {
  return normalizeWorkstationMarkerType(highlightType, label) === "cliff";
}
