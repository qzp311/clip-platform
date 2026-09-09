export {
  scoreBurstText,
  scoreBurstSegment,
  isStrongBurstScore,
  isWeakClipReason,
  findBestBurstSegmentInEpisode,
  buildBurstWindowAroundSegment,
  formatBurstCandidatesForPrompt,
} from "./burst-heuristic.js";
export type { BurstScore, BurstScoreOptions } from "./burst-heuristic.js";
export {
  buildHighlightPrelabel,
  formatHighlightPrelabelForPrompt,
  resolvePreferredTagsByGenre,
} from "./highlight-prelabel.js";
export type {
  HighlightType,
  HighlightCandidate,
  HighlightPrelabelOptions,
} from "./highlight-prelabel.js";
export { annotateAsrSegmentsWithLabels } from "./asr-segment-labels.js";
export {
  HUMAN_HIGHLIGHT_SCORE,
  mergeHumanHighlightMarkersIntoSegments,
  applyClientHumanMarkerOverrides,
  type HumanHighlightMarkerInput,
} from "./human-marker-merge.js";
export {
  normalizeWorkstationMarkerType,
  isWorkstationOpeningMarker,
  isWorkstationClosingMarker,
} from "./workstation-marker-types.js";
export type { AnnotateAsrLabelsOptions } from "./asr-segment-labels.js";
export {
  probeSegmentLoudnessAt,
  probeSegmentLoudnessBatch,
  parseAstatsOutput,
  estimateCharCount,
  estimateSpeechRate,
  acousticScoreFromRms,
  isFillerOnlyText,
  isAnswerFillerText,
  classifySegmentSilenceAndFiller,
} from "./segment-loudness.js";
export type { SegmentLoudness, SegmentLoudnessOptions, SegmentSilenceAndFiller } from "./segment-loudness.js";
export { sampleAudioEnergyCurve, detectSceneCutDensity } from "./segment-loudness.js";
export { resolveGenreProfile, inferGenreProfile, resolveEraStyle, sampleAsrTextsForGenreInfer } from "./infer-genre-profile.js";
export type { GenreInferInput } from "./infer-genre-profile.js";
export {
  COMMON_BURST_PATTERNS,
  GENRE_BURST_PATTERNS,
  BLAND_KEYWORDS,
  HOOK_BLOCK_KEYWORDS,
} from "./genre-burst-lexicon.js";
export type { BurstLexiconPattern } from "./genre-burst-lexicon.js";
export { RuleEngine, validateClipPlan, repairClipPlan, resolveClipTimestamps, mergeAdjacentClipsForRender, mergeSameEpisodeContiguousSeqClips, collapseToEpisodeBlocksForRender, dedupeOverlappingRenderClips, prepareRenderClips, applyHookOpeningTrim, applyCliffClosingTrim, backfillSpeechStartFromRaw, extendEpisodeAsrTails, extendRenderClipsToEpisodeVideoTail, finalizeEpisodeAsrFromRaw, ensureContinuousEpisodeAsrTimeline, DEFAULT_EPISODE_VIDEO_TAIL_GAP_MS, ASR_SILENT_PLACEHOLDER_TEXT, DEFAULT_HOOK_OPENING_PAD_MS, DEFAULT_HOOK_MAX_LEAD_SILENCE_MS, computePlanDurationSec, inferDurationTierFromSec, computeRenderClipsDurationSec } from "./rule-engine.js";
export type { RuleEngineResult, RuleEngineApplyOptions, FinalizeEpisodeAsrOptions, PlanValidationResult, PrepareRenderClipsOptions, ResolvedRenderClip } from "./rule-engine.js";
export {
  repairClipPlanContiguity,
  contiguityWarnings,
  parseSegmentOrdinal,
  collectSegmentIdsFromPlans,
  planUsesAnySegment,
  buildContiguousWindow,
  relocatePlanAvoidingUsed,
  dedupePlanClipIds,
  removeAdjacentTimeOverlap,
  removePlanTimelineAndTextDuplicates,
  removeDuplicateEpisodeBlocks,
  sanitizePlanClips,
  buildCrossEpisodeMixWindow,
  pickCrossEpisodeMixWindow,
  expandPlanToMinDuration,
  expandPlanToDuration,
  expandClipBlockRanges,
  MIN_PLAN_DURATION_SEC,
  PREFERRED_PLAN_DURATION_SEC,
  MAX_PLAN_DURATION_SEC,
  DURATION_TIER_SPEC,
  BATCH_DURATION_TIERS,
  tierTargetDurationSec,
  tierExpandClipLimit,
} from "./clip-plan-coherence.js";
export {
  buildEpisodeOpeningWindow,
  buildEpisodeClosingWindow,
  enforceEpisodeBoundaryAnchors,
  extendClosingBlockToEpisodeEnd,
  finalizeSkillsMechanicalBoundaries,
  detectWholeEpisodeRuns,
  detectWholeEpisodeInLlmBlocks,
  validateLlmClosingThroughToEpisodeEnd,
  isAtEpisodeEnd,
  isNearEpisodeStart,
  isNearEpisodeEnd,
  EPISODE_BOUNDARY_INDEX_TOLERANCE,
  DEFAULT_OPENING_WINDOW_SEC,
  DEFAULT_CLOSING_WINDOW_SEC,
} from "./episode-boundary-anchors.js";
export type { EpisodeBoundaryAnchorOptions } from "./episode-boundary-anchors.js";
export {
  evaluateSkillsPlanQuality,
  buildSkillsPlanQualityReport,
  attachSkillsQualityToMixRenders,
  isSkillsPlanAcceptable,
} from "./skills-plan-quality.js";
export {
  applyEditFormToPlan,
  annotatePlanDurationMeta,
  computeClipsDurationSecWithThrough,
  assignSmartPlanSlot,
  hasRevealSpoilerEnding,
  inferDurationStatus,
  mapTargetLabelToTier,
  resolveTargetDurationSec,
  SMART_PLAN_HARD_MIN_DURATION_SEC,
  SMART_PLAN_MIN_CLIP_COUNT,
  SMART_PLAN_MIN_DURATION_SEC,
  SMART_PLAN_MAX_DURATION_SEC,
  TARGET_DURATION_PREFERRED_SEC,
} from "./smart-clip-plan.js";
export type {
  DurationPolicy,
  DurationStatus,
  EditForm,
  SmartPlanSlot,
  TargetDurationLabel,
} from "./smart-clip-plan.js";
export {
  buildCrossEpisodeXfadeFilterGraph,
  hasCrossEpisodeBoundary,
  pickRandomTransitionTypes,
  resolveTransitionConfig,
  resolveTransitionDurationSec,
  resolveTransitionTypesForRender,
  TRANSITION_POOL,
} from "./episode-transition.js";
export type { ClipEpisodeMeta, TransitionPoolType, XfadeFilterGraph } from "./episode-transition.js";
export { appendVideoEncodeArgs, resolveVideoCodec, shouldUseGpuVideoPipeline } from "./ffmpeg-encode.js";
export {
  probeFfmpegCapabilities,
  getFfmpegCapabilities,
  setFfmpegCapabilities,
  isNvencRenderAvailable,
  isGpuFilterPipelineAvailable,
  disableNvencForSession,
  shouldAttemptNvenc,
  resetFfmpegCapabilitySession,
  probeNvencSmoke,
} from "./ffmpeg-capability.js";
export type { FfmpegCapabilities, FfmpegPathSource, NvencSmokeResult } from "./ffmpeg-capability.js";
export {
  buildSinglePassConcatGraph,
  buildSinglePassXfadeGraph,
  buildTrimClipFilters,
} from "./ffmpeg-filter-graph.js";
export type { SinglePassFilterGraph, TrimClipSpec } from "./ffmpeg-filter-graph.js";
export {
  buildSinglePassGpuConcatGraph,
  buildSinglePassGpuXfadeGraph,
} from "./ffmpeg-filter-graph-gpu.js";
export {
  appendGpuOutputTimingArgs,
  buildGpuClipInputArgs,
  buildGpuGlobalArgs,
  resetGpuPipelineSession,
} from "./ffmpeg-gpu.js";
export { buildGpuVideoFilter } from "./video-filter.js";
export {
  remapClipsToTimeline,
  buildAssSubtitle,
} from "./subtitle-overlay.js";
export type { RenderClipForSubtitle, SubtitleEntry, BuildAssOptions } from "./subtitle-overlay.js";
export { remapPlanAsrToOutputTimeline } from "./output-timeline-asr.js";
export type {
  OutputTimelineAsrSegment,
  RemapPlanAsrToOutputTimelineResult,
} from "./output-timeline-asr.js";
export {
  buildRenderEnhancements,
  listBgmTrackUrls,
  pickRandomBgmTrack,
  normalizeDrawtextColor,
} from "./render-enhancements.js";
export type { EnhancementResult, EnhancementOptions } from "./render-enhancements.js";
export { buildWordArtFilter } from "./word-art.js";
export type { WordArtRenderInput } from "./word-art.js";
export { loadFontRegistry, loadFontRegistryAsync } from "./font-registry.js";
export type { FontRegistry, FontRecord, FontManifest, FontLicenseScope } from "./font-registry.js";
export { loadStickerRegistry, loadStickerRegistryAsync } from "./sticker-registry.js";
export type { StickerRegistry } from "./sticker-registry.js";
export { buildStickerOverlayFilter } from "./sticker-overlay.js";
export type { StickerRenderInput } from "./sticker-overlay.js";
export { FfmpegRenderer, probeVideoDurationMs, probeVideoInfo, resolveAsrSourceDurationMs } from "./ffmpeg-renderer.js";
export type { AsrSourceDurationInfo, ResolveAsrSourceDurationOptions } from "./ffmpeg-renderer.js";
export type { FfmpegRunnerOptions, RenderInput, RenderResult, VideoBasicInfo } from "./ffmpeg-renderer.js";
export { applyDeduplication } from "./ffmpeg-deduplication.js";
export type { DeduplicationResult, DeduplicationMode } from "./ffmpeg-deduplication.js";
export {
  FISSION_OP_KINDS,
  FISSION_OP_LABELS,
  createRng,
  signatureOfOps,
  generateVariantPlan,
  generateUniquePlans,
  buildFissionFilterGraph,
  computeKeepRanges,
  renderFissionVariant,
  fissionOutputFileName,
  writeFissionManifest,
} from "./material-fission.js";
export type {
  FissionOpKind,
  FissionAppliedOp,
  FissionVariantPlan,
  FissionFilterGraph,
  RenderFissionVariantInput,
  RenderFissionVariantResult,
} from "./material-fission.js";
