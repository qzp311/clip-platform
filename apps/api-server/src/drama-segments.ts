export {
  episodeIdFromNo,
  prefixEpisodeSegments,
  mergeDramaSegments,
  parseEpisodeNoFromMediaPath,
  compareEpisodeMediaPath,
  parseEpisodeSortKey,
} from "@clip/sdk";

export function parseEpisodeIdFromSegmentId(segmentId: string): string | undefined {
  const match = /^((?:e)\d{2})_/i.exec(segmentId);
  return match?.[1];
}
