import { describe, expect, it } from "vitest";
import {
  isWorkstationClosingMarker,
  isWorkstationOpeningMarker,
  normalizeWorkstationMarkerType,
} from "./workstation-marker-types.js";

describe("workstation marker types", () => {
  it("高光 -> opening hook", () => {
    expect(normalizeWorkstationMarkerType("conflict", "高光")).toBe("hook");
    expect(isWorkstationOpeningMarker("conflict", "高光")).toBe(true);
  });

  it("钩子 -> closing cliff (legacy hook type)", () => {
    expect(normalizeWorkstationMarkerType("hook", "钩子")).toBe("cliff");
    expect(isWorkstationClosingMarker("hook", "钩子")).toBe(true);
    expect(isWorkstationOpeningMarker("hook", "钩子")).toBe(false);
  });

  it("cliff label -> closing", () => {
    expect(normalizeWorkstationMarkerType(undefined, "悬念钩子")).toBe("cliff");
  });
});
