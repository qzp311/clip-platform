/** Agent 负载档位：满载 / 工作时段限流 */
export type ResourceLoadMode = "full" | "throttled";

/** 进程优先级（Windows 下映射到 BelowNormal / Normal） */
export type ResourceProcessPriority = "normal" | "below_normal";

/** 单档负载参数 */
export interface ResourceLoadProfile {
  /** 单任务内 FFmpeg 同时渲染数 */
  maxConcurrentRenders: number;
  /** 单任务内同时上传数 */
  maxConcurrentUploads: number;
  /** 子进程优先级 */
  processPriority: ResourceProcessPriority;
  /**
   * FFmpeg `-threads`；0 或不传表示不限制。
   * 限流档建议 2，避免软编/滤镜打满 CPU。
   */
  ffmpegThreads?: number;
}

/** 本地工作时段（半开区间 [start, end)），格式 HH:mm */
export interface ResourceTimeWindow {
  start: string;
  end: string;
}

/**
 * 服务端下发的资源策略：按时段在 full / throttled 间切换。
 * 关闭 scheduleEnabled 时固定使用 fixedMode。
 */
export interface ResourcePolicyConfig {
  /** 是否启用时间段控制；false 时始终用 fixedMode */
  scheduleEnabled?: boolean;
  /** IANA 时区，默认 Asia/Shanghai */
  timezone?: string;
  /** 工作时段列表；落在任一段内视为 work */
  workWindows?: ResourceTimeWindow[];
  /** scheduleEnabled=false 时的固定档 */
  fixedMode?: ResourceLoadMode;
  /** 工作时段使用的档 */
  workMode?: ResourceLoadMode;
  /** 非工作时段使用的档 */
  offMode?: ResourceLoadMode;
  /** 两档具体参数（可只覆盖部分字段） */
  profiles?: {
    full?: Partial<ResourceLoadProfile>;
    throttled?: Partial<ResourceLoadProfile>;
  };
}

export const DEFAULT_RESOURCE_LOAD_PROFILES: Record<ResourceLoadMode, ResourceLoadProfile> = {
  full: {
    maxConcurrentRenders: 2,
    maxConcurrentUploads: 2,
    processPriority: "normal",
    ffmpegThreads: 0,
  },
  throttled: {
    maxConcurrentRenders: 1,
    maxConcurrentUploads: 1,
    processPriority: "below_normal",
    ffmpegThreads: 2,
  },
};

export const DEFAULT_RESOURCE_POLICY: Required<
  Omit<ResourcePolicyConfig, "profiles" | "workWindows">
> & {
  workWindows: ResourceTimeWindow[];
  profiles: Record<ResourceLoadMode, ResourceLoadProfile>;
} = {
  scheduleEnabled: true,
  timezone: "Asia/Shanghai",
  workWindows: [{ start: "09:00", end: "20:00" }],
  fixedMode: "full",
  workMode: "throttled",
  offMode: "full",
  profiles: {
    full: { ...DEFAULT_RESOURCE_LOAD_PROFILES.full },
    throttled: { ...DEFAULT_RESOURCE_LOAD_PROFILES.throttled },
  },
};

/** 解析 HH:mm 为当日分钟数；非法返回 null */
export function parseHmToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

/**
 * 判断 nowMinutes 是否落在窗口内（半开 [start, end)）。
 * 支持跨午夜：如 22:00–06:00。
 */
export function isMinutesInWindow(nowMinutes: number, window: ResourceTimeWindow): boolean {
  const start = parseHmToMinutes(window.start);
  const end = parseHmToMinutes(window.end);
  if (start == null || end == null) return false;
  if (start === end) return true; // 全天
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // 跨午夜
  return nowMinutes >= start || nowMinutes < end;
}

/** 取时区内当前「时:分」对应的分钟数 */
export function getZonedMinutes(now: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return now.getHours() * 60 + now.getMinutes();
    }
    return hour * 60 + minute;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function clampConcurrency(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(8, v));
}

function normalizePriority(v: unknown, fallback: ResourceProcessPriority): ResourceProcessPriority {
  return v === "below_normal" || v === "normal" ? v : fallback;
}

function normalizeMode(v: unknown, fallback: ResourceLoadMode): ResourceLoadMode {
  return v === "throttled" || v === "full" ? v : fallback;
}

