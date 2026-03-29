import {
  BacktestResult,
  buildMarketState,
  deriveAdvancedDecision,
  MarketCandle,
  MarketMicrostructure,
  normalizeCandles,
  RegimeKind,
  simulateStrategy,
  StrategyDecision,
  StrategySettings,
  StrategySetup,
} from "./strategy-core.ts";

export type SweepObjective =
  | "composite"
  | "net_profit"
  | "sharpe"
  | "sortino"
  | "calmar"
  | "profit_factor"
  | "expectancy";

export interface ParameterSpace {
  riskPct?: number[];
  leverage?: number[];
  minConfidence?: number[];
  dailyLossLimitPct?: number[];
  maxConsecutiveLosses?: number[];
  allowTrendTrades?: boolean[];
  allowMeanReversionTrades?: boolean[];
  feeBps?: number[];
  slippageBps?: number[];
  maxBarsInTrade?: number[];
  partialTakeProfitRR?: number[];
  allowSessionFilter?: boolean[];
  sessionStartHourUtc?: number[];
  sessionEndHourUtc?: number[];
}

export interface SweepCandidateResult {
  settings: StrategySettings;
  score: number;
  objective: SweepObjective;
  result: BacktestResult;
}

export interface WalkForwardConfig {
  trainingCandles: number;
  validationCandles: number;
  stepCandles: number;
  startingBalance?: number;
  objective?: SweepObjective;
  maxEvaluations?: number;
}

export interface WalkForwardFold {
  fold: number;
  trainStartIndex: number;
  trainEndIndex: number;
  testStartIndex: number;
  testEndIndex: number;
  bestSettings: StrategySettings;
  trainScore: number;
  testScore: number;
  trainResult: Pick<BacktestResult, "totalPnl" | "trades" | "winRate" | "maxDrawdown" | "sharpe" | "sortino" | "calmar" | "profitFactor" | "expectancy">;
  testResult: Pick<BacktestResult, "totalPnl" | "trades" | "winRate" | "maxDrawdown" | "sharpe" | "sortino" | "calmar" | "profitFactor" | "expectancy">;
}

export interface WalkForwardResult {
  objective: SweepObjective;
  candidatesEvaluated: number;
  folds: WalkForwardFold[];
  aggregate: {
    totalTestPnl: number;
    avgTestScore: number;
    avgTestSharpe: number;
    avgTestSortino: number;
    avgTestDrawdown: number;
    winRate: number;
    trades: number;
  };
}

export interface TrainingExample {
  timestamp: number | null;
  regime: RegimeKind;
  regimeSegment: string;
  sessionBucket: "asia" | "europe" | "us" | "offhours";
  volatilityBucket: "compressed" | "normal" | "expanded";
  decision: StrategyDecision;
  futureReturnPct: number;
  netFutureReturnPct: number;
  futureMaxUpPct: number;
  futureMaxDownPct: number;
  dynamicMoveThresholdPct: number;
  adverseAllowancePct: number;
  labelLong: number;
  labelShort: number;
  featureMap: Record<string, number>;
  features: number[];
}

export interface HistoricalMicrostructureSnapshot {
  timestamp: number;
  microstructure: MarketMicrostructure | null;
  source?: string | null;
}

export interface FeatureExtractionOptions {
  microstructureHistory?: HistoricalMicrostructureSnapshot[] | null;
  liveMicrostructure?: MarketMicrostructure | null;
  microstructureLookbackMs?: number;
}

export interface BinaryClassificationMetrics {
  loss: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  brier: number;
  positiveRate: number;
}

export interface DatasetSplitMetrics {
  train: BinaryClassificationMetrics;
  validation: BinaryClassificationMetrics;
  test: BinaryClassificationMetrics;
}

export interface SegmentClassificationMetrics extends BinaryClassificationMetrics {
  samples: number;
  labelRate: number;
  avgFutureReturnPct: number;
  avgNetFutureReturnPct: number;
  avgOpportunityPct: number;
  avgAdversePct: number;
  avgProbability: number;
}

export interface DatasetProfile {
  totalExamples: number;
  trainExamples: number;
  validationExamples: number;
  testExamples: number;
  positiveRate: number;
  coverageDays: number;
  avgFutureReturnPct: number;
  avgNetFutureReturnPct: number;
  avgMoveThresholdPct: number;
  avgAdverseAllowancePct: number;
  regimeCounts: Record<string, number>;
  sessionCounts: Record<string, number>;
  volatilityCounts: Record<string, number>;
}

export interface RegimeMetricsBySplit {
  validation: Record<string, SegmentClassificationMetrics>;
  test: Record<string, SegmentClassificationMetrics>;
}

export interface ModelEligibility {
  approved: boolean;
  score: number;
  reasons: string[];
  thresholds: {
    minimumExamples: number;
    minValidationPrecision: number;
    minTestPrecision: number;
    maxValidationBrier: number;
    maxTestBrier: number;
    maxOverfitGap: number;
    minRobustSegments: number;
  };
}

export interface LogisticModelArtifact {
  side: "long" | "short";
  horizonBars: number;
  moveThresholdPct: number;
  featureNames: string[];
  means: number[];
  stdDevs: number[];
  weights: number[];
  bias: number;
  threshold: number;
  epochs: number;
  learningRate: number;
  regularization: number;
  metrics: DatasetSplitMetrics;
  dataset: DatasetProfile;
  regimeMetrics: RegimeMetricsBySplit;
  eligibility: ModelEligibility;
}

export interface TrainLogisticOptions {
  side: "long" | "short";
  horizonBars?: number;
  moveThresholdPct?: number;
  feeBps?: number;
  slippageBps?: number;
  epochs?: number;
  learningRate?: number;
  regularization?: number;
  microstructureHistory?: HistoricalMicrostructureSnapshot[];
  microstructureLookbackMs?: number;
}

const DEFAULT_OBJECTIVE: SweepObjective = "composite";

