import { describe, expect, it } from "vitest";
import type { AsrSegment, ClipPlan } from "@clip/sdk";
import {
  attachSkillsQualityToMixRenders,
  buildSkillsPlanQualityReport,
  evaluateSkillsPlanQuality,
  isSkillsPlanAcceptable,
} from "./skills-plan-quality.js";
import { finalizeSkillsMechanicalBoundaries } from "./episode-boundary-anchors.js";

function makeEpisode(ep: string, no: number, count: number): AsrSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    segmentId: `${ep}_s${String(i + 1).padStart(3, "0")}`,
    episodeId: ep,
    episodeNo: no,
    startMs: i * 4000,
    endMs: (i + 1) * 4000,
    text: `${ep} line ${i + 1}`,
  }));
}

function withNarrativeClaims(plan: ClipPlan): ClipPlan {
  return {
    ...plan,
    setupClaim: plan.setupClaim ?? "男主被当众羞辱，因身份差起冲突",
    advanceClaim: plan.advanceClaim ?? "邻集加压后男主亮出身份半步兑现",
    openLoopClaim: plan.openLoopClaim ?? "片尾身份将揭未揭，回扣开篇羞辱",
  };
}

describe("evaluateSkillsPlanQuality", () => {
  const segments = [
    ...makeEpisode("e01", 1, 10),
    ...makeEpisode("e02", 2, 10),
    ...makeEpisode("e03", 3, 12),
  ];

  it("scores high when boundaries and metadata are complete", () => {
    // 段长 8s：三块 through 约 22×8≈176s，落在 3min 150~240 硬窗内
    const longSegs = segments.map((s) => {
      const idx = Number(s.segmentId.split("_s")[1]);
      const ep = Number(s.episodeId!.slice(1));
      const epBase = (ep - 1) * 400_000;
      return {
        ...s,
        startMs: epBase + (idx - 1) * 8_000,
        endMs: epBase + idx * 8_000,
        text: `${s.text} 高能冲突反转羞辱`,
        reason: undefined,
      };
    });
    const blocks: ClipPlan["clips"] = [
      {
        segmentId: "e01_s003",
        throughSegmentId: "e01_s009",
        role: "hook",
        reason: "e01：当众羞辱戏说到第一停顿（勿半句掐断）",
      },
      {
        segmentId: "e02_s002",
        throughSegmentId: "e02_s009",
        role: "escalate",
        reason: "承接 e01：冲突升级整场说到权力差兑现",
      },
      {
        segmentId: "e03_s006",
        throughSegmentId: "e03_s012",
        role: "cliff",
        reason: "e03 末戏：身份将揭未揭",
      },
    ];
    const plan = withNarrativeClaims({
      version: "2.0",
      targetDurationLabel: "3min",
      editForm: "hook_first",
      hookSegmentId: "e01_s003",
      hookType: "羞辱冲突",
      introReason: "当众羞辱钩子抓住观众，说清谁因何起冲突",
      outroReason: "e03 集尾身份将揭未揭",
      synopsisAlignment: "对应简介主线",
      clips: blocks,
      output: { maxDurationSec: 600 },
    });
    const { plan: finalized } = finalizeSkillsMechanicalBoundaries(plan, longSegs);
    const q = evaluateSkillsPlanQuality(finalized, longSegs, { scoringClips: blocks });
    expect(q.closingAtEpisodeEnd).toBe(true);
    expect(q.score).toBeGreaterThanOrEqual(70);
    expect(q.grade).not.toBe("F");
    expect(q.issues.some((i) => i.includes("隔集跳戏"))).toBe(false);
    expect(q.issues.some((i) => i.includes("话未说完") || i.includes("跳场碎切"))).toBe(false);
    expect(isSkillsPlanAcceptable(q)).toBe(true);
  });

  it("penalizes 隔集跳戏 and marks plan unacceptable", () => {
    const more = [
      ...makeEpisode("e01", 1, 4),
      ...makeEpisode("e02", 2, 4),
      ...makeEpisode("e08", 8, 4),
    ];
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      hookSegmentId: "e01_s003",
      hookType: "冲突",
      introReason: "爆点开篇",
      outroReason: "e08 集尾悬念",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e01_s003", role: "hook" },
        { segmentId: "e01_s004", role: "escalate" },
        { segmentId: "e08_s003", role: "escalate" },
        { segmentId: "e08_s004", role: "cliff" },
      ],
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, more);
    expect(q.issues.some((i) => i.includes("隔集跳戏"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("rejects skipping even one episode (e01→e03)", () => {
    const more = [...makeEpisode("e01", 1, 4), ...makeEpisode("e03", 3, 4)];
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      hookSegmentId: "e01_s003",
      hookType: "冲突",
      introReason: "爆点开篇",
      outroReason: "e03 集尾悬念",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e01_s003", role: "hook" },
        { segmentId: "e01_s004", role: "escalate" },
        { segmentId: "e03_s003", role: "escalate" },
        { segmentId: "e03_s004", role: "cliff" },
      ],
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, more);
    expect(q.issues.some((i) => i.includes("隔集跳戏") && i.includes("必须相邻"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("rejects 10min plans that are far too short", () => {
    const more = [
      ...makeEpisode("e01", 1, 6),
      ...makeEpisode("e02", 2, 6),
      ...makeEpisode("e03", 3, 6),
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "10min",
      editForm: "skip_episode",
      hookSegmentId: "e01_s002",
      hookType: "冲突",
      introReason: "爆点",
      outroReason: "e03 集尾悬念",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e01_s002", throughSegmentId: "e01_s003", role: "hook" },
        { segmentId: "e02_s002", throughSegmentId: "e02_s003", role: "escalate" },
        { segmentId: "e03_s004", throughSegmentId: "e03_s006", role: "cliff" },
      ],
      output: {},
    };
    // 每段 4s → 估算约几十秒，仍低于 10min「过短不成片」线（180s）
    const q = evaluateSkillsPlanQuality(plan, more, { scoringClips: plan.clips });
    expect(q.issues.some((i) => i.includes("方案过短") || i.includes("块过少"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("accepts 10min plans under 480s when not too short", () => {
    const more = [
      ...makeEpisode("e01", 1, 8),
      ...makeEpisode("e02", 2, 8),
      ...makeEpisode("e03", 3, 8),
      ...makeEpisode("e04", 4, 8),
    ];
    // 约 4 集 × 8 段 × 8s ≈ 256s：不到 480，但应可出片
    for (const seg of more) {
      const idx = Number(seg.segmentId.split("_s")[1]);
      const ep = Number(seg.episodeId!.slice(1));
      seg.startMs = (ep * 8 + idx) * 8_000;
      seg.endMs = seg.startMs + 8_000;
    }
    const blocks = [
      { segmentId: "e01_s001", throughSegmentId: "e01_s008", role: "hook" as const },
      { segmentId: "e02_s001", throughSegmentId: "e02_s008", role: "escalate" as const },
      { segmentId: "e03_s001", throughSegmentId: "e03_s008", role: "escalate" as const },
      { segmentId: "e04_s001", throughSegmentId: "e04_s008", role: "cliff" as const },
    ];
    const plan = withNarrativeClaims({
      version: "2.0",
      targetDurationLabel: "10min",
      editForm: "sequential",
      introReason: "开篇建置说清谁因何冲突",
      outroReason: "e04 集尾悬念",
      synopsisAlignment: "主线",
      clips: blocks,
      output: {},
    });
    const { plan: finalized } = finalizeSkillsMechanicalBoundaries(plan, more);
    const q = evaluateSkillsPlanQuality(finalized, more, { scoringClips: blocks });
    expect(q.estimatedDurationSec).toBeGreaterThanOrEqual(180);
    expect(q.estimatedDurationSec).toBeLessThan(480);
    expect(q.issues.some((i) => i.includes("方案过短"))).toBe(false);
    expect(isSkillsPlanAcceptable(q)).toBe(true);
  });

  it("rejects plans missing setupClaim", () => {
    const more = [...makeEpisode("e01", 1, 8), ...makeEpisode("e02", 2, 8)];
    for (const seg of more) {
      const idx = Number(seg.segmentId.split("_s")[1]);
      const ep = Number(seg.episodeId!.slice(1));
      seg.startMs = (ep * 8 + idx) * 10_000;
      seg.endMs = seg.startMs + 10_000;
      seg.text = `${seg.text} 羞辱冲突打脸`;
    }
    const blocks = [
      { segmentId: "e01_s001", throughSegmentId: "e01_s008", role: "hook" as const, reason: "建置说到停顿" },
      { segmentId: "e02_s001", throughSegmentId: "e02_s008", role: "cliff" as const, reason: "集尾未解" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "3min",
      editForm: "hook_first",
      hookType: "冲突",
      hookSegmentId: "e01_s001",
      introReason: "开篇冲突说清起因",
      outroReason: "e02 集尾悬念",
      synopsisAlignment: "主线",
      advanceClaim: "中段身份差加压",
      openLoopClaim: "片尾将揭未揭",
      clips: blocks,
      output: {},
    };
    const { plan: finalized } = finalizeSkillsMechanicalBoundaries(plan, more);
    const q = evaluateSkillsPlanQuality(finalized, more, { scoringClips: blocks });
    expect(q.issues.some((i) => i.includes("缺少 setupClaim"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("rejects 10min plans that exceed hard max duration", () => {
    const more = [
      ...makeEpisode("e01", 1, 10),
      ...makeEpisode("e02", 2, 10),
      ...makeEpisode("e03", 3, 10),
      ...makeEpisode("e04", 4, 10),
      ...makeEpisode("e05", 5, 10),
      ...makeEpisode("e06", 6, 10),
    ];
    for (const seg of more) {
      const idx = Number(seg.segmentId.split("_s")[1]);
      const ep = Number(seg.episodeId!.slice(1));
      seg.startMs = (ep * 10 + idx) * 15_000;
      seg.endMs = seg.startMs + 15_000;
    }
    // 6 集 × 10 段 × 15s ≈ 900s，超过 720 硬上限
    const blocks = [
      { segmentId: "e01_s001", throughSegmentId: "e01_s010", role: "hook" as const },
      { segmentId: "e02_s001", throughSegmentId: "e02_s010", role: "escalate" as const },
      { segmentId: "e03_s001", throughSegmentId: "e03_s010", role: "escalate" as const },
      { segmentId: "e04_s001", throughSegmentId: "e04_s010", role: "escalate" as const },
      { segmentId: "e05_s001", throughSegmentId: "e05_s010", role: "escalate" as const },
      { segmentId: "e06_s001", throughSegmentId: "e06_s010", role: "cliff" as const },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "10min",
      editForm: "sequential",
      introReason: "开篇",
      outroReason: "e06 集尾",
      synopsisAlignment: "主线",
      clips: blocks,
      output: {},
    };
    const { plan: finalized } = finalizeSkillsMechanicalBoundaries(plan, more);
    const q = evaluateSkillsPlanQuality(finalized, more, { scoringClips: blocks });
    expect(q.issues.some((i) => i.includes("方案过长"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("rejects mid-scene chop before episode switch", () => {
    const more = [
      ...makeEpisode("e01", 1, 12),
      ...makeEpisode("e02", 2, 12),
      ...makeEpisode("e03", 3, 12),
    ];
    for (const seg of more) {
      const idx = Number(seg.segmentId.split("_s")[1]);
      const ep = Number(seg.episodeId!.slice(1));
      seg.startMs = (ep * 12 + idx) * 8_000;
      seg.endMs = seg.startMs + 8_000;
    }
    // 每集只掐 3 句就跳 — 典型「话未说完」
    const choppy = [
      { segmentId: "e01_s003", throughSegmentId: "e01_s005", role: "hook" as const },
      { segmentId: "e02_s004", throughSegmentId: "e02_s006", role: "escalate" as const },
      { segmentId: "e03_s008", throughSegmentId: "e03_s012", role: "cliff" as const },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "3min",
      editForm: "hook_first",
      hookSegmentId: "e01_s003",
      hookType: "冲突",
      introReason: "爆点",
      outroReason: "e03 集尾悬念",
      synopsisAlignment: "主线",
      clips: choppy,
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, more, { scoringClips: choppy });
    expect(
      q.issues.some(
        (i) => i.includes("话未说完") || i.includes("跳场碎切") || i.includes("场面未收束"),
      ),
    ).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("rejects 10min sparse single-segment hops", () => {
    const more = [
      ...makeEpisode("e01", 1, 8),
      ...makeEpisode("e02", 2, 8),
      ...makeEpisode("e03", 3, 8),
      ...makeEpisode("e04", 4, 8),
      ...makeEpisode("e05", 5, 8),
    ];
    // 拉长每段使估算时长过 480s，但块是单段跳点
    for (const seg of more) {
      const idx = Number(seg.segmentId.split("_s")[1]);
      const ep = Number(seg.episodeId!.slice(1));
      seg.startMs = (ep * 8 + idx) * 20_000;
      seg.endMs = seg.startMs + 20_000;
    }
    const sparseBlocks = [
      { segmentId: "e01_s002", throughSegmentId: "e01_s002", role: "hook" as const },
      { segmentId: "e02_s002", throughSegmentId: "e02_s002", role: "escalate" as const },
      { segmentId: "e03_s002", throughSegmentId: "e03_s002", role: "escalate" as const },
      { segmentId: "e04_s002", throughSegmentId: "e04_s002", role: "escalate" as const },
      { segmentId: "e05_s006", throughSegmentId: "e05_s008", role: "cliff" as const },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "10min",
      editForm: "skip_episode",
      hookSegmentId: "e01_s002",
      hookType: "冲突",
      introReason: "爆点",
      outroReason: "e05 集尾悬念",
      synopsisAlignment: "主线",
      clips: sparseBlocks,
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, more, { scoringClips: sparseBlocks });
    expect(q.issues.some((i) => i.includes("稀疏单段"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("penalizes 集序倒跳", () => {
    const more = [...makeEpisode("e05", 5, 4), ...makeEpisode("e03", 3, 4)];
    const plan: ClipPlan = {
      version: "2.0",
      introReason: "a",
      outroReason: "e03 集尾",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e05_s001", role: "hook" },
        { segmentId: "e05_s002", role: "escalate" },
        { segmentId: "e03_s003", role: "escalate" },
        { segmentId: "e03_s004", role: "cliff" },
      ],
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, more);
    expect(q.issues.some((i) => i.includes("集序倒跳"))).toBe(true);
    expect(isSkillsPlanAcceptable(q)).toBe(false);
  });

  it("flags outroReason vs closing episode mismatch", () => {
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "3min",
      introReason: "hook",
      outroReason: "e07_s012：韩哥身份将揭",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e01_s001", role: "hook" },
        { segmentId: "e01_s002", role: "escalate" },
        { segmentId: "e03_s011", role: "escalate" },
        { segmentId: "e03_s012", role: "cliff" },
      ],
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, segments);
    expect(q.issues.some((i) => i.includes("outroReason") && i.includes("不一致"))).toBe(true);
  });

  it("does not treat 片头未贴 as issue for hook_first", () => {
    const plan: ClipPlan = {
      version: "2.0",
      editForm: "hook_first",
      hookSegmentId: "e01_s005",
      hookType: "羞辱冲突",
      introReason: "爆点",
      outroReason: "e03 集尾悬念",
      synopsisAlignment: "主线",
      clips: [
        { segmentId: "e01_s005", role: "hook" },
        { segmentId: "e01_s006", role: "escalate" },
        { segmentId: "e03_s011", role: "escalate" },
        { segmentId: "e03_s012", role: "cliff" },
      ],
      output: {},
    };
    const { warnings } = finalizeSkillsMechanicalBoundaries(plan, segments);
    const q = evaluateSkillsPlanQuality(plan, segments, { warnings });
    expect(warnings.some((w) => w.includes("片头未贴"))).toBe(false);
    expect(q.issues.some((i) => i.includes("片头未贴"))).toBe(false);
  });

  it("flags missing episode end and metadata", () => {
    const plan: ClipPlan = {
      version: "2.0",
      clips: [
        { segmentId: "e01_s005", role: "hook" },
        { segmentId: "e03_s010", role: "cliff" },
      ],
      output: {},
    };
    const q = evaluateSkillsPlanQuality(plan, segments);
    expect(q.closingAtEpisodeEnd).toBe(false);
    expect(q.openingNearEpisodeStart).toBe(false);
    expect(q.issues.some((i) => i.includes("片尾未贴"))).toBe(true);
    expect(q.score).toBeLessThan(60);
  });

  it("scores block reasons instead of expanded segment filler reasons", () => {
    const blockClips = [
      {
        segmentId: "e01_s003",
        throughSegmentId: "e01_s009",
        role: "hook" as const,
        reason: "e01：冲突建立说到停顿",
      },
      {
        segmentId: "e03_s006",
        throughSegmentId: "e03_s012",
        role: "cliff" as const,
        reason: "e03 集尾悬念",
      },
    ];
    const expandedClips = [
      { segmentId: "e01_s003", reason: "e01：冲突建立说到停顿" },
      { segmentId: "e01_s004", reason: "块内连续承接" },
      { segmentId: "e01_s005", reason: "块内连续承接" },
      { segmentId: "e01_s006", reason: "块内连续承接" },
      { segmentId: "e01_s007", reason: "块内连续承接" },
      { segmentId: "e01_s008", reason: "块内连续承接" },
      { segmentId: "e01_s009", reason: "块内连续承接" },
      { segmentId: "e03_s006", reason: "e03 集尾悬念" },
      { segmentId: "e03_s007", reason: "块内连续承接" },
      { segmentId: "e03_s008", reason: "块内连续承接" },
      { segmentId: "e03_s009", reason: "块内连续承接" },
      { segmentId: "e03_s010", reason: "块内连续承接" },
      { segmentId: "e03_s011", reason: "块内连续承接" },
      { segmentId: "e03_s012", reason: "块内连续承接" },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "3min",
      introReason: "hook",
      outroReason: "cliff",
      synopsisAlignment: "主线",
      clips: expandedClips,
      llmSourceClips: blockClips,
      output: {},
    };
    const expandedOnly = evaluateSkillsPlanQuality(plan, segments);
    const blockScored = evaluateSkillsPlanQuality(plan, segments, { scoringClips: blockClips });
    expect(expandedOnly.score).toBeLessThan(blockScored.score);
    expect(blockScored.issues.some((i) => i.includes("块 reason 过于平淡"))).toBe(false);
  });
});

describe("attachSkillsQualityToMixRenders", () => {
  it("maps plan skillsQuality onto mix renders by round and sequence", () => {
    const quality = {
      score: 80,
      grade: "B" as const,
      closingAtEpisodeEnd: true,
      openingNearEpisodeStart: true,
      hasOutroReason: true,
      hasIntroReason: true,
      hasSynopsisAlignment: true,
      estimatedDurationSec: 200,
      clipCount: 10,
      episodeCount: 2,
      issues: [],
      warnings: [],
    };
    const mixRenders = attachSkillsQualityToMixRenders(
      [
        { round: 1, planIndex: 1, planSeqInRound: 1, outputUrl: "a.mp4" },
        { round: 1, planIndex: 2, planSeqInRound: 2, outputUrl: "b.mp4" },
      ],
      [
        {
          version: "2.0",
          round: 1,
          totalRounds: 1,
          plansPerRound: 2,
          plans: [
            { version: "2.0", clips: [], output: {}, skillsQuality: quality },
            {
              version: "2.0",
              clips: [],
              output: {},
              skillsQuality: { ...quality, score: 65, grade: "C" as const },
            },
          ],
        },
      ],
    );
    expect(mixRenders[0]?.skillsQuality?.score).toBe(80);
    expect(mixRenders[1]?.skillsQuality?.grade).toBe("C");
  });
});

describe("buildSkillsPlanQualityReport", () => {
  const segments = makeEpisode("e01", 1, 8).map((s, i) => ({
    ...s,
    startMs: i * 25_000,
    endMs: (i + 1) * 25_000,
    text: `${s.text} 冲突`,
  }));

  it("aggregates batch plans", () => {
    const report = buildSkillsPlanQualityReport({
      clipSelectionMode: "skills",
      skillVersion: "1.9.3",
      segments,
      planBatches: [
        {
          version: "2.0",
          round: 1,
          totalRounds: 2,
          plansPerRound: 1,
          plans: [
            {
              version: "2.0",
              targetDurationLabel: "3min",
              editForm: "sequential",
              introReason: "集中冲突开篇说清谁因何起冲突",
              outroReason: "e01 集尾悬念将揭未揭",
              synopsisAlignment: "主线",
              setupClaim: "男女主当众起冲突，因误会撕破脸",
              advanceClaim: "中段误会加深，男主半步亮底",
              openLoopClaim: "片尾身份将揭未揭回扣开篇",
              // 报告聚合用已展开 clips（与网关归一化后一致）
              clips: [
                { segmentId: "e01_s002", role: "hook", reason: "冲突起" },
                { segmentId: "e01_s003", role: "escalate", reason: "块内连续承接" },
                { segmentId: "e01_s004", role: "escalate", reason: "块内连续承接" },
                { segmentId: "e01_s005", role: "escalate", reason: "块内连续承接" },
                { segmentId: "e01_s006", role: "escalate", reason: "块内连续承接" },
                { segmentId: "e01_s007", role: "escalate", reason: "块内连续承接" },
                { segmentId: "e01_s008", role: "cliff", reason: "集尾" },
              ],
              output: {},
            },
          ],
        },
      ],
    });
    expect(report.totalPlans).toBe(1);
    expect(report.avgScore).toBeGreaterThanOrEqual(60);
    expect(report.rounds[0]?.plans[0]?.quality.score).toBeGreaterThanOrEqual(60);
  });

  it("uses persisted highlightScore for opening burst (not recompute)", () => {
    // 片头段文本无冲突词，但落库 highlightScore=5（声学/题材已加分）
    // 质量闸应读 highlightScore 而非重算为 0，从而不误报"片头缺爆点"
    const labeledSegs = segments.map((s) =>
      s.segmentId === "e01_s003"
        ? { ...s, highlightScore: 5, usableAsHook: true }
        : s,
    );
    const blocks: ClipPlan["clips"] = [
      {
        segmentId: "e01_s003",
        throughSegmentId: "e01_s009",
        role: "hook",
        reason: "高光片头",
      },
      {
        segmentId: "e02_s002",
        throughSegmentId: "e02_s009",
        role: "cliff",
        reason: "片尾悬念",
      },
    ];
    const plan: ClipPlan = {
      version: "2.0",
      targetDurationLabel: "3min",
      editForm: "hook_first",
      hookSegmentId: "e01_s003",
      hookType: "冲突",
      introReason: "高光钩子",
      outroReason: "e02 集尾悬念",
      synopsisAlignment: "主线",
      clips: blocks,
      output: { maxDurationSec: 600 },
    };
    const { plan: finalized } = finalizeSkillsMechanicalBoundaries(plan, labeledSegs);
    const q = evaluateSkillsPlanQuality(finalized, labeledSegs, { scoringClips: blocks });
    // 不应报"片头缺爆点"
    expect(q.issues.some((i) => i.includes("片头缺爆点"))).toBe(false);
  });

});
