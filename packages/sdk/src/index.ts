import {
  DEFAULT_RESOURCE_POLICY,
  mergeResourcePolicy,
  resolveResourcePolicy,
  type ResourcePolicyConfig,
} from "./resource-policy.js";

export interface RawAsrSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  /** 说话人 ID（若 ASR/声纹链路产出）；当前 FunASR 默认无 */
  speakerId?: string;
  /** 段均方根响度（dBFS，负值）；由 ffmpeg astats 探测，缺失则不参与高光打分 */
  rmsDb?: number;
  /** 段峰值响度（dBFS，负值） */
  peakDb?: number;
  /** 语速（字/秒），按段时长与文本字数估算 */
  speechRate?: number;
}

/** 投放/叙事高光类型（台词启发式） */
export type AsrHighlightType = "hook" | "conflict" | "twist" | "cliff";

/** 文本启发式情绪（非音频情感模型） */
export type AsrEmotionLabel =
  | "anger"
  | "sad"
  | "fear"
  | "joy"
  | "tender"
  | "suspense"
  | "neutral";

/**
 * 场景类型：当前为台词推断的「场面倾向」，非真实画面理解。
 * 后续视觉模型可覆盖同字段，并用 labelSource 区分。
 */
export type AsrSceneType =
  | "conflict_dialogue"
  | "reveal"
  | "suspense"
  | "setup"
  | "monologue"
  | "cta"
  | "unknown";

export interface AsrSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  /**
   * 真实开口时间（ms）：连续化前 ASR 首音起点。
   * 片头静音并入后 startMs 可能为 0，投放 hook 切点须用本字段 − 前垫，避免片头干等或切光画面。
   */
  speechStartMs?: number;
  /**
   * 真实闭口时间（ms）：连续化前 ASR 末音终点。
   * 用于检测段尾静音/空镜，避免把 filler/应答句后的大段空白剪进成片。
   */
  speechEndMs?: number;
  /** 前导静音时长（ms），startMs 到首音之间的空白 */
  leadingSilenceMs?: number;
  /** 尾随静音时长（ms），末音到 endMs 之间的空白 */
  trailingSilenceMs?: number;
  /** 是否为纯 filler/语气词/短应答段，不适合单独当 hook 或 through 块 */
  isFillerOnly?: boolean;
  /** 是否为孤立回答类语气词（好的、是、没错、对 等），会让成片突兀 */
  isAnswerFiller?: boolean;
  /** 所属集数 ID，如 e01（跨集混剪时使用） */
  episodeId?: string;
  /** 集序号，从 1 开始 */
  episodeNo?: number;

  /** 高光类型（台词启发式，入库持久化） */
  highlightType?: AsrHighlightType;
  /** 高光分 */
  highlightScore?: number;
  /** 高光标签，如 羞辱冲突/反转 */
  highlightTags?: string[];
  /** 是否适合作投放片头 */
  usableAsHook?: boolean;
  /** 说话人（声纹/diarization；无模型时为空） */
  speakerId?: string;
  /** 情绪标签（当前文本启发式） */
  emotion?: AsrEmotionLabel;
  /** 场面类型（当前文本启发式，非视觉） */
  sceneType?: AsrSceneType;
  /** 段均方根响度（dBFS，负值）；由 ffmpeg astats 探测，缺失则不参与高光打分 */
  rmsDb?: number;
  /** 段峰值响度（dBFS，负值） */
  peakDb?: number;
  /** 语速（字/秒），按段时长与文本字数估算 */
  speechRate?: number;
  /**
   * 标签来源，如 text_heuristic / speaker_model / vision_model
   * 多来源时用 `+` 拼接
   */
  labelSource?: string;
  /** 人工高光区间起点（绝对 ms）；渲染与 hook 切点严格优先使用 */
  humanMarkerStartMs?: number;
  /** 人工高光区间终点（绝对 ms）；可选封顶裁剪 */
  humanMarkerEndMs?: number;
}


export interface HotwordItem {
  text: string;
  weight?: number;
}

export interface AsrRules {
  ruleSetId: string;
  ruleSetVersion: string;
  pipeline?: {
    enableVad?: boolean;
    enablePunc?: boolean;
    sentenceLevel?: boolean;
  };
  vad?: {
    minSpeechMs?: number;
    mergeGapMs?: number;
  };
  merge?: {
    minGapMs?: number;
    maxSentenceMs?: number;
    splitOnPunc?: string[];
  };
  filter?: {
    minSegmentMs?: number;
    maxSegmentMs?: number;
    minConfidence?: number;
    dropEmptyText?: boolean;
    dropFillersOnly?: boolean;
  };
  hotwords?: {
    version?: string;
    items?: HotwordItem[];
  };
  text?: {
    enableItn?: boolean;
    trimWhitespace?: boolean;
    removeFillers?: string[];
  };
  output?: {
    segmentIdPrefix?: string;
    /** 输出段数上限（超过则截断） */
    maxSegments?: number;
  };
}

export interface AsrRuntimeConfig {
  device: string;
  maxSingleSegmentMs?: number;
  batchSizeSec?: number;
}

export interface AsrConfig {
  models: {
    asr: string;
    vad: string;
    punc: string;
  };
  runtime: AsrRuntimeConfig;
  rules: AsrRules;
}

export interface RenderEncodeConfig {
  codec: string;
  preset?: string;
  cq?: number;
  crf?: number;
  fallback?: {
    codec: string;
    preset?: string;
    crf?: number;
  };
}

/** 本地混剪方案策略（字段名保留 llm 以兼容旧配置） */
export interface LlmPublicConfig {
  /** 每轮输出几条混剪方案 */
  plansPerRound?: number;
  /** 每部短剧混剪轮数 */
  mixRoundsPerDrama?: number;
  clipSelectionMode?: ClipSelectionMode;
  durationPolicy?: DurationPolicy;
}

export type ClipSelectionMode = "skills" | "local";
export type DurationPolicy = "soft" | "strict";
export type EditForm = "sequential" | "skip_episode" | "hook_first" | "commentary";
export type TargetDurationLabel = "3min" | "10min";
export type DurationStatus = "on_target" | "under_preferred" | "over_preferred";
export type GenreProfile =
  | "urban_male"
  | "era_male"
  | "sweet_romance"
  | "revenge_female"
  | "palace_intrigue"
  | "system_transmigration";
export type AudienceChannel = "male_channel" | "female_channel";

export const GENRE_PROFILES: readonly GenreProfile[] = [
  "urban_male",
  "era_male",
  "sweet_romance",
  "revenge_female",
  "palace_intrigue",
  "system_transmigration",
] as const;

export function isGenreProfile(value: unknown): value is GenreProfile {
  return typeof value === "string" && (GENRE_PROFILES as readonly string[]).includes(value);
}

/** 跨集切换转场（ffmpeg xfade / acrossfade） */
export interface RenderTransitionConfig {
  /** 跨集切换时启用转场，默认 false（硬切更快） */
  enabled?: boolean;
  /** ffmpeg xfade 转场名；填 random 则每次渲染从池中随机（默认 random） */
  type?: string;
  /** 转场时长（秒），默认 0.5 */
  durationSec?: number;
}

/** 字幕烧录样式模板 */
export type SubtitleStyle = "standard" | "glow" | "stroke3d" | "softshadow";

