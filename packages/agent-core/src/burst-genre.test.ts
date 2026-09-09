import { describe, expect, it } from "vitest";
import { scoreBurstText } from "./burst-heuristic.js";
import { resolveGenreProfile } from "./infer-genre-profile.js";
import { annotateAsrSegmentsWithLabels } from "./asr-segment-labels.js";
import type { AsrSegment } from "@clip/sdk";

describe("resolveGenreProfile", () => {
  it("手填优先", () => {
    expect(
      resolveGenreProfile({
        genreProfile: "sweet_romance",
        synopsis: "绑定系统待满九十九天回现代",
      }),
    ).toBe("sweet_romance");
  });

  it("简介识别穿越系统流", () => {
    expect(
      resolveGenreProfile({
        title: "求求了！我要回冷宫",
        synopsis: "现代社畜穿越后绑定系统，待满天数即可回现代，为完成任务拼命作死回冷宫。",
      }),
    ).toBe("system_transmigration");
  });

  it("简介识别年代重生", () => {
    expect(
      resolveGenreProfile({
        synopsis: "老太重生回到九十年代，看清偏心真面目，拒绝彩礼逼婚。",
      }),
    ).toBe("era_male");
  });
});

describe("scoreBurstText by genre", () => {
  it("系统流词在加表下得分显著高于仅通用底表", () => {
    const text = "系统提示：待满九十九天即可回现代，快完成任务";
    const commonOnly = scoreBurstText(text);
    const withGenre = scoreBurstText(text, { genreProfile: "system_transmigration" });
    expect(withGenre.score).toBeGreaterThan(commonOnly.score);
    expect(withGenre.tags.some((t) => /系统|规则/.test(t))).toBe(true);
  });

  it("甜宠护短在加表下可标高分", () => {
    const text = "谁敢动她？她是我老婆，给我跪下道歉";
    const scored = scoreBurstText(text, { genreProfile: "sweet_romance" });
    expect(scored.score).toBeGreaterThanOrEqual(3);
    expect(scored.tags.length).toBeGreaterThan(0);
  });
});

describe("annotateAsrSegmentsWithLabels genre", () => {
  it("系统流台词写入 genre labelSource", () => {
    const segs: AsrSegment[] = [
      {
        segmentId: "e01_s001",
        episodeId: "e01",
        episodeNo: 1,
        startMs: 0,
        endMs: 4000,
        text: "破系统又给我发任务了，我必须回冷宫",
      },
    ];
    const out = annotateAsrSegmentsWithLabels(segs, {
      title: "求求了！我要回冷宫",
      synopsis: "穿越绑定系统，待满天数回现代。",
    });
    expect(out[0]!.labelSource).toContain("genre:system_transmigration");
    expect(out[0]!.highlightType).toBeTruthy();
    expect((out[0]!.highlightScore ?? 0) >= 2).toBe(true);
  });
});
