/**
 * 跨成片软占用画像：只用于 prompt 引导与候选择优，不作为硬拒绝闸门。
 */
import type { AsrSegment, ClipPlan } from "@clip/sdk";

export type SoftOccupancy = {
  /** 展开后的段占用次数 */
  segmentUseCounts: Map<string, number>;
  /** 已用集路径（如 e01→e03） */
  episodePaths: string[];
  /** 开篇集出现次数 */
  entryEpisodeCounts: Map<string, number>;
  /** 收束集出现次数 */
  closingEpisodeCounts: Map<string, number>;
  /** hook 段占用次数 */
  hookSegmentCounts: Map<string, number>;
};

function episodeKeyOf(segmentId: string): string {
  return segmentId.match(/^(e\d+)/i)?.[1]?.toLowerCase() ?? segmentId;
}

export function episodePathOfPlan(plan: ClipPlan): string {
  const eps: string[] = [];
  for (const c of plan.clips) {
    const ep = episodeKeyOf(c.segmentId);
    if (ep && eps.at(-1) !== ep) eps.push(ep);
  }
  return eps.join("→");
}

export function entryEpisodeOfPlan(plan: ClipPlan): string | undefined {
  const first = plan.clips[0]?.segmentId;
  return first ? episodeKeyOf(first) : undefined;
}

export function closingEpisodeOfPlan(plan: ClipPlan): string | undefined {
  const last = plan.clips.at(-1)?.segmentId;
  return last ? episodeKeyOf(last) : undefined;
}

/** 从已展开/未展开 clips 收集 segmentId（含 through 近似展开） */
export function collectPlanSegmentIds(plan: ClipPlan, segments?: AsrSegment[]): string[] {
  if (!segments?.length) {
    const ids: string[] = [];
    for (const c of plan.clips) {
      ids.push(c.segmentId);
      if (c.throughSegmentId && c.throughSegmentId !== c.segmentId) {
        ids.push(c.throughSegmentId);
      }
    }
    return ids;
  }

  const byEp = new Map<string, AsrSegment[]>();
  for (const seg of segments) {
    const ep = (seg.episodeId ?? episodeKeyOf(seg.segmentId)).toLowerCase();
    const list = byEp.get(ep) ?? [];
    list.push(seg);
    byEp.set(ep, list);
  }
  for (const list of byEp.values()) {
    list.sort((a, b) => {
      const oa = a.segmentId.match(/_s(\d+)$/i);
      const ob = b.segmentId.match(/_s(\d+)$/i);
      const na = oa ? Number.parseInt(oa[1]!, 10) : a.startMs;
      const nb = ob ? Number.parseInt(ob[1]!, 10) : b.startMs;
      return na - nb || a.startMs - b.startMs;
    });
  }

  const ids: string[] = [];
  for (const c of plan.clips) {
    const through = c.throughSegmentId ?? c.segmentId;
    if (through === c.segmentId) {
      ids.push(c.segmentId);
      continue;
    }
    const ep = episodeKeyOf(c.segmentId);
    const list = byEp.get(ep) ?? [];
    const startIdx = list.findIndex((s) => s.segmentId === c.segmentId);
    const endIdx = list.findIndex((s) => s.segmentId === through);
    if (startIdx >= 0 && endIdx >= startIdx) {
      for (let i = startIdx; i <= endIdx; i++) ids.push(list[i]!.segmentId);
    } else {
      ids.push(c.segmentId, through);
    }
  }
  return ids;
}

