import type { AsrSegment, DramaEpisodeRecord } from "./index.js";

export function episodeIdFromNo(episodeNo: number): string {
  return `e${String(episodeNo).padStart(2, "0")}`;
}

export function prefixEpisodeSegments(
  segments: AsrSegment[],
  episodeId: string,
  episodeNo: number,
): AsrSegment[] {
  return segments.map((seg) => ({
    ...seg,
    segmentId: `${episodeId}_${seg.segmentId}`,
    episodeId,
    episodeNo,
  }));
}

export function mergeDramaSegments(episodes: DramaEpisodeRecord[]): AsrSegment[] {
  const sorted = [...episodes].sort((a, b) => a.episodeNo - b.episodeNo);
  const merged: AsrSegment[] = [];

  for (const ep of sorted) {
    if (!ep.segments?.length) continue;
    merged.push(...prefixEpisodeSegments(ep.segments, ep.episodeId, ep.episodeNo));
  }

  return merged;
}