function round(value: number, precision = 4) {
  return Number(value.toFixed(precision));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumber(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function averageDefined(values: Array<number | null | undefined>) {
  const filtered = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  return filtered.length === 0 ? 0 : average(filtered);
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function safeLog10(value: number | null | undefined) {
  const numeric = finiteNumber(value);
  return numeric === null || numeric <= 0 ? 0 : Math.log10(numeric + 1);
}

function sigmoid(value: number) {
  if (value < -35) return 0;
  if (value > 35) return 1;
  return 1 / (1 + Math.exp(-value));
}

function deriveSessionBucket(hourUtc: number) {
  if (hourUtc >= 0 && hourUtc < 7) return "asia" as const;
  if (hourUtc >= 7 && hourUtc < 13) return "europe" as const;
  if (hourUtc >= 13 && hourUtc < 21) return "us" as const;
  return "offhours" as const;
}

function deriveVolatilityBucket(tf1AtrPct: number, tf15RealizedVolPct: number) {
  const combined = tf1AtrPct + tf15RealizedVolPct * 0.35;
  if (combined < 0.35) return "compressed" as const;
  if (combined > 0.95) return "expanded" as const;
  return "normal" as const;
}

function buildRegimeSegment(
  regime: RegimeKind,
  sessionBucket: ReturnType<typeof deriveSessionBucket>,
  volatilityBucket: ReturnType<typeof deriveVolatilityBucket>,
  setupType: StrategySetup,
) {
  return `${regime}|${setupType}|${sessionBucket}|${volatilityBucket}`;
}

function cartesianProduct(inputs: Array<Array<number | boolean>>): Array<Array<number | boolean>> {
  return inputs.reduce<Array<Array<number | boolean>>>(
    (accumulator, values) => accumulator.flatMap((prefix) => values.map((value) => [...prefix, value])),
    [[]],
  );
}

function settingsSummary(result: BacktestResult) {
  return {
    totalPnl: result.totalPnl,
    trades: result.trades,
    winRate: result.winRate,
    maxDrawdown: result.maxDrawdown,
    sharpe: result.sharpe,
    sortino: result.sortino,
    calmar: result.calmar,
    profitFactor: result.profitFactor,
    expectancy: result.expectancy,
  };
}

export function scoreBacktest(result: BacktestResult, objective: SweepObjective = DEFAULT_OBJECTIVE) {
  switch (objective) {
    case "net_profit":
      return result.totalPnl;
    case "sharpe":
      return result.sharpe;
    case "sortino":
      return result.sortino;
    case "calmar":
      return result.calmar;
    case "profit_factor":
      return result.profitFactor;
    case "expectancy":
      return result.expectancy;
    case "composite":
    default:
      return (
        result.totalPnl * 0.02 +
        result.sharpe * 1.6 +
        result.sortino * 1.2 +
        result.calmar * 0.8 +
        result.profitFactor * 1.1 +
        result.expectancy * 0.15 +
        result.winRate * 0.02 -
        result.maxDrawdown * 0.18
      );
  }
}

export function buildParameterGrid(baseSettings: StrategySettings, parameterSpace: ParameterSpace, maxEvaluations?: number) {
  const dimensions = [
    parameterSpace.riskPct ?? [baseSettings.riskPct],
    parameterSpace.leverage ?? [baseSettings.leverage],
    parameterSpace.minConfidence ?? [baseSettings.minConfidence],
    parameterSpace.dailyLossLimitPct ?? [baseSettings.dailyLossLimitPct],
    parameterSpace.maxConsecutiveLosses ?? [baseSettings.maxConsecutiveLosses],
    parameterSpace.allowTrendTrades ?? [baseSettings.allowTrendTrades],
    parameterSpace.allowMeanReversionTrades ?? [baseSettings.allowMeanReversionTrades],
    parameterSpace.feeBps ?? [baseSettings.feeBps],
    parameterSpace.slippageBps ?? [baseSettings.slippageBps],
    parameterSpace.maxBarsInTrade ?? [baseSettings.maxBarsInTrade],
    parameterSpace.partialTakeProfitRR ?? [baseSettings.partialTakeProfitRR],
    parameterSpace.allowSessionFilter ?? [baseSettings.allowSessionFilter],
    parameterSpace.sessionStartHourUtc ?? [baseSettings.sessionStartHourUtc],
    parameterSpace.sessionEndHourUtc ?? [baseSettings.sessionEndHourUtc],
  ];

  const combinations = cartesianProduct(dimensions);
  const selected = maxEvaluations && combinations.length > maxEvaluations
    ? combinations.slice(0, maxEvaluations)
    : combinations;

  return selected.map((values) => ({
    riskPct: Number(values[0]),
    leverage: Number(values[1]),
    minConfidence: Number(values[2]),
    dailyLossLimitPct: Number(values[3]),
    maxConsecutiveLosses: Number(values[4]),
    allowTrendTrades: Boolean(values[5]),
    allowMeanReversionTrades: Boolean(values[6]),
    feeBps: Number(values[7]),
    slippageBps: Number(values[8]),
    maxBarsInTrade: Number(values[9]),
    partialTakeProfitRR: Number(values[10]),
    allowSessionFilter: Boolean(values[11]),
    sessionStartHourUtc: Number(values[12]),
    sessionEndHourUtc: Number(values[13]),
  }));
}

export function runParameterSweep(
  candles: MarketCandle[],
  candidates: StrategySettings[],
  objective: SweepObjective = DEFAULT_OBJECTIVE,
  startingBalance = 10_000,
) {
  return candidates
    .map((settings) => {
      const result = simulateStrategy(candles, settings, startingBalance);
      return {
        settings,
        score: round(scoreBacktest(result, objective), 6),
        objective,
        result,
      } satisfies SweepCandidateResult;
    })
    .sort((left, right) => right.score - left.score);
}

export function walkForwardOptimize(
  candles: MarketCandle[],
  baseSettings: StrategySettings,
  parameterSpace: ParameterSpace,
  config: WalkForwardConfig,
): WalkForwardResult {
  const objective = config.objective ?? DEFAULT_OBJECTIVE;
  const candidates = buildParameterGrid(baseSettings, parameterSpace, config.maxEvaluations);
  const folds: WalkForwardFold[] = [];
  const start = config.trainingCandles;

  for (
    let testStartIndex = start;
    testStartIndex + config.validationCandles <= candles.length;
    testStartIndex += config.stepCandles
  ) {
    const trainStartIndex = testStartIndex - config.trainingCandles;
    const trainEndIndex = testStartIndex;
    const testEndIndex = testStartIndex + config.validationCandles;
    const trainingSlice = candles.slice(trainStartIndex, trainEndIndex);
    const testSlice = candles.slice(testStartIndex, testEndIndex);
    const sweep = runParameterSweep(trainingSlice, candidates, objective, config.startingBalance);
    const best = sweep[0];
    const testResult = simulateStrategy(testSlice, best.settings, config.startingBalance ?? 10_000);

    folds.push({
      fold: folds.length + 1,
      trainStartIndex,
      trainEndIndex: trainEndIndex - 1,
      testStartIndex,
      testEndIndex: testEndIndex - 1,
      bestSettings: best.settings,
      trainScore: best.score,
      testScore: round(scoreBacktest(testResult, objective), 6),
      trainResult: settingsSummary(best.result),
      testResult: settingsSummary(testResult),
    });
  }

  const totalTestPnl = folds.reduce((sum, fold) => sum + fold.testResult.totalPnl, 0);
  const totalTrades = folds.reduce((sum, fold) => sum + fold.testResult.trades, 0);
  const totalWins = folds.reduce((sum, fold) => sum + (fold.testResult.winRate / 100) * fold.testResult.trades, 0);

  return {
    objective,
    candidatesEvaluated: candidates.length,
    folds,
    aggregate: {
      totalTestPnl: round(totalTestPnl, 2),
      avgTestScore: round(average(folds.map((fold) => fold.testScore)), 4),
      avgTestSharpe: round(average(folds.map((fold) => fold.testResult.sharpe)), 4),
      avgTestSortino: round(average(folds.map((fold) => fold.testResult.sortino)), 4),
      avgTestDrawdown: round(average(folds.map((fold) => fold.testResult.maxDrawdown)), 4),
      winRate: totalTrades === 0 ? 0 : round((totalWins / totalTrades) * 100, 2),
      trades: totalTrades,
    },
  };
}

export function prepareHistoricalMicrostructure(history: HistoricalMicrostructureSnapshot[] = []) {
  return [...history]
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
}

interface HistoricalMicrostructureContext {
  current: MarketMicrostructure | null;
  recent: HistoricalMicrostructureSnapshot[];
}

function upperBoundByTimestamp(history: HistoricalMicrostructureSnapshot[], timestamp: number) {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (history[mid].timestamp <= timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function resolveHistoricalMicrostructureContext(
  history: HistoricalMicrostructureSnapshot[] = [],
  timestamp: number | undefined,
  liveMicrostructure: MarketMicrostructure | null | undefined,
  lookbackMs = 15 * 60 * 1000,
): HistoricalMicrostructureContext {
  if (timestamp === undefined || history.length === 0) {
    return {
      current: liveMicrostructure ?? null,
      recent: liveMicrostructure && timestamp !== undefined
        ? [{ timestamp, microstructure: liveMicrostructure, source: "live" }]
        : [],
    };
  }

  const endExclusive = upperBoundByTimestamp(history, timestamp);
  const lowerBoundTimestamp = timestamp - lookbackMs;
  const startInclusive = upperBoundByTimestamp(history, lowerBoundTimestamp - 1);
  const recentBase = history.slice(startInclusive, endExclusive);
  const recent = liveMicrostructure
    ? [...recentBase, { timestamp, microstructure: liveMicrostructure, source: "live" }]
    : recentBase;
  const current = liveMicrostructure ?? recentBase[recentBase.length - 1]?.microstructure ?? null;

  return { current, recent };
}

function extractMicrostructureFeatures(context: HistoricalMicrostructureContext) {
  const current = context.current;
  const recent = context.recent;
  const currentPrimaryImbalance = current?.primaryBook?.imbalance ?? 0;
  const currentSecondaryImbalance = current?.secondaryBook?.imbalance ?? 0;
  const currentSpread = current?.primaryBook?.spreadBps ?? 0;
  const currentBasis = current?.crossVenueBasisBps ?? 0;
  const currentCrowding = current?.crowdingScore ?? 0;
  const currentPressure = averageDefined([
    currentPrimaryImbalance,
    currentSecondaryImbalance,
    current?.takerImbalance,
    current?.liquidationBias,
  ]);
  const recentPressure = recent.map((entry) =>
    averageDefined([
      entry.microstructure?.primaryBook?.imbalance,
      entry.microstructure?.secondaryBook?.imbalance,
      entry.microstructure?.takerImbalance,
      entry.microstructure?.liquidationBias,
    ])
  );
  const firstPressure = recentPressure[0] ?? 0;
  const lastPressure = recentPressure[recentPressure.length - 1] ?? currentPressure;
  const spreadSeries = recent.map((entry) => entry.microstructure?.primaryBook?.spreadBps ?? 0);
  const basisSeries = recent.map((entry) => entry.microstructure?.crossVenueBasisBps ?? 0);
  const crowdingSeries = recent.map((entry) => entry.microstructure?.crowdingScore ?? 0);

  return {
    micro_has_snapshot: current ? 1 : 0,
    micro_snapshot_count: recent.length,
    micro_primary_spread_bps: currentSpread,
    micro_primary_imbalance: currentPrimaryImbalance,
    micro_secondary_spread_bps: current?.secondaryBook?.spreadBps ?? 0,
    micro_secondary_imbalance: currentSecondaryImbalance,
    micro_book_agreement: current
      ? 1 - Math.min(Math.abs(currentPrimaryImbalance - currentSecondaryImbalance), 2) / 2
      : 0,
    micro_funding_rate_pct8h: current?.fundingRatePct8h ?? 0,
    micro_open_interest_log10: safeLog10(current?.openInterestUsd),
    micro_open_interest_change_pct: current?.openInterestChangePct ?? 0,
    micro_long_short_ratio: current?.longShortRatio ?? 1,
    micro_taker_imbalance: current?.takerImbalance ?? 0,
    micro_liquidation_bias: current?.liquidationBias ?? 0,
    micro_liquidation_intensity: current?.liquidationIntensity ?? 0,
    micro_cross_venue_basis_bps: currentBasis,
    micro_crowding_score: currentCrowding,
    micro_primary_imbalance_mean: averageDefined(recent.map((entry) => entry.microstructure?.primaryBook?.imbalance)),
    micro_taker_imbalance_mean: averageDefined(recent.map((entry) => entry.microstructure?.takerImbalance)),
    micro_liquidation_bias_mean: averageDefined(recent.map((entry) => entry.microstructure?.liquidationBias)),
    micro_liquidation_intensity_mean: averageDefined(recent.map((entry) => entry.microstructure?.liquidationIntensity)),
    micro_spread_bps_mean: averageDefined(recent.map((entry) => entry.microstructure?.primaryBook?.spreadBps)),
    micro_basis_bps_mean: averageDefined(recent.map((entry) => entry.microstructure?.crossVenueBasisBps)),
    micro_open_interest_change_mean: averageDefined(recent.map((entry) => entry.microstructure?.openInterestChangePct)),
    micro_crowding_mean: averageDefined(recent.map((entry) => entry.microstructure?.crowdingScore)),
    micro_pressure_alignment: currentPressure,
    micro_pressure_trend: lastPressure - firstPressure,
    micro_crowding_change: (crowdingSeries[crowdingSeries.length - 1] ?? currentCrowding) - (crowdingSeries[0] ?? currentCrowding),
    micro_spread_change_bps: (spreadSeries[spreadSeries.length - 1] ?? currentSpread) - (spreadSeries[0] ?? currentSpread),
    micro_basis_change_bps: (basisSeries[basisSeries.length - 1] ?? currentBasis) - (basisSeries[0] ?? currentBasis),
  };
}

export const TRAINING_FEATURE_NAMES = [
  "tf1_rsi",
  "tf1_atr_pct",
  "tf1_realized_vol_pct",
  "tf1_adx",
  "tf1_ema_spread_pct",
  "tf1_ema_slope_pct",
  "tf1_trend_efficiency",
  "tf1_dist_vwap_atr",
  "tf1_bollinger_z",
  "tf1_bollinger_width_pct",
  "tf1_momentum1",
  "tf1_momentum3",
  "tf1_momentum5",
  "tf1_range_pct",
  "tf1_close_location",
  "tf1_body_to_range",
  "tf1_volume_ratio",
  "tf5_ema_spread_pct",
  "tf5_ema_slope_pct",
  "tf5_rsi",
  "tf5_adx",
  "tf5_realized_vol_pct",
  "tf5_trend_efficiency",
  "tf5_dist_vwap_atr",
  "tf5_momentum3",
  "tf15_ema_spread_pct",
  "tf15_ema_slope_pct",
  "tf15_rsi",
  "tf15_adx",
  "tf15_realized_vol_pct",
  "tf15_trend_efficiency",
  "tf15_dist_vwap_atr",
  "regime_trend_long",
  "regime_trend_short",
  "regime_range",
  "multi_tf_alignment",
  "momentum_stack",
  "volatility_ratio",
  "volume_spike",
  "wick_bullish",
  "wick_bearish",
  "hour_utc",
  "session_asia",
  "session_europe",
  "session_us",
  "session_offhours",
  "decision_confidence",
  "decision_risk_reward",
  "decision_is_long",
  "decision_is_short",
  "decision_setup_trend",
  "decision_setup_mean_reversion",
  "quality_regime",
  "quality_setup",
  "quality_execution",
  "quality_composite",
  "quality_confidence_gap",
  "expected_cost_bps",
  "expected_edge_bps",
  "edge_to_cost_ratio",
  "risk_multiplier",
  "leverage_multiplier",
  "regime_strength",
  "trend_hierarchy",
  "mean_reversion_stretch",
  "structure_pressure",
  "micro_has_snapshot",
  "micro_snapshot_count",
  "micro_primary_spread_bps",
  "micro_primary_imbalance",
  "micro_secondary_spread_bps",
  "micro_secondary_imbalance",
  "micro_book_agreement",
  "micro_funding_rate_pct8h",
  "micro_open_interest_log10",
  "micro_open_interest_change_pct",
  "micro_long_short_ratio",
  "micro_taker_imbalance",
  "micro_liquidation_bias",
  "micro_liquidation_intensity",
  "micro_cross_venue_basis_bps",
  "micro_crowding_score",
  "micro_primary_imbalance_mean",
  "micro_taker_imbalance_mean",
  "micro_liquidation_bias_mean",
  "micro_liquidation_intensity_mean",
  "micro_spread_bps_mean",
  "micro_basis_bps_mean",
  "micro_open_interest_change_mean",
  "micro_crowding_mean",
  "micro_pressure_alignment",
  "micro_pressure_trend",
  "micro_pressure_divergence",
  "micro_oi_crowding_interaction",
  "micro_basis_taker_alignment",
  "micro_liquidation_pressure_change",
  "micro_crowding_change",
  "micro_spread_change_bps",
  "micro_basis_change_bps",
] as const;

export function extractFeatureMap(
  candles: MarketCandle[],
  index: number,
  settings: StrategySettings,
  options: FeatureExtractionOptions = {},
) {
  const timestamp = candles[index]?.timestamp;
  const microContext = resolveHistoricalMicrostructureContext(
    options.microstructureHistory ?? [],
    timestamp,
    options.liveMicrostructure ?? null,
    options.microstructureLookbackMs ?? 15 * 60 * 1000,
  );
  const state = buildMarketState(candles.slice(0, index + 1), null, null, microContext.current);
  const decision = deriveAdvancedDecision(state, settings, {
    startingBalance: 10_000,
    currentBalance: 10_000,
    dailyRealizedPnl: 0,
    consecutiveLosses: 0,
  });

  const tf1 = state.timeframe1m;
  const tf5 = state.timeframe5m;
  const tf15 = state.timeframe15m;
  const sessionBucket = deriveSessionBucket(state.latestHourUtc ?? 0);
  const featureValue = (key: string) => {
    const value = decision.features[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const microFeatures = extractMicrostructureFeatures(microContext);
  const regimeStrength = clamp(
    Math.abs(tf15.emaSpreadPct) * 18 + tf15.adx * 0.8 + tf15.trendEfficiency * 22 + Math.abs(tf5.emaSlopePct) * 12,
    0,
    100,
  );
  const trendHierarchy = Math.sign(tf1.emaSpreadPct) * Math.sign(tf5.emaSpreadPct) + Math.sign(tf5.emaSpreadPct) * Math.sign(tf15.emaSpreadPct);
  const meanReversionStretch = Math.abs(tf1.bollingerZ) + Math.abs(tf1.distFromVwapAtr) + Math.abs(tf1.closeLocation - 0.5) * 2;
  const structurePressure =
    (tf1.closeLocation - 0.5) * 2 +
    (tf1.bodyToRange - 0.5) * 1.4 +
    (tf1.wickBullish ? 0.35 : 0) -
    (tf1.wickBearish ? 0.35 : 0);
  const expectedCostBps = featureValue("expectedCostBps");
  const expectedEdgeBps = decision.riskReward * decision.takeProfitPct * 10_000 - expectedCostBps;
  const featureMap: Record<string, number> = {
    tf1_rsi: tf1.rsi,
    tf1_atr_pct: tf1.atrPct * 100,
    tf1_realized_vol_pct: tf1.realizedVolPct,
    tf1_adx: tf1.adx,
    tf1_ema_spread_pct: tf1.emaSpreadPct,
    tf1_ema_slope_pct: tf1.emaSlopePct,
    tf1_trend_efficiency: tf1.trendEfficiency,
    tf1_dist_vwap_atr: tf1.distFromVwapAtr,
    tf1_bollinger_z: tf1.bollingerZ,
    tf1_bollinger_width_pct: tf1.bollingerWidthPct,
    tf1_momentum1: tf1.momentum1Pct,
    tf1_momentum3: tf1.momentum3Pct,
    tf1_momentum5: tf1.momentum5Pct,
    tf1_range_pct: tf1.rangePct,
    tf1_close_location: tf1.closeLocation,
    tf1_body_to_range: tf1.bodyToRange,
    tf1_volume_ratio: tf1.volumeRatio,
    tf5_ema_spread_pct: tf5.emaSpreadPct,
    tf5_ema_slope_pct: tf5.emaSlopePct,
    tf5_rsi: tf5.rsi,
    tf5_adx: tf5.adx,
    tf5_realized_vol_pct: tf5.realizedVolPct,
    tf5_trend_efficiency: tf5.trendEfficiency,
    tf5_dist_vwap_atr: tf5.distFromVwapAtr,
    tf5_momentum3: tf5.momentum3Pct,
    tf15_ema_spread_pct: tf15.emaSpreadPct,
    tf15_ema_slope_pct: tf15.emaSlopePct,
    tf15_rsi: tf15.rsi,
    tf15_adx: tf15.adx,
    tf15_realized_vol_pct: tf15.realizedVolPct,
    tf15_trend_efficiency: tf15.trendEfficiency,
    tf15_dist_vwap_atr: tf15.distFromVwapAtr,
    regime_trend_long: decision.regime === "trend_long" ? 1 : 0,
    regime_trend_short: decision.regime === "trend_short" ? 1 : 0,
    regime_range: decision.regime === "range" ? 1 : 0,
    multi_tf_alignment:
      Math.sign(tf1.emaSpreadPct) * 1 +
      Math.sign(tf5.emaSpreadPct) * 1.5 +
      Math.sign(tf15.emaSpreadPct) * 2,
    momentum_stack: tf1.momentum1Pct + tf1.momentum3Pct + tf5.momentum3Pct + tf15.momentum3Pct,
    volatility_ratio: tf15.atrPct === 0 ? 0 : tf1.atrPct / tf15.atrPct,
    volume_spike: tf1.volumeSpike ? 1 : 0,
    wick_bullish: tf1.wickBullish ? 1 : 0,
    wick_bearish: tf1.wickBearish ? 1 : 0,
    hour_utc: state.latestHourUtc ?? 0,
    session_asia: sessionBucket === "asia" ? 1 : 0,
    session_europe: sessionBucket === "europe" ? 1 : 0,
    session_us: sessionBucket === "us" ? 1 : 0,
    session_offhours: sessionBucket === "offhours" ? 1 : 0,
    decision_confidence: decision.confidence,
    decision_risk_reward: decision.riskReward,
    decision_is_long: decision.action === "long" ? 1 : 0,
    decision_is_short: decision.action === "short" ? 1 : 0,
    decision_setup_trend: decision.setupType === "trend" ? 1 : 0,
    decision_setup_mean_reversion: decision.setupType === "mean_reversion" ? 1 : 0,
    quality_regime: featureValue("regimeQuality"),
    quality_setup: featureValue("setupQuality"),
    quality_execution: featureValue("executionQuality"),
    quality_composite: featureValue("qualityScore"),
    quality_confidence_gap: featureValue("qualityScore") - decision.confidence,
    expected_cost_bps: expectedCostBps,
    expected_edge_bps: expectedEdgeBps,
    edge_to_cost_ratio: featureValue("edgeToCostRatio"),
    risk_multiplier: featureValue("riskMultiplier"),
    leverage_multiplier: featureValue("leverageMultiplier"),
    regime_strength: regimeStrength,
    trend_hierarchy: trendHierarchy,
    mean_reversion_stretch: meanReversionStretch,
    structure_pressure: structurePressure,
    ...microFeatures,
    micro_pressure_divergence: Math.abs((microContext.current?.primaryBook?.imbalance ?? 0) - (microContext.current?.secondaryBook?.imbalance ?? 0)),
    micro_oi_crowding_interaction: (microContext.current?.openInterestChangePct ?? 0) * (microContext.current?.crowdingScore ?? 0),
    micro_basis_taker_alignment: (microContext.current?.crossVenueBasisBps ?? 0) * (microContext.current?.takerImbalance ?? 0),
    micro_liquidation_pressure_change:
      (microContext.current?.liquidationBias ?? 0) *
      ((microFeatures.micro_pressure_trend ?? 0) + (microContext.current?.liquidationIntensity ?? 0)),
  };

  return {
    state,
    decision,
    featureMap,
    features: TRAINING_FEATURE_NAMES.map((name) => featureMap[name] ?? 0),
  };
}

export function buildTrainingExamples(
  candles: MarketCandle[],
  settings: StrategySettings,
  horizonBars = 15,
  moveThresholdPct = 0.18,
  feeBps = 4,
  slippageBps = 3,
  options: FeatureExtractionOptions = {},
) {
  const normalized = normalizeCandles(candles);
  const preparedMicrostructureHistory = prepareHistoricalMicrostructure(options.microstructureHistory ?? []);
  const warmup = 15 * 50;
  const costPct = (feeBps + slippageBps) / 100;
  const rows: TrainingExample[] = [];

  for (let index = warmup; index + horizonBars < normalized.length; index += 1) {
    const current = normalized[index];
    const futureSlice = normalized.slice(index + 1, index + 1 + horizonBars);
    const futureClose = futureSlice[futureSlice.length - 1].close;
    const futureMaxHigh = Math.max(...futureSlice.map((candle) => candle.high));
    const futureMinLow = Math.min(...futureSlice.map((candle) => candle.low));
    const futureReturnPct = ((futureClose - current.close) / current.close) * 100;
    const futureMaxUpPct = ((futureMaxHigh - current.close) / current.close) * 100;
    const futureMaxDownPct = ((current.close - futureMinLow) / current.close) * 100;
    const { decision, featureMap, features } = extractFeatureMap(normalized, index, settings, {
      ...options,
      microstructureHistory: preparedMicrostructureHistory,
    });
    const expectedCostPct = Math.max((featureMap.expected_cost_bps ?? 0) / 100, costPct);
    const dynamicMoveThresholdPct = Math.max(
      moveThresholdPct,
      expectedCostPct * 1.8,
      Math.abs(featureMap.tf1_atr_pct ?? 0) * 0.85,
      Math.abs(featureMap.tf1_realized_vol_pct ?? 0) * 0.45,
    );
    const adverseAllowancePct = Math.max(dynamicMoveThresholdPct * 1.3, expectedCostPct * 2.1, 0.12);
    const netFutureReturnPct = futureReturnPct - expectedCostPct;
    const labelLong = (
      netFutureReturnPct >= dynamicMoveThresholdPct &&
      futureMaxDownPct <= adverseAllowancePct
    ) || (
      futureMaxUpPct - expectedCostPct >= dynamicMoveThresholdPct * 1.1 &&
      futureMaxDownPct <= adverseAllowancePct * 1.1 &&
      futureReturnPct >= -(dynamicMoveThresholdPct * 0.2)
    ) ? 1 : 0;
    const labelShort = (
      -futureReturnPct - expectedCostPct >= dynamicMoveThresholdPct &&
      futureMaxUpPct <= adverseAllowancePct
    ) || (
      futureMaxDownPct - expectedCostPct >= dynamicMoveThresholdPct * 1.1 &&
      futureMaxUpPct <= adverseAllowancePct * 1.1 &&
      futureReturnPct <= dynamicMoveThresholdPct * 0.2
    ) ? 1 : 0;
    const sessionBucket = deriveSessionBucket(featureMap.hour_utc ?? 0);
    const volatilityBucket = deriveVolatilityBucket(featureMap.tf1_atr_pct ?? 0, featureMap.tf15_realized_vol_pct ?? 0);

    rows.push({
      timestamp: current.timestamp ?? null,
      regime: decision.regime,
      regimeSegment: buildRegimeSegment(decision.regime, sessionBucket, volatilityBucket, decision.setupType),
      sessionBucket,
      volatilityBucket,
      decision,
      futureReturnPct: round(futureReturnPct, 6),
      netFutureReturnPct: round(netFutureReturnPct, 6),
      futureMaxUpPct: round(futureMaxUpPct, 6),
      futureMaxDownPct: round(futureMaxDownPct, 6),
      dynamicMoveThresholdPct: round(dynamicMoveThresholdPct, 6),
      adverseAllowancePct: round(adverseAllowancePct, 6),
      labelLong,
      labelShort,
      featureMap,
      features,
    });
  }

  return rows;
}

function splitExamples(examples: TrainingExample[]) {
  const trainEnd = Math.floor(examples.length * 0.7);
  const validationEnd = Math.floor(examples.length * 0.85);
  return {
    train: examples.slice(0, trainEnd),
    validation: examples.slice(trainEnd, validationEnd),
    test: examples.slice(validationEnd),
  };
}

function summarizeDataset(examples: TrainingExample[], side: "long" | "short", splits: ReturnType<typeof splitExamples>): DatasetProfile {
  const labels = labelsForSide(examples, side);
  const timestamps = examples
    .map((example) => example.timestamp)
    .filter((timestamp): timestamp is number => timestamp !== null && Number.isFinite(timestamp));
  const coverageDays = timestamps.length >= 2
    ? round((timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000), 4)
    : 0;

  return {
    totalExamples: examples.length,
    trainExamples: splits.train.length,
    validationExamples: splits.validation.length,
    testExamples: splits.test.length,
    positiveRate: round(average(labels), 6),
    coverageDays,
    avgFutureReturnPct: round(average(examples.map((example) => example.futureReturnPct)), 6),
    avgNetFutureReturnPct: round(average(examples.map((example) => example.netFutureReturnPct)), 6),
    avgMoveThresholdPct: round(average(examples.map((example) => example.dynamicMoveThresholdPct)), 6),
    avgAdverseAllowancePct: round(average(examples.map((example) => example.adverseAllowancePct)), 6),
    regimeCounts: countBy(examples.map((example) => example.regime)),
    sessionCounts: countBy(examples.map((example) => example.sessionBucket)),
    volatilityCounts: countBy(examples.map((example) => example.volatilityBucket)),
  };
}

function evaluateSegments(
  examples: TrainingExample[],
  rows: number[][],
  labels: number[],
  weights: number[],
  bias: number,
  threshold: number,
  side: "long" | "short",
) {
  const groups = new Map<string, { rows: number[][]; labels: number[]; examples: TrainingExample[]; probabilities: number[] }>();

  rows.forEach((row, index) => {
    const example = examples[index];
    const key = example.regimeSegment;
    const existing = groups.get(key) ?? { rows: [], labels: [], examples: [], probabilities: [] };
    existing.rows.push(row);
    existing.labels.push(labels[index]);
    existing.examples.push(example);
    existing.probabilities.push(sigmoid(dotProduct(row, weights) + bias));
    groups.set(key, existing);
  });

  return Object.fromEntries(
    [...groups.entries()]
      .sort((left, right) => right[1].rows.length - left[1].rows.length)
      .map(([segment, group]) => {
        const metrics = evaluateLogistic(group.rows, group.labels, weights, bias, threshold);
        const opportunityKey = side === "long" ? "futureMaxUpPct" : "futureMaxDownPct";
        const adverseKey = side === "long" ? "futureMaxDownPct" : "futureMaxUpPct";

        return [segment, {
          ...metrics,
          samples: group.rows.length,
          labelRate: round(average(group.labels), 6),
          avgFutureReturnPct: round(average(group.examples.map((example) => example.futureReturnPct)), 6),
          avgNetFutureReturnPct: round(average(group.examples.map((example) => example.netFutureReturnPct)), 6),
          avgOpportunityPct: round(average(group.examples.map((example) => example[opportunityKey])), 6),
          avgAdversePct: round(average(group.examples.map((example) => example[adverseKey])), 6),
          avgProbability: round(average(group.probabilities), 6),
        } satisfies SegmentClassificationMetrics];
      }),
  ) as Record<string, SegmentClassificationMetrics>;
}

function evaluateModelEligibility(
  dataset: DatasetProfile,
  metrics: DatasetSplitMetrics,
  regimeMetrics: RegimeMetricsBySplit,
): ModelEligibility {
  const thresholds = {
    minimumExamples: 1_200,
    minValidationPrecision: 0.5,
    minTestPrecision: 0.5,
    maxValidationBrier: 0.24,
    maxTestBrier: 0.24,
    maxOverfitGap: 0.2,
    minRobustSegments: 2,
  };
  const reasons: string[] = [];
  const robustSegments = Object.values(regimeMetrics.test).filter(
    (segment) => segment.samples >= 25 && segment.precision >= 0.5,
  ).length;
  const overfitGap = metrics.train.f1 - metrics.validation.f1;

  if (dataset.totalExamples < thresholds.minimumExamples) {
    reasons.push(`dataset too small (${dataset.totalExamples} < ${thresholds.minimumExamples})`);
  }
  if (dataset.positiveRate < 0.025 || dataset.positiveRate > 0.45) {
    reasons.push(`label distribution unstable (${(dataset.positiveRate * 100).toFixed(1)}%)`);
  }
  if (metrics.validation.precision < thresholds.minValidationPrecision) {
    reasons.push(`validation precision ${metrics.validation.precision.toFixed(2)} below gate`);
  }
  if (metrics.test.precision < thresholds.minTestPrecision) {
    reasons.push(`test precision ${metrics.test.precision.toFixed(2)} below gate`);
  }
  if (metrics.validation.brier > thresholds.maxValidationBrier) {
    reasons.push(`validation brier ${metrics.validation.brier.toFixed(3)} above gate`);
  }
  if (metrics.test.brier > thresholds.maxTestBrier) {
    reasons.push(`test brier ${metrics.test.brier.toFixed(3)} above gate`);
  }
  if (overfitGap > thresholds.maxOverfitGap) {
    reasons.push(`overfit gap ${overfitGap.toFixed(2)} above gate`);
  }
  if (robustSegments < thresholds.minRobustSegments) {
    reasons.push(`only ${robustSegments} robust test segments`);
  }

  const score = round(
    dataset.totalExamples / 1_000 * 0.25 +
    metrics.validation.precision * 25 +
    metrics.test.precision * 30 +
    metrics.validation.f1 * 14 +
    metrics.test.f1 * 16 +
    (1 - metrics.validation.brier) * 8 +
    (1 - metrics.test.brier) * 8 +
    robustSegments * 2 -
    Math.max(overfitGap, 0) * 12,
    4,
  );

  return {
    approved: reasons.length === 0,
    score,
    reasons,
    thresholds,
  };
}

function normalizeMatrix(rows: number[][]) {
  if (rows.length === 0) {
    return { means: [], stdDevs: [], normalized: rows };
  }

  const width = rows[0].length;
  const means = Array.from({ length: width }, (_, featureIndex) =>
    average(rows.map((row) => row[featureIndex])),
  );
  const stdDevs = Array.from({ length: width }, (_, featureIndex) => {
    const mean = means[featureIndex];
    const variance = average(rows.map((row) => (row[featureIndex] - mean) ** 2));
    return Math.sqrt(variance) || 1;
  });
  const normalized = rows.map((row) =>
    row.map((value, featureIndex) => (value - means[featureIndex]) / stdDevs[featureIndex]),
  );

  return { means, stdDevs, normalized };
}

function applyNormalization(rows: number[][], means: number[], stdDevs: number[]) {
  return rows.map((row) =>
    row.map((value, featureIndex) => (value - means[featureIndex]) / (stdDevs[featureIndex] || 1)),
  );
}

function dotProduct(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function labelsForSide(examples: TrainingExample[], side: "long" | "short") {
  return examples.map((example) => side === "long" ? example.labelLong : example.labelShort);
}

function evaluateLogistic(
  rows: number[][],
  labels: number[],
  weights: number[],
  bias: number,
  threshold: number,
): BinaryClassificationMetrics {
  if (rows.length === 0) {
    return {
      loss: 0,
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      brier: 0,
      positiveRate: 0,
    };
  }

  let correct = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let loss = 0;
  let brier = 0;
  let predictedPositive = 0;

  rows.forEach((row, index) => {
    const probability = sigmoid(dotProduct(row, weights) + bias);
    const label = labels[index];
    const prediction = probability >= threshold ? 1 : 0;
    if (prediction === label) correct += 1;
    if (prediction === 1) predictedPositive += 1;
    if (prediction === 1 && label === 1) truePositive += 1;
    if (prediction === 1 && label === 0) falsePositive += 1;
    if (prediction === 0 && label === 1) falseNegative += 1;
    const clipped = clamp(probability, 0.000001, 0.999999);
    loss += -(label * Math.log(clipped) + (1 - label) * Math.log(1 - clipped));
    brier += (probability - label) ** 2;
  });

  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    loss: round(loss / rows.length, 6),
    accuracy: round(correct / rows.length, 6),
    precision: round(precision, 6),
    recall: round(recall, 6),
    f1: round(f1, 6),
    brier: round(brier / rows.length, 6),
    positiveRate: round(predictedPositive / rows.length, 6),
  };
}

function optimalThreshold(rows: number[][], labels: number[], weights: number[], bias: number) {
  let bestThreshold = 0.5;
  let bestScore = -Infinity;

  for (let threshold = 0.35; threshold <= 0.75; threshold += 0.02) {
    const metrics = evaluateLogistic(rows, labels, weights, bias, threshold);
    const score = metrics.f1 * 2 + metrics.precision + metrics.recall - metrics.loss;
    if (score > bestScore) {
      bestScore = score;
      bestThreshold = round(threshold, 4);
    }
  }

  return bestThreshold;
}

export function trainLogisticModel(
  candles: MarketCandle[],
  settings: StrategySettings,
  options: TrainLogisticOptions,
): LogisticModelArtifact {
  const epochs = options.epochs ?? 220;
  const learningRate = options.learningRate ?? 0.03;
  const regularization = options.regularization ?? 0.0005;
  const horizonBars = options.horizonBars ?? 15;
  const moveThresholdPct = options.moveThresholdPct ?? 0.18;
  const feeBps = options.feeBps ?? settings.feeBps;
  const slippageBps = options.slippageBps ?? settings.slippageBps;
  const examples = buildTrainingExamples(candles, settings, horizonBars, moveThresholdPct, feeBps, slippageBps, {
    microstructureHistory: options.microstructureHistory,
    microstructureLookbackMs: options.microstructureLookbackMs,
  });
  const splits = splitExamples(examples);
  const { train, validation, test } = splits;
  const trainRows = train.map((example) => example.features);
  const validationRows = validation.map((example) => example.features);
  const testRows = test.map((example) => example.features);
  const trainLabels = labelsForSide(train, options.side);
  const validationLabels = labelsForSide(validation, options.side);
  const testLabels = labelsForSide(test, options.side);
  const { means, stdDevs, normalized: normalizedTrain } = normalizeMatrix(trainRows);
  const normalizedValidation = applyNormalization(validationRows, means, stdDevs);
  const normalizedTest = applyNormalization(testRows, means, stdDevs);
  const weights = Array.from({ length: TRAINING_FEATURE_NAMES.length }, () => 0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = Array.from({ length: weights.length }, () => 0);
    let biasGradient = 0;

    normalizedTrain.forEach((row, rowIndex) => {
      const prediction = sigmoid(dotProduct(row, weights) + bias);
      const error = prediction - trainLabels[rowIndex];
      row.forEach((value, featureIndex) => {
        gradients[featureIndex] += error * value;
      });
      biasGradient += error;
    });

    const scale = normalizedTrain.length || 1;
    weights.forEach((_, featureIndex) => {
      weights[featureIndex] -= learningRate * ((gradients[featureIndex] / scale) + regularization * weights[featureIndex]);
    });
    bias -= learningRate * (biasGradient / scale);
  }

  const threshold = optimalThreshold(normalizedValidation, validationLabels, weights, bias);
  const metrics = {
    train: evaluateLogistic(normalizedTrain, trainLabels, weights, bias, threshold),
    validation: evaluateLogistic(normalizedValidation, validationLabels, weights, bias, threshold),
    test: evaluateLogistic(normalizedTest, testLabels, weights, bias, threshold),
  } satisfies DatasetSplitMetrics;
  const dataset = summarizeDataset(examples, options.side, splits);
  const regimeMetrics = {
    validation: evaluateSegments(validation, normalizedValidation, validationLabels, weights, bias, threshold, options.side),
    test: evaluateSegments(test, normalizedTest, testLabels, weights, bias, threshold, options.side),
  } satisfies RegimeMetricsBySplit;
  const eligibility = evaluateModelEligibility(dataset, metrics, regimeMetrics);

  return {
    side: options.side,
    horizonBars,
    moveThresholdPct,
    featureNames: [...TRAINING_FEATURE_NAMES],
    means: means.map((value) => round(value, 6)),
    stdDevs: stdDevs.map((value) => round(value, 6)),
    weights: weights.map((value) => round(value, 6)),
    bias: round(bias, 6),
    threshold,
    epochs,
    learningRate,
    regularization,
    metrics,
    dataset,
    regimeMetrics,
    eligibility,
  };
}

export function predictLogisticProbability(model: LogisticModelArtifact, featureMap: Record<string, number>) {
  const row = model.featureNames.map((name) => featureMap[name] ?? 0);
  const normalized = row.map((value, index) => (value - model.means[index]) / (model.stdDevs[index] || 1));
  return sigmoid(dotProduct(normalized, model.weights) + model.bias);
}
