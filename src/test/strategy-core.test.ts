import { describe, expect, it } from "vitest";
import {
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