function bump(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

export function emptySoftOccupancy(): SoftOccupancy {
  return {
    segmentUseCounts: new Map(),
    episodePaths: [],
    entryEpisodeCounts: new Map(),
    closingEpisodeCounts: new Map(),
    hookSegmentCounts: new Map(),
  };
}

export function buildSoftOccupancyFromPlans(
  plans: ClipPlan[],
  segments?: AsrSegment[],
): SoftOccupancy {
  const out = emptySoftOccupancy();
  for (const plan of plans) {
    const path = episodePathOfPlan(plan);
    if (path) out.episodePaths.push(path);
    const entry = entryEpisodeOfPlan(plan);
    if (entry) bump(out.entryEpisodeCounts, entry);
    const closing = closingEpisodeOfPlan(plan);
    if (closing) bump(out.closingEpisodeCounts, closing);
    for (const id of collectPlanSegmentIds(plan, segments)) {
      bump(out.segmentUseCounts, id);
    }
    const hook = plan.clips.find((c) => c.role === "hook") ?? plan.clips[0];
    if (hook) bump(out.hookSegmentCounts, hook.segmentId);
  }
  return out;
}

/** 从扁平 usedSegmentIds（可含重复）合成占用画像；路径类信息需另传 */
export function buildSoftOccupancyFromSegmentIds(
  usedSegmentIds: string[],
  extras?: {
    episodePaths?: string[];
    entryEpisodeIds?: string[];
    closingEpisodeIds?: string[];
    hookSegmentIds?: string[];
  },
): SoftOccupancy {
  const out = emptySoftOccupancy();
  for (const id of usedSegmentIds) {
    if (id) bump(out.segmentUseCounts, id);
  }
  for (const p of extras?.episodePaths ?? []) {
    if (p) out.episodePaths.push(p);
  }
  for (const e of extras?.entryEpisodeIds ?? []) {
    if (e) bump(out.entryEpisodeCounts, e);
  }
  for (const e of extras?.closingEpisodeIds ?? []) {
    if (e) bump(out.closingEpisodeCounts, e);
  }
  for (const h of extras?.hookSegmentIds ?? []) {
    if (h) bump(out.hookSegmentCounts, h);
  }
  return out;
}

export function mergeSoftOccupancy(a: SoftOccupancy, b: SoftOccupancy): SoftOccupancy {
  const out = emptySoftOccupancy();
  for (const [k, v] of a.segmentUseCounts) bump(out.segmentUseCounts, k, v);
  for (const [k, v] of b.segmentUseCounts) bump(out.segmentUseCounts, k, v);
  out.episodePaths = [...a.episodePaths, ...b.episodePaths];
  for (const [k, v] of a.entryEpisodeCounts) bump(out.entryEpisodeCounts, k, v);
  for (const [k, v] of b.entryEpisodeCounts) bump(out.entryEpisodeCounts, k, v);
  for (const [k, v] of a.closingEpisodeCounts) bump(out.closingEpisodeCounts, k, v);
  for (const [k, v] of b.closingEpisodeCounts) bump(out.closingEpisodeCounts, k, v);
  for (const [k, v] of a.hookSegmentCounts) bump(out.hookSegmentCounts, k, v);
  for (const [k, v] of b.hookSegmentCounts) bump(out.hookSegmentCounts, k, v);
  return out;
}

function topCountLines(map: Map<string, number>, limit: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k, n]) => `${k}(${n}次)`);
}

/**
 * Prompt：跨成片避让偏好（软约束，叙事合格优先）
 */
export function formatUsedAvoidanceSection(occupancy: SoftOccupancy): string {
  const segTop = topCountLines(occupancy.segmentUseCounts, 30);
  if (!segTop.length && !occupancy.episodePaths.length) return "";

  const entryTop = topCountLines(occupancy.entryEpisodeCounts, 8);
  const closingTop = topCountLines(occupancy.closingEpisodeCounts, 8);
  const hookTop = topCountLines(occupancy.hookSegmentCounts, 10);
  const paths = [...new Set(occupancy.episodePaths)].slice(0, 12);

  const lines = [
    "## 跨成片避让偏好（软约束，叙事合格优先）",
    "- **不是禁止清单**：若叙事必须少量重叠可以重叠，但 hook / 收束尖点尽量换新。",
    "- 本轮骨架已按批号旋转；优先按方案建议窗取材，入口集与收束集尽量错开已高频占用。",
  ];
  if (entryTop.length) {
    lines.push(`- 高占用入口集：${entryTop.join("、")} → 本轮尽量换入口集或同集其他场`);
  }
  if (closingTop.length) {
    lines.push(
      `- 高占用收束集：${closingTop.join("、")} → 仍须贴集尾，但优先换到未多用的收束集；同集则换另一冲突收束点`,
    );
  }
  if (hookTop.length) {
    lines.push(`- 已用 hook 尖点：${hookTop.join("、")} → 勿原窗照抄作主钩`);
  }
  if (paths.length) {
    lines.push(`- 已用集路径示例：${paths.join("、")} → 优先滑动到未用邻窗`);
  }
  if (segTop.length) {
    lines.push(`- 高占用段 Top：${segTop.join("、")}`);
  }
  return lines.join("\n");
}

/** 方案相对占用集合的重合比例 |∩| / |plan| */
export function planOverlapRatio(plan: ClipPlan, usedSegmentIds: Iterable<string>): number {
  const used = usedSegmentIds instanceof Set ? usedSegmentIds : new Set(usedSegmentIds);
  const segs = [...new Set(plan.clips.map((c) => c.segmentId))];
  if (!segs.length) return 0;
  let hit = 0;
  for (const id of segs) if (used.has(id)) hit += 1;
  return hit / segs.length;
}

/** 与已 keep 方案的最大 Jaccard */
export function planMaxJaccardWithPlans(plan: ClipPlan, others: ClipPlan[]): number {
  const setA = new Set(plan.clips.map((c) => c.segmentId));
  if (!setA.size) return 0;
  let max = 0;
  for (const other of others) {
    const setB = new Set(other.clips.map((c) => c.segmentId));
    let inter = 0;
    for (const id of setA) if (setB.has(id)) inter += 1;
    const union = setA.size + setB.size - inter;
    if (union > 0) max = Math.max(max, inter / union);
  }
  return max;
}