/** 字幕烧录样式（ASS，烧录到成片画面） */
export interface SubtitleStyleConfig {
  /** 是否烧录字幕到成片，默认 true（plan.output.subtitle !== false 时生效） */
  enabled?: boolean;
  /** 字体名；留空用系统默认（Windows: Microsoft YaHei） */
  fontName?: string;
  /** 字号（px，基于 1080p 高度），默认 48 */
  fontSize?: number;
  /** 主颜色，ASS 十六进制 &HAABBGGRR（注意顺序），默认白色 &H00FFFFFF */
  primaryColor?: string;
  /** 描边颜色，默认黑色 &H00000000 */
  outlineColor?: string;
  /** 描边宽度（px），默认 2 */
  outlineWidth?: number;
  /** 底部边距（px，基于 1080p 高度），默认 80 */
  marginV?: number;
  /** 字幕垂直对齐：bottom（默认）/ center / top */
  alignment?: "bottom" | "center" | "top";
  /** 样式模板，默认 standard */
  style?: SubtitleStyle;
}

/** 单首 BGM 候选 */
export interface BgmTrackConfig {
  /** 展示名（可选） */
  name?: string;
  /** 音频 URL（mp3/wav/aac 等） */
  url: string;
}

/** 背景音乐混音（支持多首候选，渲染时随机选一首） */
export interface BgmConfig {
  /** 是否启用 BGM，默认 false */
  enabled?: boolean;
  /**
   * 多首 BGM 候选；启用时渲染随机挑一首下载混音。
   * 兼容旧配置：无 tracks 时回退读 url。
   */
  tracks?: BgmTrackConfig[];
  /** @deprecated 旧单曲 URL；无 tracks 时仍可用 */
  url?: string;
  /** BGM 音量（0~1），默认 0.25 */
  volume?: number;
  /** 淡入秒数，默认 1 */
  fadeInSec?: number;
  /** 淡出秒数，默认 2 */
  fadeOutSec?: number;
  /** BGM 是否循环到成片结束，默认 true */
  loop?: boolean;
}

/** 标题花字样式模板：标准/高对比条/发光/3D描边/竖排（与免责声明共享样式） */
export type TitleCardStyle = "standard" | "bar" | "glow" | "stroke3d" | "vertical";

/** 标题花字模式：all=全部叠加，one_random=每成片随机选一条 */
export type TitleCardMode = "all" | "one_random";

/** 标题花字（drawtext 叠加到画面顶部） */
export interface TitleCardConfig {
  /** 文本内容 */
  text: string;
  /** 字体名；留空用系统默认 */
  fontName?: string;
  /** 字号（px，基于 1080p 高度），默认 64 */
  fontSize?: number;
  /** 颜色，十六进制 #RRGGBB，默认 #FFD700（金色） */
  color?: string;
  /** 描边颜色，默认 #000000 */
  outlineColor?: string;
  /** 描边宽度（px），默认 3 */
  outlineWidth?: number;
  /** 背景颜色，默认 #000000（黑） */
  backgroundColor?: string;
  /** 背景透明度（0~1），默认 0.35；0 表示无背景 */
  backgroundAlpha?: number;
  /** 垂直位置：top（默认）/ center / bottom */
  position?: "top" | "center" | "bottom";
  /** 距顶/底边距（px，基于 1080p 高度），默认 60 */
  marginV?: number;
  /** 样式模板，默认 standard；与免责声明的样式含义一致：standard=标准描边，bar=高对比条，glow=外发光，stroke3d=3D描边，vertical=竖排 */
  style?: TitleCardStyle;
  /** 应用模式：all=全部叠加，one_random=每成片只随机选一条（默认 one_random） */
  mode?: TitleCardMode;
  /** 字符间距（px，仅 vertical 样式生效），默认 4 */
  charSpacing?: number;
}

/** 免责声明样式模板：标准/高对比条/发光/竖排 */
export type DisclaimerLineStyle = "standard" | "bar" | "glow" | "vertical";

/** 单条免责声明/剧集提示条配置 */
export interface DisclaimerLineConfig {
  /** 是否启用本条目，默认 true */
  enabled?: boolean;
  /** 文案内容；为空时使用默认合集里对应行 */
  text?: string;
  /** 出现位置：top / bottom / left / right */
  position?: "top" | "bottom" | "left" | "right";
  /** 字体名；留空用系统默认 */
  fontName?: string;
  /** 字号（px，基于 1080p 高度），默认 28 */
  fontSize?: number;
  /** 字体颜色，默认 #FFFFFF */
  color?: string;
  /** 描边颜色，默认 #000000 */
  outlineColor?: string;
  /** 描边宽度（px），默认 2 */
  outlineWidth?: number;
  /** 距边距（px，基于 1080p 高度），默认 24 */
  margin?: number;
  /** 字符间距（px，仅 left/right 竖排生效；top/bottom 忽略），默认 4 */
  charSpacing?: number;
  /** 背景颜色，默认 #000000（黑） */
  backgroundColor?: string;
  /** 背景透明度（0~1），默认 0.35；0 表示无背景 */
  backgroundAlpha?: number;
  /** 样式模板，默认 standard */
  style?: DisclaimerLineStyle;
}

/** 角标样式模板：丝带/胶带/徽章/旗帜/呼吸闪烁/标准描边/外发光/3D描边/无 */
export type CornerWatermarkStyle = "ribbon" | "tape" | "badge" | "flag" | "pulsing" | "standard" | "glow" | "stroke3d" | "none";

export type CornerWatermarkPosition =
  | "top-left"
  | "top-right"
  | "center-left"
  | "center-right"
  | "bottom-left"
  | "bottom-right";

/** 角标配置（支持多个角标，位置可配） */
export interface CornerWatermarkConfig {
  /** 是否启用，默认 false */
  enabled?: boolean;
  /** 应用模式：all=全部成片，random=随机部分成片，none=不应用。默认 all */
  mode?: "all" | "random" | "none";
  /** random 模式时的概率（0~1），默认 0.5 */
  randomRatio?: number;
  /** random 模式时的随机种子，相同种子+输出序号得到稳定结果。默认 0 */
  randomSeed?: number;
  /** 角标文案 */
  text: string;
  /** 字号（px，基于 1080p 高度），默认 48 */
  fontSize?: number;
  /** 字体名，默认 Microsoft YaHei */
  fontName?: string;
  /** 文字颜色，默认 #FFFFFF（白） */
  color?: string;
  /** 描边颜色，默认 #000000（黑） */
  outlineColor?: string;
  /** 描边宽度（px），默认 2 */
  outlineWidth?: number;
  /** 背景颜色，默认 #FF0000（红） */
  backgroundColor?: string;
  /** 背景透明度（0~1），默认 1（不透明） */
  backgroundAlpha?: number;
  /** 位置，默认 top-right */
  position?: CornerWatermarkPosition;
  /** 距边距（px，基于 1080p 高度），默认 24 */
  margin?: number;
  /** 旋转角度（度），默认 30 */
  rotation?: number;
  /** 样式模板，默认 ribbon */
  style?: CornerWatermarkStyle;
}

/** 新增花字样式模板：标准/高对比条/发光/3D描边/竖排 */
export type WordArtStyle = "standard" | "bar" | "glow" | "stroke3d" | "vertical";

