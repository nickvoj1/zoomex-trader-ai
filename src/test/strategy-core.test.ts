import { describe, expect, it } from "vitest";
import {
  applyPrecisionFirstEventGuard,
  aggregateCandles,
  calculatePositionSize,
  deriveAdvancedDecision,
  FrameSnapshot,
  MarketState,
  StrategySettings,
  toStopAndTakeProfit,
} from "../lib/strategy-core";

function frame(overrides: Partial<FrameSnapshot> = {}): FrameSnapshot {
  return {
    interval: "1m",
    close: 100,
    open: 99.5,
    ema20: 100,
    ema50: 99,
    emaSpreadPct: 1,
    emaSlopePct: 0.3,
    rsi: 50,
    atr: 1,
    atrPct: 0.01,
    realizedVolPct: 0.4,
    trendEfficiency: 0.35,
    adx: 22,
    vwap: 100,
    bollingerUpper: 102,
    bollingerLower: 98,
    bollingerZ: 0,
    bollingerWidthPct: 1,
    previousHigh: 100.2,
    previousLow: 99.2,
    momentum1Pct: 0.05,
    momentum3Pct: 0.06,
    momentum5Pct: 0.08,
    rangePct: 0.4,
    closeLocation: 0.7,
    bodyToRange: 0.7,
    volumeRatio: 1.2,
    volumeSpike: false,
    distFromVwapAtr: 0.1,
    wickBullish: false,
    wickBearish: false,
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

function marketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    timeframe1m: frame(),
    timeframe5m: frame({ interval: "5m" as const }),
    timeframe15m: frame({ interval: "15m" as const }),
    hasPosition: false,
    positionSide: null,
    activeSetupType: null,
    latestTimestamp: Date.parse("2026-03-29T10:00:00Z"),
    latestHourUtc: 10,
    microstructure: null,
    ...overrides,
  };
}

describe("calculatePositionSize", () => {
  it("caps size by leverage and rounds to contract size", () => {
    const sizing = calculatePositionSize(100, 1, 50_000, 49_990, 5);
    expect(sizing).toEqual({
      sizeBtc: 0.01,
      contracts: 100,
      riskAmount: 1,
    });
  });

  it("returns null when stop distance is zero", () => {
    expect(calculatePositionSize(1_000, 1, 50_000, 50_000, 5)).toBeNull();
  });
});

describe("toStopAndTakeProfit", () => {
  it("derives long and short stop/target prices", () => {
    expect(toStopAndTakeProfit(100, "long", {
      action: "long",
      confidence: 80,
      reasoning: "x",
      regime: "trend_long",
      setupType: "trend",
      stopPct: 0.01,
      takeProfitPct: 0.02,
      riskReward: 2,
      features: {},
    })).toEqual({ stopPrice: 99, takeProfitPrice: 102 });

    expect(toStopAndTakeProfit(100, "short", {
      action: "short",
      confidence: 80,
      reasoning: "x",
      regime: "trend_short",
      setupType: "trend",
      stopPct: 0.01,
      takeProfitPct: 0.02,
      riskReward: 2,
      features: {},
    })).toEqual({ stopPrice: 101, takeProfitPrice: 98 });
  });
});

describe("aggregateCandles", () => {
  it("normalizes second-based timestamps before bucketing", () => {
    const startSeconds = 1_704_067_200;
    const candles = Array.from({ length: 15 }, (_, index) => ({
      timestamp: startSeconds + index * 60,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 10,
    }));

    const aggregated = aggregateCandles(candles, 5);

    expect(aggregated).toHaveLength(3);
    expect(aggregated[0].timestamp).toBe(startSeconds * 1000);
    expect(aggregated[0].open).toBe(100);
    expect(aggregated[0].close).toBe(104.5);
    expect(aggregated[0].volume).toBe(50);
  });
});

