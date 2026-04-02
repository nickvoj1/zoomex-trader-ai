import { describe, expect, it } from "vitest";
import {
  extractFeatureMap,
  gateCompressedLongTrainingExamples,
  prepareHistoricalContext,
  rebalanceTrainingExamplesBySegment,
  TrainingExample,
} from "../lib/quant-research";
import { MarketCandle, StrategySettings } from "../lib/strategy-core";

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
    action: "hold",
    futureReturnPct: 0,
    netFutureReturnPct: 0,
    futureMaxUpPct: 0,
    futureMaxDownPct: 0,
    dynamicMoveThresholdPct: 0.2,
    adverseAllowancePct: 0.25,
    labelLong: 0,
    labelShort: 0,
    features: [0, 1, 2],
    ...overrides,
  };
}

function settings(overrides: Partial<StrategySettings> = {}): StrategySettings {
  return {
    riskPct: 0.5,
    leverage: 10,
    minConfidence: 78,
    dailyLossLimitPct: 3,
    maxConsecutiveLosses: 3,
    allowTrendTrades: true,
    allowMeanReversionTrades: true,
    feeBps: 4,
    slippageBps: 3,
    maxBarsInTrade: 90,
    partialTakeProfitRR: 1.2,
    allowSessionFilter: true,
    sessionStartHourUtc: 6,
    sessionEndHourUtc: 22,
    ...overrides,
  };
}

function buildCandles(count: number, startTimestamp: number): MarketCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 60_000 + index * 0.4 + Math.sin(index / 15) * 25;
    const close = base + Math.sin(index / 5) * 6;
    return {
      timestamp: startTimestamp + index * 60_000,
      open: base - 2,
      high: close + 3,
      low: close - 3,
      close,
      volume: 100 + (index % 12) * 8,
    };
  });
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

describe("gateCompressedLongTrainingExamples", () => {
  it("removes compressed trend-long long examples from long-side training", () => {
    const examples: TrainingExample[] = [
      example(1, "trend_long|trend|us|compressed", {
        action: "long",
        regime: "trend_long",
        volatilityBucket: "compressed",
      }),
      example(2, "trend_long|trend|us|normal", {
        action: "long",
        regime: "trend_long",
        volatilityBucket: "normal",
      }),
      example(3, "trend_short|trend|us|compressed", {
        action: "short",
        regime: "trend_short",
        volatilityBucket: "compressed",
      }),
    ];

    const result = gateCompressedLongTrainingExamples(examples, "long");

    expect(result.removed).toBe(1);
    expect(result.examples).toHaveLength(2);
    expect(result.examples.map((row) => row.timestamp)).toEqual([2, 3]);
  });
});

describe("extractFeatureMap context alignment", () => {
  it("uses recent news and latest macro snapshots without look-ahead", () => {
    const candles = buildCandles(900, Date.parse("2026-03-01T00:00:00Z"));
    const lastTimestamp = candles[candles.length - 1].timestamp!;
    const result = extractFeatureMap(candles, candles.length - 1, settings(), {
      contextHistory: prepareHistoricalContext([
        {
          timestamp: lastTimestamp - 48 * 60 * 60_000,
          macroCpiYoY: 3.2,
          macroCpiMoM: 0.3,
          macroCoreCpiYoY: 3.6,
          macroCoreCpiMoM: 0.4,
          macroUnemploymentRate: 4.1,
          macroUnemploymentChange: -0.1,
          macroInflationTrend: 0.15,
          macroRiskBias: -0.22,
        },
        {
          timestamp: lastTimestamp - 30 * 60_000,
          newsEventCount: 1,
          newsSentiment: 0.6,
          newsImpact: 0.8,
          newsPositiveCount: 1,
          newsNegativeCount: 0,
          newsBtcRelevance: 0.9,
          newsShockScore: 0.72,
        },
        {
          timestamp: lastTimestamp + 10 * 60_000,
          newsEventCount: 1,
          newsSentiment: -1,
          newsImpact: 1,
          newsPositiveCount: 0,
          newsNegativeCount: 1,
          newsBtcRelevance: 1,
          newsShockScore: 1,
        },
      ]),
      newsLookbackMs: 6 * 60 * 60 * 1000,
    });

    expect(result.featureMap.context_has_snapshot).toBe(1);
    expect(result.featureMap.news_event_count_sum).toBe(1);
    expect(result.featureMap.news_sentiment_mean).toBeCloseTo(0.6, 6);
    expect(result.featureMap.news_shock_score_max).toBeCloseTo(0.72, 6);
    expect(result.featureMap.macro_has_snapshot).toBe(1);
    expect(result.featureMap.macro_cpi_yoy).toBeCloseTo(3.2, 6);
    expect(result.featureMap.macro_unemployment_rate).toBeCloseTo(4.1, 6);
    expect(result.featureMap.macro_unemployment_change).toBeCloseTo(-0.1, 6);
    expect(result.featureMap.macro_risk_bias).toBeCloseTo(-0.22, 6);
    expect(result.featureMap.news_minutes_since_latest).toBeCloseTo(30, 6);
  });
});