/** 新增单条花字配置 */
export interface WordArtItem {
  /** 文案；支持 ${dramaTitle}、${index} 占位符 */
  text: string;
  /** 出现开始时间（秒），默认 0 */
  startSec?: number;
  /** 结束时间（秒），默认成片结束 */
  endSec?: number;
  /** 花字样式模板，默认 standard */
  style?: WordArtStyle;
  /** 字体名；留空用默认字体（抖音美好体） */
  fontName?: string;
  /** 字号（px，基于 1080p 高度），默认 64 */
  fontSize?: number;
  /** 主颜色，十六进制 #RRGGBB，默认 #FFD700 */
  color?: string;
  /** 描边颜色，默认 #000000 */
  outlineColor?: string;
  /** 描边宽度（px），默认 3 */
  outlineWidth?: number;
  /** 背景颜色，默认 #000000 */
  backgroundColor?: string;
  /** 背景透明度（0~1），默认 0；0 表示无背景 */
  backgroundAlpha?: number;
  /** 垂直位置：top / center / bottom，默认 top */
  position?: "top" | "center" | "bottom";
  /** 距顶/底边距（px，基于 1080p 高度），默认 60 */
  marginV?: number;
  /** 字符间距（px，仅 vertical 生效），默认 4 */
  charSpacing?: number;
  /** 发光颜色（仅 glow 生效），默认与描边同色 */
  glowColor?: string;
  /** 3D 阴影颜色（仅 stroke3d 生效），默认 #808080 */
  shadowColor?: string;
  /** 该条花字在整剧中出现的比例（0~1），默认 1（每部成片都出现） */
  appearanceRatio?: number;
}

/** 新增花字配置（与 titleCards、disclaimer 等并存，不改动现有功能） */
export interface WordArtConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 花字条目列表 */
  items?: WordArtItem[];
}

/** 贴花/花字模板类型 */
export type StickerTemplateType = "image" | "video";

/** 贴花/花字模板素材 */
export interface StickerTemplate {
  id: string;
  name: string;
  type: StickerTemplateType;
  file: string;
  categories?: string[];
  tags?: string[];
  defaultPosition?: StickerPosition;
  defaultScale?: number;
  durationSec?: number;
  loop?: boolean;
  textPlaceholder?: string | null;
  license?: string;
  licenseScope?: string;
}

/** 贴花在画面中的位置 */
export type StickerPosition =
  | "top-left"
  | "top"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

/** 贴花/花字模板清单（与 assets/stickers/stickers.json 对应） */
export interface StickerManifest {
  version: string;
  description?: string;
  categories?: Array<{ id: string; name: string; tags?: string[] }>;
  templates: StickerTemplate[];
}

/** 单条贴花/花字叠加配置 */
export interface StickerOverlay {
  /** 是否启用 */
  enabled?: boolean;
  /** 模板 ID 或本地文件路径；文件路径需存在 */
  templateId: string;
  /** 开始时间（秒），默认 0 */
  startSec?: number;
  /** 结束时间（秒），默认到模板 durationSec */
  endSec?: number;
  /** 位置 */
  position?: StickerPosition;
  /** 缩放比例（基于 1080p 高度），默认 1.0 */
  scale?: number;
  /** 水平偏移（px，基于 1080p 高度），默认 0 */
  offsetX?: number;
  /** 垂直偏移（px，基于 1080p 高度），默认 0 */
  offsetY?: number;
  /** 旋转角度（度），默认 0 */
  rotation?: number;
  /** 透明度（0~1），默认 1 */
  alpha?: number;
  /** 是否循环（覆盖模板默认），默认取模板 loop */
  loop?: boolean;
  /** 文字替换内容；当模板 textPlaceholder 不为空时生效 */
  text?: string;
  /** 匹配条件：仅在包含这些标签之一的片段/场景上叠加 */
  matchTags?: string[];
  /** 匹配条件：仅在包含这些高光类型的片段上叠加 */
  matchHighlightTypes?: AsrHighlightType[];
}

/** 贴花/花字模板系统配置 */
export interface StickerConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 手动指定的叠加列表 */
  overlays?: StickerOverlay[];
  /** 自动匹配模式：按场景/标签/高光自动选模板 */
  autoMatch?: {
    enabled?: boolean;
    /** 最多自动叠加条数 */
    maxOverlays?: number;
    /** 仅在指定高光类型片段上叠加 */
    matchHighlightTypes?: AsrHighlightType[];
    /** 默认模板 ID；无匹配时回退 */
    defaultTemplateId?: string;
  };
}

/** 免责声明应用模式 */
export type DisclaimerMode = "all" | "one_random" | "round_robin";

/** 免责声明/剧集提示条（全局统一叠在画面一侧，支持多行轮询） */
export interface DisclaimerConfig {
  /** 是否启用，默认 false */
  enabled?: boolean;
  /** 默认文案合集；单条 text 为空时按索引回退 */
  defaultLines?: string[];
  /** 应用模式：all=全部 lines 叠加，one_random=每成片只随机选一条，round_robin=按输出序号轮询（默认 one_random） */
  mode?: DisclaimerMode;
  /** 多行配置 */
  lines?: DisclaimerLineConfig[];
}

/** 火山云 TOS（S3 兼容）存储配置，由管理后台下发给 Agent 直传成片 */
export interface TosStorageConfig {
  enabled?: boolean;
  /** 节点地址，如 tos-s3-cn-beijing.volces.com */
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  accessSecret?: string;
  /** plain | base64；管理后台存 base64 时使用 */
  accessSecretEncoding?: "plain" | "base64";
  /** 对象键前缀（可选）；专辑目录为 {项目}-{专辑} */
  keyPrefix?: string;
  /** 成片公网 URL 前缀（可配置 CDN/自定义域名） */
  publicBaseUrl?: string;
  /** 服务端计算：传给 TosClient 的 endpoint；缺省则 SDK 按 region 自动推导 */
  uploadEndpoint?: string;
  /** 服务端计算：拼接公网 URL 的 host */
  publicHost?: string;
}

export interface StorageConfig {
  tos?: TosStorageConfig;
}

export interface RenderConfig {
  encode: RenderEncodeConfig;
  video?: {
    ratio?: string;
    width?: number;
    height?: number;
    cropMode?: string;
  };
  audio?: {
    codec?: string;
    bitrate?: string;
  };
  /** 跨集块拼接时的转场效果 */
  transition?: RenderTransitionConfig;
  /** 字幕烧录样式 */
  subtitleStyle?: SubtitleStyleConfig;
  /** 背景音乐 */
  bgm?: BgmConfig;
  /** 标题花字列表 */
  titleCards?: TitleCardConfig[];
  /** 免责声明/剧集提示条配置 */
  disclaimer?: DisclaimerConfig;
  /** 右上角角标配置（兼容旧版单条） */
  cornerWatermark?: CornerWatermarkConfig;
  /** 多角标配置（优先使用）；为空时回退到 cornerWatermark */
  cornerWatermarks?: CornerWatermarkConfig[];
  /** 新增花字配置（不改动现有 titleCards/disclaimer 等功能） */
  wordArt?: WordArtConfig;
  /** 贴花/花字模板系统配置（与现有功能并存） */
  stickers?: StickerConfig;
  /** 成片上传目标（TOS 等），credentials 随 EffectiveConfig 下发给 Agent */
  storage?: StorageConfig;
  limits?: {
    /** Agent 同时处理的剪辑任务数（daemon 级，预留） */
    maxParallelTasks?: number;
    maxDurationSec?: number;
    /** 单任务内 FFmpeg 同时渲染的成片数（4060 建议 2～3） */
    maxConcurrentRenders?: number;
    /** 单任务内同时上传的成片数（可与 FFmpeg 并行，建议 2～3） */
    maxConcurrentUploads?: number;
    /** 混剪时下一轮方案与当轮 FFmpeg 并行（预取） */
    llmRenderPipeline?: boolean;
    /** 渲染完成后是否上传到服务端/OSS；false 时成片保留在 Agent 本地 workspace */
    uploadAfterRender?: boolean;
    /** 不上传时成片保存目录（如 D:/ClipOutput）；留空则 Windows 默认 D:\\ClipOutput */
    localOutputDir?: string;
  };
  workspaceMaxGb?: number;
}

