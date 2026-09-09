import { describe, expect, it } from "vitest";
import type { AsrSegment } from "@clip/sdk";
import { annotateAsrSegmentsWithLabels } from "./asr-segment-labels.js";

function seg(id: string, text: string, startMs: number, endMs: number): AsrSegment {
  return {
    segmentId: id,
    episodeId: "e01",
    episodeNo: 1,
    startMs,
    endMs,
    text,
    confidence: 0.9,
  };
}

describe("annotateAsrSegmentsWithLabels", () => {
  it("persists highlight / emotion / scene on conflict lines", () => {
    const out = annotateAsrSegmentsWithLabels([
      seg("e01_s001", "今天天气不错", 0, 3000),
      seg("e01_s002", "你这个穷鬼也配进裴家？给我滚出去", 3000, 8000),
      seg("e01_s003", "原来他才是真正的继承人", 8000, 12000),
    ]);
    expect(out[1]!.highlightType).toBeTruthy();
    expect(out[1]!.usableAsHook).toBe(true);
    expect(out[1]!.emotion).toBe("anger");
    expect(out[1]!.sceneType).toBe("conflict_dialogue");
    expect(out[2]!.highlightType).toBe("twist");
    expect(out[2]!.sceneType).toBe("reveal");
    expect(out[0]!.emotion).toBe("neutral");
    expect(out[0]!.labelSource).toContain("text_heuristic");
  });

  it("keeps speakerId empty without diarization raw", () => {
    const out = annotateAsrSegmentsWithLabels([
      seg("e01_s001", "你给我滚出去", 0, 4000),
    ]);
    expect(out[0]!.speakerId).toBeUndefined();
  });

  it("fuses acoustic loudness into highlight score", () => {
    // 同一句台词，一个高响度（-14dB）一个低响度（-30dB）
    const quiet: AsrSegment = {
      ...seg("e01_s001", "你配不配站在这里说话", 0, 4000),
      rmsDb: -30,
    };
    const loud: AsrSegment = {
      ...seg("e01_s002", "你配不配站在这里说话", 4000, 8000),
      rmsDb: -14,
    };
    const out = annotateAsrSegmentsWithLabels([quiet, loud]);
    // 高响度段分数应高于低响度段（声学 +2）
    expect(out[1]!.highlightScore!).toBeGreaterThan(out[0]!.highlightScore ?? 0);
    expect(out[1]!.labelSource).toContain("acoustic");
    expect(out[0]!.labelSource).not.toContain("acoustic");
  });

  it("falls back emotion to anger for loud segments with neutral text", () => {
    // 台词无情绪关键词、但高响度 → anger
    const loud: AsrSegment = {
      ...seg("e01_s001", "今天我们去那边看看", 0, 3000),
      rmsDb: -14,
    };
    const out = annotateAsrSegmentsWithLabels([loud]);
    expect(out[0]!.emotion).toBe("anger");
  });

  it("does not override non-neutral emotion with acoustic anger", () => {
    // 台词含悲伤词 + 高响度 → 保持 sad（文本情绪优先）
    const loudSad: AsrSegment = {
      ...seg("e01_s001", "对不起不要离开我", 0, 3000),
      rmsDb: -14,
    };
    const out = annotateAsrSegmentsWithLabels([loudSad]);
    expect(out[0]!.emotion).toBe("sad");
  });

});
