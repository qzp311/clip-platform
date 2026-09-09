/** 视觉指纹匹配时间线中的一段 */
export interface RemixSegment {
  reference_start: number;
  reference_end: number;
  source_index: number | null;
  source_start: number | null;
  source_end: number | null;
  speed: number | null;
  confidence: number;
  status: string;
}

/** matcher.py analyze 输出结构 */
export interface RemixAnalysisResult {
  reference: {
    path: string;
    duration: number;
    width: number;
    height: number;
    fps: number;
  };
  /** 多案例时的全部参考视频（单案例时等于 [reference]） */
  references?: Array<{
    path: string;
    duration: number;
    width: number;
    height: number;
    fps: number;
  }>;
  sources: Array<{
    path: string;
    duration: number;
    width: number;
    height: number;
    fps: number;
  }>;
  segments: RemixSegment[];
  sample_fps: number;
  matched_seconds: number;
  unmatched_seconds: number;
}

export interface RunPythonOptions {
  pythonExecutable?: string;
  sampleFps?: number;
  cacheDir?: string;
  /** 显式指定复刻原片特征缓存 npz 文件路径，优先于 cacheDir */
  featureCachePath?: string;
  onLog?: (line: string) => void;
  onProgress?: (value: number) => void;
}