/** 服务端下发的客户端开关：控制该设备是否可以领取剪辑任务 */
export interface AgentServicesConfig {
  /** 关闭后该设备不再领取任务 */
  agentEnabled?: boolean;
  /**
   * 任务队列分工：all=全部（默认），mix=混剪/短剧剪辑，replica=案例复刻。
   * 用于把案例复刻与短剧剪辑任务分发到不同服务器组。
   */
  taskQueue?: "all" | "mix" | "replica";
  /**
   * 资源策略（按时段限流/满载）。
   * 设备覆盖写入 null 表示清除覆盖、继承全局。
   */
  resourcePolicy?: ResourcePolicyConfig | null;
}

export type ResolvedAgentServices = {
  agentEnabled: boolean;
  taskQueue: "all" | "mix" | "replica";
  resourcePolicy: ReturnType<typeof resolveResourcePolicy>;
};

export const DEFAULT_AGENT_SERVICES: ResolvedAgentServices = {
  agentEnabled: true,
  taskQueue: "all",
  resourcePolicy: DEFAULT_RESOURCE_POLICY,
};

/** 归一化 taskQueue：非法值回落 all */
export function normalizeAgentTaskQueue(value: unknown): "all" | "mix" | "replica" {
  return value === "mix" || value === "replica" ? value : "all";
}

/** 剧名规范化，用于压缩包文件名 */
export function sanitizeDramaPackageTitle(title: string): string {
  const trimmed = title.trim().replace(/\.(zip|rar|7z)$/i, "");
  const safe = trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "");
  return safe.slice(0, 80) || "drama";
}

/** TOS 对象键路径段清洗（项目名/专辑名） */
export function sanitizeStoragePathPart(value: string, maxLen = 60): string {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")
    .replace(/\s+/g, "");
  return safe.slice(0, maxLen) || "unknown";
}

/** 成片文件名各段清洗（不含分隔符 -） */
export function sanitizeAutoclipFilenamePart(value: string, maxLen = 40): string {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f_.\-]+/g, "")
    .replace(/\s+/g, "");
  return safe.slice(0, maxLen) || "drama";
}

/** 年月日时分秒，如 20250622143055 */
export function formatAutoclipTimestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** 客户端剪辑成片命名：{剧名}-{批次}-{剪辑数量}-{年月日时分秒}-autoclip.mp4；剪辑数量=本批次第几条成片 */
export function formatAutoclipOutputFilename(input: {
  dramaTitle: string;
  batch: number;
  /** 本批次第几条成片（从 1 起） */
  outputSeqInBatch: number;
  now?: Date;
}): string {
  const title = sanitizeAutoclipFilenamePart(input.dramaTitle);
  const batch = String(Math.max(1, input.batch)).padStart(2, "0");
  const outputSeq = String(Math.max(1, input.outputSeqInBatch));
  const ts = formatAutoclipTimestamp(input.now);
  return `${title}-${batch}-${outputSeq}-${ts}-autoclip.mp4`;
}

/** Agent 剪辑成片文件名匹配（含旧版下划线命名与 output-r01-p01.mp4） */
export const AUTOCLIP_OUTPUT_FILE_RE =
  /^(?:[^/\\]+-\d+-\d+-\d{14}-autoclip|[^/\\]+_\d+_\d+_\d{14}_autoclip|output(?:-r\d+-p\d+)?)\.mp4$/i;

export function formatDramaPackageName(title: string, dedupSeq: number): string {
  return `${sanitizeDramaPackageTitle(title)}-${String(dedupSeq).padStart(3, "0")}.zip`;
}

export function resolveAgentServices(
  global?: AgentServicesConfig,
  override?: AgentServicesConfig,
): ResolvedAgentServices {
  return {
    agentEnabled: override?.agentEnabled ?? global?.agentEnabled ?? true,
    taskQueue: normalizeAgentTaskQueue(override?.taskQueue ?? global?.taskQueue),
    resourcePolicy: mergeResourcePolicy(
      global?.resourcePolicy ?? undefined,
      override && "resourcePolicy" in override ? override.resourcePolicy : undefined,
    ),
  };
}

export interface EffectiveConfig {
  configVersion: string;
  profile: string;
  asr: AsrConfig;
  render: RenderConfig;
  /** 本地混剪策略参数（保留字段名以兼容旧配置） */
  llm?: LlmPublicConfig;
  /** 设备开关（设备 override，缺省为启用） */
  services?: ResolvedAgentServices;
}

export interface ClipPlanClip {
  segmentId: string;
  /** 与同集合连续块：从 segmentId 合并到 throughSegmentId（含），渲染为一刀 */
  throughSegmentId?: string;
  reason?: string;
  /** 片段在广告叙事中的职责：hook/context/escalate/cliff/cta */
  role?: "hook" | "context" | "escalate" | "cliff" | "cta";
  /** 跨集混剪时片段来源集 */
  episodeId?: string;
  trimStartMs?: number;
  trimEndMs?: number;
}

export type ClipPlanDurationTier = "S" | "M" | "L" | "XL";

/** 同源的备选投放方案（不同策略/时长档） */
export interface ClipPlanAlternative {
  strategy?: string;
  durationTier?: ClipPlanDurationTier;
  targetDurationSec?: number;
  estimatedDurationSec?: number;
  narrativeLine?: string;
  confidence?: number;
  clips: ClipPlanClip[];
  output: ClipPlanOutput;
}

export interface ClipPlanOutput {
  ratio?: string;
  maxDurationSec?: number;
  addHead?: boolean;
  addTail?: boolean;
  subtitle?: boolean;
}

export interface ClipPlan {
  version: string;
  clips: ClipPlanClip[];
  output: ClipPlanOutput;
  /** 投放策略，如 suspense_hook / conflict_burst */
  strategy?: string;
  /** 时长档位：S(120-300s) M(301-600s) L(601-900s) XL(901-1200s) */
  durationTier?: ClipPlanDurationTier;
  targetDurationSec?: number;
  estimatedDurationSec?: number;
  /** 一句话说明本片叙事线 */
  narrativeLine?: string;
  confidence?: number;
  /** 刻意未选用的片段及原因 */
  avoidReasons?: string[];
  /** 备选方案，供投放 A/B 测试 */
  alternatives?: ClipPlanAlternative[];
  /** --- 智能选段扩展 --- */
  genreProfile?: GenreProfile;
  audienceChannel?: AudienceChannel;
  editForm?: EditForm;
  plotThread?: string;
  targetDurationLabel?: TargetDurationLabel;
  hookType?: string;
  cliffType?: string;
  hookSegmentId?: string;
  introReason?: string;
  outroReason?: string;
  /** 建置一句话：路人听懂「谁因何起冲突」（投放可验收） */
  setupClaim?: string;
  /** 中段推进一句话：相对开篇局面推进了什么 */
  advanceClaim?: string;
  /** 片尾未解一句话：欠观众什么、如何回扣前文 */
  openLoopClaim?: string;
  beatSequence?: string[];
  durationStatus?: DurationStatus;
  durationNote?: string;
  /** skills 模式：与简介对齐说明 */
  synopsisAlignment?: string;
  /** skills 模式：生成时写入的质量评估 */
  skillsQuality?: SkillsPlanQuality;
  /** 原始 through 块（展开前，供案例库注入） */
  llmSourceClips?: ClipPlanClip[];
}

/** Skills 进化案例状态 */
export type SkillLearnedCaseStatus = "candidate" | "approved" | "pinned" | "rejected";

