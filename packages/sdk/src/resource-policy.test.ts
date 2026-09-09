import { describe, expect, it } from "vitest";
import {
  getZonedMinutes,
  isMinutesInWindow,
  mergeResourcePolicy,
  parseHmToMinutes,
  resolveActiveResourceLoad,
  resolveResourcePolicy,
} from "./resource-policy.js";

describe("resource-policy", () => {
  it("parses HH:mm", () => {
    expect(parseHmToMinutes("09:00")).toBe(9 * 60);
    expect(parseHmToMinutes("20:30")).toBe(20 * 60 + 30);
    expect(parseHmToMinutes("bad")).toBeNull();
  });

  it("detects work windows including overnight", () => {
    expect(isMinutesInWindow(10 * 60, { start: "09:00", end: "20:00" })).toBe(true);
    expect(isMinutesInWindow(20 * 60, { start: "09:00", end: "20:00" })).toBe(false);
    expect(isMinutesInWindow(23 * 60, { start: "22:00", end: "06:00" })).toBe(true);
    expect(isMinutesInWindow(5 * 60, { start: "22:00", end: "06:00" })).toBe(true);
    expect(isMinutesInWindow(12 * 60, { start: "22:00", end: "06:00" })).toBe(false);
  });

  it("uses throttled during default work hours in Shanghai", () => {
    // 2026-08-25 10:00 Asia/Shanghai = 02:00 UTC
    const now = new Date("2026-08-25T02:00:00.000Z");
    expect(getZonedMinutes(now, "Asia/Shanghai")).toBe(10 * 60);
    const active = resolveActiveResourceLoad(undefined, now);
    expect(active.window).toBe("work");
    expect(active.mode).toBe("throttled");
    expect(active.profile.maxConcurrentRenders).toBe(1);
    expect(active.profile.processPriority).toBe("below_normal");
  });

  it("uses full outside work hours", () => {
    // 2026-08-25 21:00 Asia/Shanghai = 13:00 UTC
    const now = new Date("2026-08-25T13:00:00.000Z");
    const active = resolveActiveResourceLoad(undefined, now);
    expect(active.window).toBe("off");
    expect(active.mode).toBe("full");
    expect(active.profile.maxConcurrentRenders).toBe(2);
  });

  it("respects scheduleEnabled=false fixedMode", () => {
    const policy = resolveResourcePolicy({
      scheduleEnabled: false,
      fixedMode: "throttled",
    });
    const active = resolveActiveResourceLoad(policy, new Date());
    expect(active.window).toBe("fixed");
    expect(active.mode).toBe("throttled");
  });

  it("merges device override profiles onto global", () => {
    const merged = mergeResourcePolicy(
      { scheduleEnabled: true, workMode: "throttled" },
      {
        scheduleEnabled: false,
        fixedMode: "full",
        profiles: { full: { maxConcurrentRenders: 3 } },
      },
    );
    expect(merged.scheduleEnabled).toBe(false);
    expect(merged.fixedMode).toBe("full");
    expect(merged.profiles.full.maxConcurrentRenders).toBe(3);
    expect(merged.profiles.full.maxConcurrentUploads).toBe(2);
  });
});