describe("deriveAdvancedDecision safeguards", () => {
  it("goes risk-off after daily loss limit breach", () => {
    const decision = deriveAdvancedDecision(
      marketState(),
      settings(),
      {
        startingBalance: 10_000,
        currentBalance: 9_600,
        dailyRealizedPnl: -400,
        consecutiveLosses: 0,
      },
    );

    expect(decision.action).toBe("hold");
    expect(decision.setupType).toBe("risk_off");
    expect(decision.reasoning).toContain("Risk-off");
  });

  it("requests close for an open long when the regime flips bearish", () => {
    const decision = deriveAdvancedDecision(
      marketState({
        hasPosition: true,
        positionSide: "long",
        activeSetupType: "trend",
        timeframe1m: frame({
          close: 98.5,
          ema20: 100,
          rsi: 78,
          previousLow: 99,
          momentum1Pct: -0.2,
        }),
        timeframe5m: frame({
          interval: "5m",
          ema20: 98,
          ema50: 100,
          adx: 24,
          emaSlopePct: -0.5,
          trendEfficiency: 0.4,
        }),
        timeframe15m: frame({
          interval: "15m",
          ema20: 97,
          ema50: 101,
          adx: 26,
          emaSlopePct: -0.6,
          trendEfficiency: 0.45,
          distFromVwapAtr: 0.2,
        }),
      }),
      settings({ allowSessionFilter: false }),
      {
        startingBalance: 10_000,
        currentBalance: 10_100,
        dailyRealizedPnl: 0,
        consecutiveLosses: 0,
      },
    );

    expect(decision.action).toBe("close");
    expect(decision.reasoning).toContain("bearish");
  });
});

describe("applyPrecisionFirstEventGuard", () => {
  function eventDecision(overrides: Partial<ReturnType<typeof baseDecision>> = {}) {
    return {
      ...baseDecision(),
      ...overrides,
      features: {
        ...baseDecision().features,
        ...(overrides.features ?? {}),
      },
    };
  }

  function baseDecision() {
    return {
      action: "long" as const,
      confidence: 82,
      reasoning: "Trend long setup",
      regime: "trend_long" as const,
      setupType: "trend" as const,
      stopPct: 0.002,
      takeProfitPct: 0.004,
      riskReward: 2,
      features: {
        qualityScore: 72,
        modelEdge: 0.05,
        modelDelta: 0.01,
        news_shock_score_mean: 0.48,
        news_shock_score_max: 0.76,
        news_sentiment_mean: -0.36,
        news_btc_relevance_mean: 0.85,
        news_minutes_since_latest: 22,
        macro_risk_bias: -0.42,
        macro_release_window_24h: 1,
        macro_release_window_72h: 1,
        crowdingScore: 6.1,
      },
    };
  }

  it("blocks a weak long when macro release bias is hostile", () => {
    const decision = applyPrecisionFirstEventGuard(eventDecision(), 78);

    expect(decision.action).toBe("hold");
    expect(decision.reasoning).toContain("macro release bias opposes long");
    expect(decision.features.precisionGuardBlocked).toBe(true);
  });

  it("raises the confidence floor during event regimes", () => {
    const decision = applyPrecisionFirstEventGuard(
      eventDecision({
        features: {
          qualityScore: 84,
          modelEdge: 0.18,
          modelDelta: 0.06,
          news_shock_score_mean: 0.12,
          news_shock_score_max: 0.2,
          news_sentiment_mean: 0.08,
          macro_risk_bias: 0.1,
          macro_release_window_24h: 0,
          macro_release_window_72h: 1,
          crowdingScore: 0,
        },
        confidence: 79,
      }),
      78,
    );

    expect(decision.action).toBe("hold");
    expect(decision.reasoning).toContain("event regime requires");
  });

  it("allows aligned high-conviction event trades to pass", () => {
    const decision = applyPrecisionFirstEventGuard(
      eventDecision({
        confidence: 90,
        features: {
          qualityScore: 88,
          modelEdge: 0.22,
          modelDelta: 0.08,
          news_shock_score_mean: 0.45,
          news_shock_score_max: 0.68,
          news_sentiment_mean: 0.41,
          news_btc_relevance_mean: 0.92,
          news_minutes_since_latest: 18,
          macro_risk_bias: 0.34,
          macro_release_window_24h: 1,
          macro_release_window_72h: 1,
          crowdingScore: 1.4,
        },
      }),
      78,
    );

    expect(decision.action).toBe("long");
    expect(decision.features.precisionGuardBlocked).toBe(false);
  });
});
