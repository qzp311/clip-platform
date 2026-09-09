import type { ClipPlan, ClipPlanBatch } from "@clip/sdk";

function episodeIdsFromClips(clips: ClipPlan["clips"]): string[] {
  const ids = new Set<string>();
  for (const clip of clips) {
    const m = clip.segmentId.match(/^(e\d+)_/);
    if (m) ids.add(m[1]!);
  }
  return [...ids].sort();
}

/** 将大模型选段结果完整输出到运行日志（桌面控制台可见） */
export function logClipPlanToConsole(plan: ClipPlan, label = "大模型选段结果"): void {
  console.log("");
  console.log("=".repeat(60));
  console.log(`【${label}】`);
  console.log("=".repeat(60));

  const epUsed = episodeIdsFromClips(plan.clips);
  if (epUsed.length) {
    console.log(`成片使用集数 (${epUsed.length}): ${epUsed.join(", ")}`);
    if (epUsed.length < 2 && /跨集/.test(label)) {
      console.log("⚠ 警告：跨集混剪但 primary 仅用了单集片段，请检查后续集是否有可用 ASR");
    }
  }

  if (plan.strategy) console.log(`策略 strategy: ${plan.strategy}`);
  if (plan.durationTier) console.log(`时长档 durationTier: ${plan.durationTier}`);
  if (plan.targetDurationSec != null) console.log(`目标时长 targetDurationSec: ${plan.targetDurationSec}s`);
  if (plan.estimatedDurationSec != null) console.log(`估算时长 estimatedDurationSec: ${plan.estimatedDurationSec}s`);
  if (plan.narrativeLine) console.log(`叙事线 narrativeLine: ${plan.narrativeLine}`);
  if (plan.confidence != null) console.log(`置信度 confidence: ${plan.confidence}`);
  if (plan.avoidReasons?.length) {
    console.log("未选片段 avoidReasons:");
    for (const r of plan.avoidReasons) console.log(`  - ${r}`);
  }

  console.log("");
  console.log("--- primary clips ---");
  for (const [i, clip] of plan.clips.entries()) {
    console.log(
      `  ${i + 1}. ${clip.segmentId}` +
        (clip.role ? ` [${clip.role}]` : "") +
        (clip.reason ? ` — ${clip.reason}` : ""),
    );
  }

  if (plan.alternatives?.length) {
    for (const [ai, alt] of plan.alternatives.entries()) {
      console.log("");
      console.log(`--- alternative ${ai + 1}: ${alt.strategy ?? "-"} / ${alt.durationTier ?? "-"} ---`);
      if (alt.narrativeLine) console.log(`  narrativeLine: ${alt.narrativeLine}`);
      for (const [i, clip] of alt.clips.entries()) {
        console.log(
          `  ${i + 1}. ${clip.segmentId}` +
            (clip.role ? ` [${clip.role}]` : "") +
            (clip.reason ? ` — ${clip.reason}` : ""),
        );
      }
    }
  }

  console.log("");
  console.log("--- 完整 JSON ---");
  console.log(JSON.stringify(plan, null, 2));
  console.log("=".repeat(60));
  console.log("");
}

/** 将一轮多方案选段结果输出到运行日志 */
export function logClipPlanBatchToConsole(batch: ClipPlanBatch, label = "大模型选段结果"): void {
  console.log("");
  console.log("=".repeat(60));
  console.log(`【${label}】`);
  console.log(
    `轮次 ${batch.round}/${batch.totalRounds}，本批 ${batch.plans.length} 条方案（配置 ${batch.plansPerRound}/轮）`,
  );
  console.log("=".repeat(60));

  for (const [i, plan] of batch.plans.entries()) {
    console.log("");
    console.log(`--- plan ${i + 1}/${batch.plans.length} ---`);
    if (plan.strategy) console.log(`  strategy: ${plan.strategy}`);
    if (plan.durationTier) console.log(`  durationTier: ${plan.durationTier}`);
    if (plan.estimatedDurationSec != null) {
      console.log(`  estimatedDurationSec: ${plan.estimatedDurationSec}s（ASR 时间轴之和）`);
    }
    if (plan.narrativeLine) console.log(`  narrativeLine: ${plan.narrativeLine}`);
    for (const [ci, clip] of plan.clips.entries()) {
      console.log(
        `  ${ci + 1}. ${clip.segmentId}` +
          (clip.role ? ` [${clip.role}]` : "") +
          (clip.reason ? ` — ${clip.reason}` : ""),
      );
    }
  }

  console.log("");
  console.log("--- 完整 JSON ---");
  console.log(JSON.stringify(batch, null, 2));
  console.log("=".repeat(60));
  console.log("");
}