/** manifest.injectLearned 配置 */
export interface SkillInjectLearnedConfig {
  /** Prompt 注入时最多参考几条（仅 approved/pinned）；与案例库展示无关 */
  maxCases: number;
  /** 混剪完成后是否自动采集入库，默认 true */
  collectEnabled?: boolean;
  /** 出片案例自动 approved 并参与 Prompt 注入，无需人工审核，默认 true */
  autoApproveForInjection?: boolean;
  /** 入库最低分（达线 → candidate；未达线不采集） */
  minScore: number;
  /** 自动 approved 门槛（≥ 此分且开启 autoApprove → approved；介于 minScore 与此之间 → candidate） */
  autoApproveMinScore?: number;
  /** 同剧案例优先注入（投放钩子可复用同剧高分结构） */
  preferSameDrama?: boolean;
  /** 同题材案例优先（次于同剧） */
  preferSameGenre?: boolean;
  maxCaseChars?: number;
  /** 注入排序时投放 CTR 权重（0~1，与完播率互补） */
  performanceCtrWeight?: number;
}

/** 案例投放效果（人工或投放 API 回写） */
export interface SkillLearnedAdPerformance {
  impressions?: number;
  clicks?: number;
  ctr?: number;
  completionRate?: number;
  spend?: number;
  note?: string;
  updatedAt: string;
}

