/**
 * 素材裂变批处理：多源 × 每源 M 条，小并发单 pass FFmpeg
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FISSION_OP_KINDS,
  FISSION_OP_LABELS,
  type FissionOpKind,
  type FissionVariantPlan,
  generateUniquePlans,
  renderFissionVariant,
  fissionOutputFileName,
  writeFissionManifest,
  probeVideoDurationMs,
} from "@clip/agent-core";
import { RenderJobQueue } from "./render-queue.js";
import { dataRoot } from "./config.js";
import {
  finishTaskProgress,
  startTaskProgress,
  updateTaskProgress,
} from "./task-progress.js";
import { resolveLocalOutputRoot } from "./local-output.js";
import type { EffectiveConfig } from "@clip/sdk";

export interface MaterialFissionOptions {
  sources: string[];
  variantsPerSource: number;
  concurrency?: number;
  allowedOps?: FissionOpKind[];
  outDir?: string;
  ffmpegPath: string;
  ffprobePath: string;
  seed?: number;
  /** 未传则用默认本地输出根 */
  config?: EffectiveConfig;
}

export interface MaterialFissionResult {
  batchId: string;
  outDir: string;
  total: number;
  ok: number;
  fail: number;
  items: Array<{
    source: string;
    index: number;
    outputPath?: string;
    signature?: string;
    ops?: string[];
    error?: string;
    wallTimeSec?: number;
  }>;
}

function parseAllowedOps(raw?: string[] | FissionOpKind[]): FissionOpKind[] | undefined {
  if (!raw?.length) return undefined;
  const set = new Set(FISSION_OP_KINDS);
  const out = raw
    .map((s) => String(s).trim() as FissionOpKind)
    .filter((k) => set.has(k));
  return out.length ? out : undefined;
}

function opLabels(ops: string[]): string {
  return ops.map((k) => FISSION_OP_LABELS[k as FissionOpKind] || k).join("+");
}

export function resolveFissionOutDir(
  config: EffectiveConfig | undefined,
  batchId: string,
  override?: string,
): string {
  if (override?.trim()) return override.trim();
  const root = resolveLocalOutputRoot((config ?? {}) as EffectiveConfig);
  return join(root, "fission", batchId);
}