function mergeProfile(
  base: ResourceLoadProfile,
  patch?: Partial<ResourceLoadProfile>,
): ResourceLoadProfile {
  if (!patch) return { ...base };
  const threadsRaw = patch.ffmpegThreads;
  const ffmpegThreads =
    threadsRaw === undefined
      ? base.ffmpegThreads ?? 0
      : Math.max(0, Math.min(16, Math.floor(Number(threadsRaw)) || 0));
  return {
    maxConcurrentRenders: clampConcurrency(patch.maxConcurrentRenders, base.maxConcurrentRenders),
    maxConcurrentUploads: clampConcurrency(patch.maxConcurrentUploads, base.maxConcurrentUploads),
    processPriority: normalizePriority(patch.processPriority, base.processPriority),
    ffmpegThreads,
  };
}

/** 归一化并补全默认；供存储/下发前使用 */
export function resolveResourcePolicy(
  input?: ResourcePolicyConfig | null,
): typeof DEFAULT_RESOURCE_POLICY {
  const src = input ?? {};
  const workWindows =
    Array.isArray(src.workWindows) && src.workWindows.length > 0
      ? src.workWindows
          .map((w) => ({ start: String(w?.start ?? "").trim(), end: String(w?.end ?? "").trim() }))
          .filter((w) => parseHmToMinutes(w.start) != null && parseHmToMinutes(w.end) != null)
      : DEFAULT_RESOURCE_POLICY.workWindows.map((w) => ({ ...w }));

  return {
    scheduleEnabled: src.scheduleEnabled !== false,
    timezone: String(src.timezone ?? DEFAULT_RESOURCE_POLICY.timezone).trim() || "Asia/Shanghai",
    workWindows: workWindows.length ? workWindows : [{ start: "09:00", end: "20:00" }],
    fixedMode: normalizeMode(src.fixedMode, DEFAULT_RESOURCE_POLICY.fixedMode),
    workMode: normalizeMode(src.workMode, DEFAULT_RESOURCE_POLICY.workMode),
    offMode: normalizeMode(src.offMode, DEFAULT_RESOURCE_POLICY.offMode),
    profiles: {
      full: mergeProfile(DEFAULT_RESOURCE_LOAD_PROFILES.full, src.profiles?.full),
      throttled: mergeProfile(DEFAULT_RESOURCE_LOAD_PROFILES.throttled, src.profiles?.throttled),
    },
  };
}

/** 设备覆盖合并到全局；override 为 null 表示清除覆盖、只用全局 */
export function mergeResourcePolicy(
  global?: ResourcePolicyConfig | null,
  override?: ResourcePolicyConfig | null,
): typeof DEFAULT_RESOURCE_POLICY {
  if (override === null || override === undefined) {
    return resolveResourcePolicy(global);
  }
  if (!global) return resolveResourcePolicy(override);
  const g = resolveResourcePolicy(global);
  return resolveResourcePolicy({
    scheduleEnabled: override.scheduleEnabled ?? g.scheduleEnabled,
    timezone: override.timezone ?? g.timezone,
    workWindows: override.workWindows ?? g.workWindows,
    fixedMode: override.fixedMode ?? g.fixedMode,
    workMode: override.workMode ?? g.workMode,
    offMode: override.offMode ?? g.offMode,
    profiles: {
      full: { ...g.profiles.full, ...override.profiles?.full },
      throttled: { ...g.profiles.throttled, ...override.profiles?.throttled },
    },
  });
}

export interface ResolvedResourceLoad {
  mode: ResourceLoadMode;
  /** work | off | fixed */
  window: "work" | "off" | "fixed";
  profile: ResourceLoadProfile;
  policy: typeof DEFAULT_RESOURCE_POLICY;
}

/** 按本机（策略时区）当前时间解析生效档位 */
export function resolveActiveResourceLoad(
  policyInput?: ResourcePolicyConfig | null,
  now: Date = new Date(),
): ResolvedResourceLoad {
  const policy = resolveResourcePolicy(policyInput);
  if (!policy.scheduleEnabled) {
    const mode = policy.fixedMode;
    return { mode, window: "fixed", profile: { ...policy.profiles[mode] }, policy };
  }
  const minutes = getZonedMinutes(now, policy.timezone);
  const inWork = policy.workWindows.some((w) => isMinutesInWindow(minutes, w));
  const mode = inWork ? policy.workMode : policy.offMode;
  return {
    mode,
    window: inWork ? "work" : "off",
    profile: { ...policy.profiles[mode] },
    policy,
  };
}