/** Skills 进化参考案例 */
export interface SkillLearnedCase {
  caseId: string;
  status: SkillLearnedCaseStatus;
  sourceTaskId: string;
  sourceRound: number;
  sourcePlanIndex: number;
  sourceDramaId?: string;
  dramaTitle?: string;
  skillVersion: string;
  targetDurationLabel: TargetDurationLabel;
  editForm?: EditForm;
  genreProfile?: GenreProfile;
  episodeCount: number;
  qualityScore: number;
  qualityGrade: SkillsPlanQuality["grade"];
  quality: SkillsPlanQuality;
  narrativeLine?: string;
  synopsisAlignment?: string;
  introReason?: string;
  outroReason?: string;
  hookType?: string;
  clips: ClipPlanClip[];
  adPerformance?: SkillLearnedAdPerformance;
  injectCount: number;
  lastInjectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillLearnedCaseListResult {
  items: SkillLearnedCase[];
  total: number;
  limit: number;
  offset: number;
  /** 当前筛选条件下的各状态数量 */
  statusCounts?: Record<string, number>;
}

/** SKILL / learned-patterns 进化草稿导出 */
export interface SkillLearnedExportResult {
  markdown: string;
  caseCount: number;
  skillVersion: string;
  generatedAt: string;
}

/** 案例蒸馏写入 learned-patterns.md 的结果 */
export interface SkillLearnedDistillResult {
  markdown: string;
  promptSection: string;
  caseCount: number;
  skillVersion: string;
  generatedAt: string;
  writtenPath: string;
}

/** skills 单条方案质量评估 */
export interface SkillsPlanQuality {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  closingAtEpisodeEnd: boolean;
  openingNearEpisodeStart: boolean;
  hasOutroReason: boolean;
  hasIntroReason: boolean;
  hasSynopsisAlignment: boolean;
  hasSetupClaim?: boolean;
  hasAdvanceClaim?: boolean;
  hasOpenLoopClaim?: boolean;
  estimatedDurationSec: number;
  targetDurationSec?: number;
  clipCount: number;
  episodeCount: number;
  durationStatus?: DurationStatus;
  targetDurationLabel?: TargetDurationLabel;
  openingEpisodeId?: string;
  openingSegmentId?: string;
  closingEpisodeId?: string;
  closingSegmentId?: string;
  episodeLastSegmentId?: string;
  issues: string[];
  warnings: string[];
  mechanicalRepairs?: string[];
}

/** 任务级 skills 方案质量报告 */
export interface SkillsPlanQualityReport {
  clipSelectionMode: string;
  skillVersion?: string;
  segmentCount: number;
  totalPlans: number;
  passCount: number;
  avgScore: number;
  /** 当前请求的任务 id */
  requestedTaskId?: string;
  /** 实际读取 planBatches 的任务 id（剧包页可能解析到子混剪任务） */
  sourceTaskId?: string;
  sourceTaskKind?: ClipTaskKind;
  rounds: Array<{
    round: number;
    totalRounds: number;
    skillVersion?: string;
    plans: Array<{
      planIndex: number;
      strategy?: string;
      narrativeLine?: string;
      editForm?: EditForm;
      targetDurationLabel?: TargetDurationLabel;
      quality: SkillsPlanQuality;
    }>;
  }>;
  commonIssues: Array<{ issue: string; count: number }>;
}

/** 一轮选段返回的多条成片方案 */
export interface ClipPlanBatch {
  version: "2.0";
  round: number;
  totalRounds: number;
  plansPerRound: number;
  plans: ClipPlan[];
  /** skills 批次元数据 */
  skillVersion?: string;
  clipSelectionMode?: ClipSelectionMode;
}

/** 跨集混剪单条成片记录 */
export interface MixRenderRecord {
  round: number;
  planIndex: number;
  outputUrl: string;
  strategy?: string;
  durationTier?: ClipPlanDurationTier;
  narrativeLine?: string;
  /** 未上传时 Agent 本地 mp4 绝对路径 */
  localOutputPath?: string;
  /** 是否已上传到服务端/OSS */
  uploaded?: boolean;
  /** 智能选段元数据（与 ClipPlan 对齐） */
  editForm?: EditForm;
  genreProfile?: GenreProfile;
  targetDurationLabel?: TargetDurationLabel;
  durationStatus?: DurationStatus;
  hookType?: string;
  cliffType?: string;
  /** 成片真实时长（ffprobe），入库以此为准 */
  durationSec?: number;
  /** @deprecated 兼容旧字段；新写入与 durationSec 同为真实时长 */
  estimatedDurationSec?: number;
  /** 成片视频基本数据：宽/高/时长/文件字节数 */
  videoInfo?: VideoBasicInfo;
  /** 成片文件大小（字节），冗余便于上传和入库 */
  fileSizeBytes?: number;
  /** 本轮内方案序号（1..plansPerRound），与 planBatches 对齐 */
  planSeqInRound?: number;
  /** skills 剪辑质量评估 */
  skillsQuality?: SkillsPlanQuality;
}

/** 视频基本数据（宽/高/时长/文件大小），上传与入库通用 */
export interface VideoBasicInfo {
  width?: number;
  height?: number;
  durationSec?: number;
  fileSizeBytes?: number;
}

/** 渲染完成后是否上传（默认 false：暂存 Agent 本地） */
export function shouldUploadAfterRender(config: { render?: RenderConfig }): boolean {
  return config.render?.limits?.uploadAfterRender === true;
}

export function getTosStorageConfig(config: { render?: RenderConfig }): TosStorageConfig | undefined {
  return config.render?.storage?.tos;
}

/** 渲染后直传火山云 TOS（需开启 uploadAfterRender 且 TOS 配置完整） */
export function shouldUploadToTos(config: { render?: RenderConfig }): boolean {
  const tos = config.render?.storage?.tos;
  if (!shouldUploadAfterRender(config) || tos?.enabled !== true) return false;
  return Boolean(tos.bucket?.trim() && tos.accessKey?.trim() && tos.accessSecret?.trim());
}

export type UploadDestination = "local" | "tos";

/** 解析成片上传目标：tos=Agent 直传火山云；TOS 未配置或未启用时保留本地不上传 */
export function resolveUploadDestination(config: { render?: RenderConfig }): UploadDestination {
  return shouldUploadToTos(config) ? "tos" : "local";
}

export function formatLocalOutputUrl(localPath: string): string {
  return `local:${localPath}`;
}

export function isLocalOutputUrl(url?: string | null): boolean {
  return typeof url === "string" && url.startsWith("local:");
}

export type ClipTaskKind = "single" | "episode_asr" | "drama_mix" | "drama_package" | "output_asr" | "remix_replica";

export type DramaPackagePhase =
  | "pending"
  | "downloading"
  | "extracting"
  | "asr_episodes"
  | "mixing"
  | "uploading"
  | "cleaning"
  | "completed"
  | "failed";

export interface DramaPackageMeta {
  title: string;
  dedupSeq: number;
  packageObjectKey: string;
  packageName: string;
  expectedEpisodeCount?: number;
  phase?: DramaPackagePhase;
  episodeCount?: number;
}

export interface DramaEpisodeRecord {
  episodeId: string;
  dramaId: string;
  episodeNo: number;
  title?: string;
  sourceUrl: string;
  status: "pending_asr" | "asr_done" | "failed";
  taskId?: string;
  segments?: AsrSegment[];
  rawSegmentCount?: number;
  subtitleUrl?: string;
  subtitlesJsonUrl?: string;
  failMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DramaEpisodeSource {
  episodeId: string;
  episodeNo: number;
  sourceUrl: string;
}

export interface ClipTask {
  taskId: string;
  templateId: string;
  asrRuleSetId?: string;
  configVersion?: string;
  sourceUrl: string;
  dramaId?: string;
  dramaMeta?: Record<string, unknown>;
  /** single=单集直剪；episode_asr=仅识别入库；drama_mix=跨集混剪；drama_package=剧级 zip 批次；output_asr=成片仅 ASR */
  taskKind?: ClipTaskKind;
  /** 剧级 zip 包元数据（taskKind=drama_package） */
  dramaPackage?: DramaPackageMeta;
  packageUrl?: string;
  episodeNo?: number;
  episodeId?: string;
  /** drama_mix 任务包含的集 */
  mixEpisodeIds?: string[];
  mixEpisodes?: DramaEpisodeSource[];
  /** 父剧包任务 ID，用于 episode_asr / drama_mix 等子任务回退下载 */
  parentPackageTaskId?: string;
  status: "pending" | "claimed" | "processing" | "completed" | "failed";
  claimedBy?: string;
  /** 任务被 Agent 领取的时间（ISO 字符串） */
  claimedAt?: string;
  outputUrl?: string;
  /** 多成片输出（混剪批次） */
  outputUrls?: string[];
  mixRenders?: MixRenderRecord[];
  failMessage?: string;
  subtitleUrl?: string;
  subtitlesJsonUrl?: string;
  /** 识别开始时间（ISO） */
  processingStartedAt?: string;
  /** 剪辑完成时间（ISO） */
  processingCompletedAt?: string;
  /** 识别→剪辑完成总耗时（秒） */
  totalWallTimeSec?: number;
  createdAt?: string;
  updatedAt?: string;
}

export function resolveClipDramaTitle(
  task: Pick<ClipTask, "dramaId" | "dramaMeta" | "dramaPackage">,
): string {
  if (task.dramaPackage?.title?.trim()) return task.dramaPackage.title.trim();
  const meta = task.dramaMeta;
  if (typeof meta?.title === "string" && meta.title.trim()) return meta.title.trim();
  if (typeof meta?.dramaTitle === "string" && meta.dramaTitle.trim()) return meta.dramaTitle.trim();
  return task.dramaId?.trim() || "drama";
}

/** 成片文件名中的批次号：混剪轮次（第 1 批 → 01，第 2 批 → 02） */
export function resolveClipBatchNo(round = 1): number {
  return Math.max(1, round);
}

export interface ClipTaskDetail extends ClipTask {
  segments?: AsrSegment[];
  rawSegments?: RawAsrSegment[];
  plan?: ClipPlan;
  planBatches?: ClipPlanBatch[];
  rawSegmentCount?: number;
  finalSegmentCount?: number;
}

/** ASR 识别结果摘要（列表查询，不含全量 segments） */
export interface AsrResultSummary {
  taskId: string;
  dramaId?: string;
  episodeId?: string;
  episodeNo?: number;
  taskKind?: ClipTaskKind;
  asrRuleSetId?: string;
  ruleSetVersion?: string;
  deviceId?: string;
  sourceUrl?: string;
  rawSegmentCount?: number;
  finalSegmentCount: number;
  subtitleUrl?: string;
  subtitlesJsonUrl?: string;
  /** 全部识别文本拼接（便于检索预览） */
  fullText?: string;
  savedAt: string;
  updatedAt: string;
}

/** ASR 识别结果完整记录（对应 clip_asr_result） */
export interface AsrResultRecord extends AsrResultSummary {
  segments: AsrSegment[];
  rawSegments?: RawAsrSegment[];
}

export interface DeviceInfo {
  deviceId: string;
  machineId: string;
  gpuName: string;
  vramMb: number;
  os: string;
  agentVersion: string;
  lastSeenAt: string;
  online: boolean;
  boundUser?: string;
  /** 设备任务开关 */
  services?: ResolvedAgentServices;
  /** 是否存在设备级 resourcePolicy 覆盖（false/缺省=跟随全局） */
  resourcePolicyOverride?: boolean;
}

/** 剧目扩展元数据（入库手工维护，供选段参考） */
export interface DramaMeta {
  title?: string;
  dramaTitle?: string;
  synopsis?: string;
  synopsisSource?: "manual";
  /** 叙事画像（高光词表分型）；可手填，缺省由简介推断 */
  genreProfile?: GenreProfile;
  genreTags?: string[];
  plotThreads?: string[];
  mainCharacters?: Array<{ name: string; role?: string }>;
  hookSellingPoints?: string[];
  cliffTaboos?: string[];
  episodeCount?: number;
  episodes?: Array<{
    episodeId: string;
    episodeNo: number;
    segmentCount?: number;
    durationSec?: number;
  }>;
  packageName?: string;
  /** 运营清单类型：漫剧/短剧/付费漫剧/付费短剧（来自 clip_drama_intake.drama_type） */
  dramaType?: DramaIntakeType;
}

/** 短剧待入库清单状态（运营侧进度跟踪） */
export type DramaIntakeStatus =
  | "pending"
  | "read"
  | "downloaded"
  | "uploaded"
  | "queued"
  | "ingesting"
  | "ingested"
  | "failed"
  | "skipped";

/** 短剧类型 */
export type DramaIntakeType = "comic" | "short" | "paid_comic" | "paid_short";

export const DRAMA_INTAKE_TYPE_LABELS: Record<DramaIntakeType, string> = {
  comic: "漫剧",
  short: "短剧",
  paid_comic: "付费漫剧",
  paid_short: "付费短剧",
};

/** 解析短剧类型（支持中文标签或枚举值） */
export function normalizeDramaIntakeType(raw?: string | null): DramaIntakeType | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const aliases: Record<string, DramaIntakeType> = {
    comic: "comic",
    short: "short",
    paid_comic: "paid_comic",
    paid_short: "paid_short",
    漫剧: "comic",
    短剧: "short",
    付费漫剧: "paid_comic",
    付费短剧: "paid_short",
  };
  return aliases[value] ?? aliases[value.toLowerCase()];
}

/** 短剧待入库清单条目 */
export interface DramaIntakeRecord {
  intakeId: string;
  /** 来源平台短剧 ID */
  externalDramaId: string;
  title: string;
  /** 短剧类型：漫剧 / 短剧 / 付费漫剧 / 付费短剧 */
  dramaType: DramaIntakeType;
  status: DramaIntakeStatus;
  /** 短剧简介（填写后表示已进入已下载流程） */
  synopsis?: string;
  note?: string;
  /** 关联的 drama_package 任务 ID */
  linkedTaskId?: string;
  /** 入库完成后的内部 drama_id */
  linkedDramaId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 短剧热度排行榜条目 */
export interface DramaRankingRecord {
  rankingId: string;
  /** 当前页内计算出的名次（从 1 开始，受 offset 影响） */
  rank?: number;
  title: string;
  /** 题材标签展示，如「甜宠」或「-」 */
  genreTags: string;
  episodeCount: number;
  /** 剧场号 */
  theaterName: string;
  /** 承制方 */
  producer: string;
  /** 播放增量展示，如 4.4w */
  playDeltaDisplay: string;
  /** 播放增量数值 */
  playDelta: number;
  /** 播放总量展示，如 431.2w */
  playTotalDisplay: string;
  /** 播放总量数值（主排序字段） */
  playTotal: number;
  /** 上线时间 YYYY-MM-DD */
  onlineAt?: string;
  externalDramaId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 解析播放量展示值（支持纯数字 / 4.4w / 4.4万 / 1.2亿）。
 * 写入排行榜时保留展示串，同时换算数值便于排序。
 */
export function parsePlayCountDisplay(raw?: string | number | null): {
  display: string;
  value: number;
} {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const value = Math.max(0, Math.floor(raw));
    return { display: String(value), value };
  }
  const display = String(raw ?? "").trim();
  if (!display || display === "-") {
    return { display: display || "", value: 0 };
  }
  const normalized = display.replace(/,/g, "").replace(/\s+/g, "").toLowerCase();
  const matched = normalized.match(/^(-?\d+(?:\.\d+)?)(万|w|亿|e)?$/i);
  if (!matched) {
    const digits = Number(normalized);
    if (Number.isFinite(digits)) {
      return { display, value: Math.max(0, Math.floor(digits)) };
    }
    return { display, value: 0 };
  }
  const num = Number(matched[1]);
  if (!Number.isFinite(num)) return { display, value: 0 };
  const unit = (matched[2] || "").toLowerCase();
  let multiplier = 1;
  if (unit === "万" || unit === "w") multiplier = 10_000;
  else if (unit === "亿" || unit === "e") multiplier = 100_000_000;
  return { display, value: Math.max(0, Math.floor(num * multiplier)) };
}

/** 热度排行写入入参：rankingId + 原始表格字符串（接口内解析） */
export interface DramaRankingUpdateInput {
  rankingId: string;
  /**
   * 调用方原样粘贴的表格文本，格式固定如下（含表头与换行/Tab，勿自行改排）：
   *
   * 排行
   * \t剧名\t题材标签\t集数\t剧场号\t承制方\t播放增量\t播放总量\t
   * 上线时间
   *
   * 《书韵良缘》
   * \t-
   * 57
   *
   * 辣鱼皮皮
   * \t-\t4.4w\t431.2w\t2026-06-30
   */
  text: string;
}

/** 从原始表格文本解析出的热度字段 */
export interface DramaRankingParsedFields {
  title: string;
  genreTags: string;
  episodeCount: number;
  theaterName: string;
  producer: string;
  playDelta: string;
  playTotal: string;
  onlineAt: string;
}

/**
 * 解析调用方原样粘贴的热度表格文本（表头 + 换行/Tab 分隔）。
 * 不依赖固定下标（避免承制方/剧场号错位进「集数」），按形态识别：
 * 上线日期、播放量(含 w/万)、集数(纯数字)、剧名(《》优先)、其余为题材/剧场/承制方。
 */
export function parseDramaRankingRawText(raw: string): DramaRankingParsedFields {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("text required");
  }