export async function runMaterialFission(
  opts: MaterialFissionOptions,
): Promise<MaterialFissionResult> {
  const sources = [...new Set(opts.sources.map((s) => s.trim()).filter(Boolean))];
  if (!sources.length) throw new Error("未提供本地视频路径");
  const variantsPerSource = Math.max(1, Math.min(500, Math.floor(opts.variantsPerSource || 1)));
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency ?? 8)));
  const allowedOps = parseAllowedOps(opts.allowedOps);
  const batchId = `fission-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const outDir = resolveFissionOutDir(opts.config, batchId, opts.outDir);
  await mkdir(outDir, { recursive: true });

  const total = sources.length * variantsPerSource;
  const baseSeed = (opts.seed ?? Date.now()) >>> 0;

  console.log(
    `[material-fission] 开始 batch=${batchId} sources=${sources.length} variants=${variantsPerSource} total=${total} concurrency=${concurrency}`,
  );
  console.log(`[material-fission] 输出目录 ${outDir}`);
  console.log(`[material-fission] ffmpeg=${opts.ffmpegPath}`);

  await startTaskProgress({
    taskId: batchId,
    title: "素材裂变",
    kind: "material_fission",
    phaseCode: "render",
    phase: `素材裂变 0/${total}`,
    stepCurrent: 0,
    stepTotal: total,
  });

  await writeFile(
    join(dataRoot(), "fission-last.json"),
    JSON.stringify({ batchId, outDir, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  const queue = new RenderJobQueue(concurrency);
  const items: MaterialFissionResult["items"] = [];
  let done = 0;
  let ok = 0;
  let fail = 0;

  const bump = async (detail: string) => {
    await updateTaskProgress({
      active: true,
      phaseCode: "render",
      phase: detail,
      stepCurrent: done,
      stepTotal: total,
      title: "素材裂变",
      kind: "material_fission",
      taskId: batchId,
    });
  };

  const jobs: Promise<void>[] = [];

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si]!;
    let durationSec = 30;
    try {
      durationSec = (await probeVideoDurationMs(source, opts.ffprobePath)) / 1000;
      console.log(
        `[material-fission] 源 ${si + 1}/${sources.length} ${basename(source)} duration=${durationSec.toFixed(1)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[material-fission] 跳过源 ${basename(source)}: ${message}`);
      for (let i = 0; i < variantsPerSource; i++) {
        items.push({ source, index: i + 1, error: `无法读取时长: ${message}` });
        done += 1;
        fail += 1;
      }
      await bump(`素材裂变 ${done}/${total}（${basename(source)} 跳过）`);
      continue;
    }

    const plans = generateUniquePlans({
      count: variantsPerSource,
      baseSeed: (baseSeed + si * 10007) >>> 0,
      durationSec,
      allowedOps,
    });

    const stem = basename(source, extname(source)).replace(/[^\w\u4e00-\u9fff\-]+/g, "_").slice(0, 40);
    const sourceOut = join(outDir, stem || `src${si + 1}`);
    await mkdir(sourceOut, { recursive: true });

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const index = i + 1;
      jobs.push(
        queue.enqueue(async () => {
          const label = `${basename(source)}#${index}`;
          const opsText = opLabels(plan.ops.map((o) => o.kind));
          console.log(`[material-fission] 开始 ${label} ops=${opsText} sig=${plan.signature}`);
          try {
            const outputPath = join(
              sourceOut,
              fissionOutputFileName(source, index, plan.signature),
            );
            const result = await renderFissionVariant({
              ffmpegPath: opts.ffmpegPath,
              ffprobePath: opts.ffprobePath,
              sourcePath: source,
              outputPath,
              plan,
              durationSec,
            });
            items.push({
              source,
              index,
              outputPath: result.outputPath,
              signature: plan.signature,
              ops: plan.ops.map((o) => o.kind),
              wallTimeSec: result.wallTimeSec,
            });
            ok += 1;
            console.log(
              `[material-fission] 完成 ${label} ${result.wallTimeSec.toFixed(1)}s codec=${result.codec} → ${basename(result.outputPath)}`,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            items.push({
              source,
              index,
              signature: plan.signature,
              ops: plan.ops.map((o) => o.kind),
              error: message,
            });
            fail += 1;
            console.error(`[material-fission] 失败 ${label}: ${message.slice(0, 400)}`);
          } finally {
            done += 1;
            await bump(`素材裂变 ${done}/${total} · 成功 ${ok} · 失败 ${fail}`);
          }
        }),
      );
    }
  }

  await Promise.all(jobs);
  await queue.onIdle();

  items.sort((a, b) => a.source.localeCompare(b.source) || a.index - b.index);

  const manifest = {
    batchId,
    createdAt: new Date().toISOString(),
    variantsPerSource,
    concurrency,
    allowedOps: allowedOps ?? [...FISSION_OP_KINDS],
    sources,
    total,
    ok,
    fail,
    items,
  };
  await writeFissionManifest(outDir, manifest);
  await writeFile(
    join(dataRoot(), "fission-last.json"),
    JSON.stringify({ batchId, outDir, ok, fail, total, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  console.log(`[material-fission] 汇总 ok=${ok} fail=${fail} total=${total} out=${outDir}`);

  if (fail && !ok) {
    await finishTaskProgress({
      phase: `素材裂变失败 0/${total}`,
      error: items.find((i) => i.error)?.error || "全部失败",
    });
  } else {
    await finishTaskProgress({
      phase: `素材裂变完成 ${ok}/${total}${fail ? `（失败 ${fail}）` : ""}`,
    });
  }

  return { batchId, outDir, total, ok, fail, items };
}

export type { FissionVariantPlan };
