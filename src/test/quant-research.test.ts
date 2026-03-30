import { describe, expect, it } from "vitest";
import { rebalanceTrainingExamplesBySegment, TrainingExample } from "../lib/quant-research";

function example(
  timestamp: number,
  regimeSegment: string,
  overrides: Partial<TrainingExample> = {},
): TrainingExample {
  return {
    timestamp,
    regime: "mixed",
    regimeSegment,
    sessionBucket: "us",
    volatilityBucket: "normal",
    decision: {
      action: "hold",
      confidence: 50,
      reasoning: "test",
      regime: "mixed",
      setupType: "trend",
      stopPct: 0,
      takeProfitPct: 0,
      riskReward: 0,
      features: {},
    },
    futureReturnPct: 0,
    netFutureReturnPct: 0,
    futureMaxUpPct: 0,
    futureMaxDownPct: 0,
    dynamicMoveThresholdPct: 0.2,
    adverseAllowancePct: 0.25,
    labelLong: 0,
    labelShort: 0,
    featureMap: {},
    features: [0, 1, 2],
    ...overrides,
  };
}

describe("rebalanceTrainingExamplesBySegment", () => {
  it("caps dominant segments while keeping chronological order", () => {
    const examples: TrainingExample[] = [
      ...Array.from({ length: 8 }, (_, index) => example(index + 1, "trend_long|trend|us|normal")),
      ...Array.from({ length: 3 }, (_, index) => example(index + 100, "range|mean_reversion|asia|compressed")),
    ];

    const result = rebalanceTrainingExamplesBySegment(examples, 4);

    expect(result.balancedSegmentCount).toBe(2);
    expect(result.examples).toHaveLength(7);
    expect(result.examples.filter((row) => row.regimeSegment === "trend_long|trend|us|normal")).toHaveLength(4);
    expect(result.examples.filter((row) => row.regimeSegment === "range|mean_reversion|asia|compressed")).toHaveLength(3);
    expect(result.examples.map((row) => row.timestamp)).toEqual([1, 3, 6, 8, 100, 101, 102]);
  });

  it("keeps more positive examples for the requested side inside each segment", () => {
    const examples: TrainingExample[] = [
      ...Array.from({ length: 8 }, (_, index) =>
        example(index + 1, "trend_long|trend|us|normal", {
          labelLong: index < 2 ? 1 : 0,
        })),
      ...Array.from({ length: 4 }, (_, index) =>
        example(index + 100, "range|mean_reversion|asia|compressed", {
          labelLong: index === 0 ? 1 : 0,
        })),
    ];

    const result = rebalanceTrainingExamplesBySegment(examples, 4, "long");

    expect(result.examples).toHaveLength(8);
    expect(result.examples.filter((row) => row.regimeSegment === "trend_long|trend|us|normal")).toHaveLength(4);
    expect(result.examples.filter((row) => row.regimeSegment === "trend_long|trend|us|normal" && row.labelLong === 1)).toHaveLength(2);
    expect(result.examples.filter((row) => row.regimeSegment === "range|mean_reversion|asia|compressed" && row.labelLong === 1)).toHaveLength(1);
  });
});