  const parts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(排行|上线时间)$/.test(line) && !/题材标签/.test(line))
    .flatMap((line) => line.split(/\t+/))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 4) {
    throw new Error(`无法解析热度文本，字段过少（实际 ${parts.length} 个）`);
  }

  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  // 播放量：4.4w / 431.2万 / 纯数字（可带小数）
  const isPlayCount = (s: string) => /^-?\d+(\.\d+)?(万|w|亿|e)?$/i.test(s.replace(/,/g, ""));
  // 集数：1~9999 的整数（不含单位）；排除明显过大的播放量整数可再靠位置约束
  const isEpisode = (s: string) => /^\d{1,4}$/.test(s) && Number(s) >= 1 && Number(s) <= 9999;
  const looksLikeProducer = (s: string) =>
    /公司|文化|传媒|影业|工作室|经营|日用品|有限|集团|工作室部|工作室厂/.test(s) ||
    (/[县市区]/.test(s) && s.length >= 6);
  const used = new Set<number>();

  // 1) 上线时间：自右向左找日期
  let onlineAt = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isDate(parts[i]!)) {
      onlineAt = parts[i]!;
      used.add(i);
      break;
    }
  }
  if (!onlineAt) {
    throw new Error("上线时间无效，未找到 YYYY-MM-DD");
  }

  // 2) 播放总量、播放增量：日期左侧连续两个播放量形态
  let playTotal = "";
  let playDelta = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    if (used.has(i)) continue;
    if (!isPlayCount(parts[i]!) || isDate(parts[i]!)) continue;
    // 纯 1~9999 整数更可能是集数，留给后面；带单位或带小数的优先当播放量
    const p = parts[i]!;
    const hasUnit = /万|w|亿|e/i.test(p);
    const hasDot = p.includes(".");
    if (!hasUnit && !hasDot && isEpisode(p)) continue;
    if (!playTotal) {
      playTotal = p;
      used.add(i);
    } else if (!playDelta) {
      playDelta = p;
      used.add(i);
      break;
    }
  }
  // 若只识别到一个播放量，再放宽：允许纯整数当播放量（靠后的）
  if (!playTotal || !playDelta) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (used.has(i)) continue;
      if (!isPlayCount(parts[i]!)) continue;
      if (!playTotal) {
        playTotal = parts[i]!;
        used.add(i);
      } else if (!playDelta) {
        playDelta = parts[i]!;
        used.add(i);
        break;
      }
    }
  }
  if (!playTotal) playTotal = "0";
  if (!playDelta) playDelta = "0";

  // 3) 集数：剩余 token 里找纯数字集数（排除已占用）
  let episodeCount = 0;
  let episodeIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue;
    if (!isEpisode(parts[i]!)) continue;
    episodeIdx = i;
    episodeCount = Number(parts[i]);
    used.add(i);
    break;
  }
  if (episodeIdx < 0) {
    throw new Error(`集数无效: 未找到 1~9999 的集数数字（原始片段: ${parts.join(" | ")}）`);
  }

  // 4) 剧名：带书名号优先，否则取第一个未占用且不像「-」的
  let title = "";
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue;
    if (/《.+》/.test(parts[i]!)) {
      title = parts[i]!;
      used.add(i);
      break;
    }
  }
  if (!title) {
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i)) continue;
      if (parts[i] === "-" || isPlayCount(parts[i]!) || isDate(parts[i]!)) continue;
      // 跳过纯排行名次
      if (/^\d{1,4}$/.test(parts[i]!)) continue;
      title = parts[i]!;
      used.add(i);
      break;
    }
  }
  if (!title) {
    throw new Error("剧名不能为空");
  }

  // 5) 剩余：题材 / 剧场号 / 承制方
  const rest: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue;
    rest.push(parts[i]!);
  }

  let genreTags = "-";
  let theaterName = "";
  let producer = "-";

  if (rest.length === 1) {
    const only = rest[0]!;
    if (only === "-" || only.length <= 6) genreTags = only;
    else if (looksLikeProducer(only)) producer = only;
    else theaterName = only;
  } else if (rest.length === 2) {
    // 常见：题材 + 剧场，或 剧场 + 承制方
    if (rest[0] === "-" || rest[0]!.length <= 4) {
      genreTags = rest[0]!;
      if (looksLikeProducer(rest[1]!)) producer = rest[1]!;
      else theaterName = rest[1]!;
    } else if (looksLikeProducer(rest[1]!)) {
      theaterName = rest[0]!;
      producer = rest[1]!;
    } else {
      genreTags = rest[0]!;
      theaterName = rest[1]!;
    }
  } else if (rest.length >= 3) {
    genreTags = rest[0] || "-";
    const mid = rest.slice(1).filter((s) => s && s !== "-");
    const prodIdx = mid.findIndex((s) => looksLikeProducer(s));
    if (prodIdx >= 0) {
      producer = mid[prodIdx]!;
      theaterName = mid.filter((_, i) => i !== prodIdx).join("") || "";
    } else if (mid.length >= 2) {
      theaterName = mid[0] || "";
      producer = mid.slice(1).join("") || "-";
    } else {
      theaterName = mid[0] || "";
      producer = "-";
    }
  }

  return {
    title: title.trim(),
    genreTags: (genreTags || "-").trim(),
    episodeCount: Math.max(0, Math.floor(episodeCount)),
    theaterName: theaterName.trim(),
    producer: (producer || "-").trim(),
    playDelta: playDelta.trim(),
    playTotal: playTotal.trim(),
    onlineAt,
  };
}

