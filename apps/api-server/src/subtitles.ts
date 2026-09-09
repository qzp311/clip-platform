import type { AsrSegment, RawAsrSegment } from "@clip/sdk";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const msPart = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(msPart).padStart(3, "0")}`;
}

export function segmentsToSrt(segments: Array<{ startMs: number; endMs: number; text: string }>): string {
  return segments
    .map((seg, index) => {
      const text = seg.text.trim();
      if (!text) return "";
      return `${index + 1}\n${msToSrtTime(seg.startMs)} --> ${msToSrtTime(seg.endMs)}\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

export function rawSegmentsToAsrLike(raw: RawAsrSegment[]): AsrSegment[] {
  return raw.map((seg) => ({
    segmentId: seg.id,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
    confidence: seg.confidence,
  }));
}

/** 字幕下载链接（从 MySQL 动态导出，不写本地 outputs） */
export function buildAsrSubtitleUrls(apiBase: string, taskId: string): {
  subtitleUrl: string;
  subtitlesJsonUrl: string;
} {
  const base = apiBase.replace(/\/$/, "");
  const id = encodeURIComponent(taskId);
  return {
    subtitleUrl: `${base}/admin/api/asr-results/${id}/subtitles.srt`,
    subtitlesJsonUrl: `${base}/admin/api/asr-results/${id}/subtitles.json`,
  };
}
