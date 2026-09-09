#!/usr/bin/env node
/**
 * 回填 clip_asr_segment 高光/情绪/场面标签（按剧目简介推断题材词表）
 * 用法: node scripts/backfill-asr-segment-labels.mjs
 * 可选: FORCE=1 强制全量重算（含已有 highlight_type）
 */
import mysql from "mysql2/promise";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateAsrSegmentsWithLabels,
  resolveGenreProfile,
} from "../packages/agent-core/dist/index.js";

function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, "deploy/.env.production");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const force = process.env.FORCE === "1";

const conn = await mysql.createConnection({
  host: process.env.CLIP_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.CLIP_MYSQL_PORT ?? 3306),
  user: process.env.CLIP_MYSQL_USER ?? "clip_platform",
  password: process.env.CLIP_MYSQL_PASSWORD ?? "",
  database: process.env.CLIP_MYSQL_DATABASE ?? "clip_platform",
  dateStrings: true,
});

const where = force
  ? "1=1"
  : "highlight_type IS NULL OR emotion IS NULL OR scene_type IS NULL OR label_source NOT LIKE '%genre:%'";

const [tasks] = await conn.query(
  `SELECT DISTINCT s.task_id,
          t.drama_id,
          d.title AS drama_title,
          d.meta_json,
          i.synopsis AS intake_synopsis
   FROM clip_asr_segment s
   LEFT JOIN clip_task t ON t.task_id = s.task_id
   LEFT JOIN clip_drama d ON d.drama_id = t.drama_id
   LEFT JOIN clip_drama_intake i ON i.linked_drama_id = t.drama_id
   WHERE ${where}`,
);
console.log("[backfill-labels] tasks:", tasks.length, force ? "(FORCE)" : "");

let updated = 0;
const genreStats = new Map();

for (const t of tasks) {
  const taskId = t.task_id;
  let meta = {};
  try {
    meta = t.meta_json
      ? typeof t.meta_json === "string"
        ? JSON.parse(t.meta_json)
        : t.meta_json
      : {};
  } catch {
    meta = {};
  }
  const title = t.drama_title || meta.title || meta.dramaTitle || undefined;
  const synopsis = meta.synopsis || t.intake_synopsis || undefined;
  const genreTags = Array.isArray(meta.genreTags) ? meta.genreTags : undefined;
  const genreProfile = resolveGenreProfile({
    genreProfile: meta.genreProfile,
    title,
    synopsis,
    genreTags,
  });
  genreStats.set(genreProfile ?? "common", (genreStats.get(genreProfile ?? "common") ?? 0) + 1);

  const [rows] = await conn.query(
    `SELECT segment_id, start_ms, end_ms, speech_start_ms, text, confidence, episode_id, episode_no, speaker_id
     FROM clip_asr_segment WHERE task_id = ? ORDER BY sort_order ASC`,
    [taskId],
  );
  const [raws] = await conn.query(
    `SELECT raw_id, start_ms, end_ms, text, confidence FROM clip_asr_raw_segment
     WHERE task_id = ? ORDER BY sort_order ASC`,
    [taskId],
  );
  const segments = rows.map((r) => ({
    segmentId: r.segment_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    speechStartMs: r.speech_start_ms ?? undefined,
    text: r.text,
    confidence: r.confidence ?? undefined,
    episodeId: r.episode_id ?? undefined,
    episodeNo: r.episode_no ?? undefined,
    speakerId: r.speaker_id ?? undefined,
  }));
  const labeled = annotateAsrSegmentsWithLabels(segments, {
    rawSegments: raws.map((r) => ({
      id: r.raw_id,
      startMs: r.start_ms,
      endMs: r.end_ms,
      text: r.text,
      confidence: r.confidence ?? undefined,
    })),
    genreProfile,
    title,
    synopsis,
    genreTags,
  });
  for (const seg of labeled) {
    await conn.execute(
      `UPDATE clip_asr_segment SET
        highlight_type = ?, highlight_score = ?, highlight_tags = ?, usable_as_hook = ?,
        speaker_id = ?, emotion = ?, scene_type = ?, label_source = ?
       WHERE task_id = ? AND segment_id = ?`,
      [
        seg.highlightType ?? null,
        seg.highlightScore ?? null,
        seg.highlightTags?.length ? seg.highlightTags.join(",") : null,
        seg.usableAsHook == null ? null : seg.usableAsHook ? 1 : 0,
        seg.speakerId ?? null,
        seg.emotion ?? null,
        seg.sceneType ?? null,
        seg.labelSource ?? null,
        taskId,
        seg.segmentId,
      ],
    );
    updated += 1;
  }
}

const [stats] = await conn.query(`
  SELECT COUNT(*) AS total,
         SUM(highlight_type IS NOT NULL) AS with_hl,
         SUM(usable_as_hook = 1) AS hooks,
         SUM(emotion IS NOT NULL) AS with_emo,
         SUM(scene_type IS NOT NULL) AS with_scene,
         SUM(speaker_id IS NOT NULL) AS with_spk,
         SUM(label_source LIKE '%genre:system_transmigration%') AS sys_flow,
         SUM(label_source LIKE '%genre:sweet_romance%') AS sweet,
         SUM(label_source LIKE '%genre:common%') AS common_only
  FROM clip_asr_segment
`);
console.log("[backfill-labels] rows updated:", updated);
console.log("[backfill-labels] genre by task:", Object.fromEntries(genreStats));
console.log("[backfill-labels] stats:", stats[0]);
await conn.end();