/** 当天录入、待爬虫补全热度的剧名 */
export interface DramaRankingPendingItem {
  rankingId: string;
  title: string;
  theaterName: string;
  externalDramaId?: string;
  createdAt: string;
}

/** 批量录入剧名结果（热度排行占位行） */
export interface DramaRankingBatchTitlesResult {
  created: DramaRankingRecord[];
  /** 同批重复或库内已存在的剧名 */
  duplicates: string[];
}

export interface DramaInfo {
  dramaId: string;
  title: string;
  asrRuleSetId: string;
  meta?: DramaMeta;
}

export function normalizeDramaMeta(raw?: Record<string, unknown> | DramaMeta | null): DramaMeta {
  if (!raw || typeof raw !== "object") return {};
  const meta = raw as DramaMeta;
  return {
    title: typeof meta.title === "string" ? meta.title : undefined,
    dramaTitle: typeof meta.dramaTitle === "string" ? meta.dramaTitle : undefined,
    synopsis: typeof meta.synopsis === "string" ? meta.synopsis.trim() : undefined,
    synopsisSource: meta.synopsisSource === "manual" ? "manual" : undefined,
    genreProfile: isGenreProfile(meta.genreProfile) ? meta.genreProfile : undefined,
    genreTags: Array.isArray(meta.genreTags)
      ? meta.genreTags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined,
    plotThreads: Array.isArray(meta.plotThreads)
      ? meta.plotThreads.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined,
    mainCharacters: Array.isArray(meta.mainCharacters)
      ? meta.mainCharacters.filter(
          (c): c is { name: string; role?: string } =>
            Boolean(c && typeof c === "object" && typeof (c as { name?: string }).name === "string"),
        )
      : undefined,
    hookSellingPoints: Array.isArray(meta.hookSellingPoints)
      ? meta.hookSellingPoints.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined,
    cliffTaboos: Array.isArray(meta.cliffTaboos)
      ? meta.cliffTaboos.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : undefined,
    episodeCount: typeof meta.episodeCount === "number" ? meta.episodeCount : undefined,
    episodes: Array.isArray(meta.episodes) ? meta.episodes : undefined,
    packageName: typeof meta.packageName === "string" ? meta.packageName : undefined,
    dramaType: normalizeDramaIntakeType(
      typeof (meta as { dramaType?: unknown }).dramaType === "string"
        ? String((meta as { dramaType?: unknown }).dramaType)
        : undefined,
    ),
  };
}

export function dramaInfoToTaskMeta(drama: DramaInfo, extra: DramaMeta = {}): DramaMeta {
  return normalizeDramaMeta({
    title: drama.title,
    ...drama.meta,
    ...extra,
  });
}

export interface AgentUpdateManifest {
  version: string;
  platform: string;
  downloadUrl: string;
  sha256: string;
  mandatory: boolean;
  releaseNotes?: string;
}

/** 心跳返回的 Agent 热更新信息 */
export interface AgentUpdateInfo {
  available: boolean;
  version?: string;
  downloadUrl?: string;
  sha256?: string;
  mandatory?: boolean;
  releaseNotes?: string;
  /** 增量包下载 URL（可选） */
  incrementalUrl?: string;
  /** 增量包 sha256 */
  incrementalSha256?: string;
}

export interface AgentHeartbeatResponse {
  configVersion: string;
  ruleSetVersion: string;
  updateAvailable: boolean;
  agentUpdate?: AgentUpdateInfo;
  services: ResolvedAgentServices;
}

export interface ModelManifestEntry {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface ModelManifest {
  version: string;
  provider?: string;
  platform?: string;
  models: ModelManifestEntry[];
}

export interface DeviceRegisterRequest {
  machineId: string;
  gpuName: string;
  vramMb: number;
  os: string;
  agentVersion: string;
}

export interface DeviceRegisterResponse {
  deviceId: string;
  deviceToken: string;
}

export interface TelemetryEvent {
  type: string;
  at?: string;
  metrics: Record<string, unknown>;
}

export interface TelemetryBatch {
  deviceId: string;
  taskId: string;
  configVersion: string;
  asrRuleSetId?: string;
  asrRuleSetVersion?: string;
  events: TelemetryEvent[];
}

export interface RuleEngineStats {
  rawCount: number;
  finalCount: number;
  filteredCount: number;
}

export { formatDurationSec } from "./format-duration.js";
export { CLIP_DEFAULT_API_BASE, CLIP_AGENT_VERSION } from "./constants.js";
export {
  compareAgentVersion,
  isAgentVersionNewer,
  parseAgentVersion,
  AGENT_HOTFIX_VERSION_FILE,
  AGENT_HOTFIX_INSTALL_PATHS,
  AGENT_HOTFIX_STAGING_PAIRS,
  AGENT_HOTFIX_MIN_ZIP_BYTES,
  AGENT_INCREMENTAL_MANIFEST_FILE,
  AGENT_HOTFIX_APPLY_MODES,
  detectHotfixApplyMode,
  type AgentHotfixVersionFile,
  type AgentIncrementalManifest,
  type AgentHotfixApplyMode,
} from "./agent-version.js";
export {
  compareEpisodeMediaPath,
  parseEpisodeNoFromMediaPath,
  parseEpisodeSortKey,
} from "./episode-filename.js";
export { episodeIdFromNo, prefixEpisodeSegments, mergeDramaSegments } from "./drama-segments.js";
export {
  CLIP_LOCAL_SOURCE_PREFIX,
  toClipLocalSourceUrl,
  parseClipLocalSourceUrl,
  isClipLocalSource,
} from "./local-source.js";
export {
  DEFAULT_RESOURCE_LOAD_PROFILES,
  DEFAULT_RESOURCE_POLICY,
  getZonedMinutes,
  isMinutesInWindow,
  mergeResourcePolicy,
  parseHmToMinutes,
  resolveActiveResourceLoad,
  resolveResourcePolicy,
  type ResourceLoadMode,
  type ResourceLoadProfile,
  type ResourcePolicyConfig,
  type ResourceProcessPriority,
  type ResourceTimeWindow,
  type ResolvedResourceLoad,
} from "./resource-policy.js";
export {
  enrichEffectiveConfigForAgent,
  enrichRenderConfigForAgent,
  enrichTosConfigForAgent,
  normalizeTosEndpoint,
  normalizeTosS3Endpoint,
  resolveTosAccessSecret,
  resolveTosPublicHost,
  resolveTosSdkUploadEndpoint,
} from "./tos-config.js";
