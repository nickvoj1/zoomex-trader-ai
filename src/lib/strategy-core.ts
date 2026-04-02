export type TradeAction = "long" | "short" | "close" | "hold";
export type PositionSide = "long" | "short" | null;
export type StrategySetup = "trend" | "mean_reversion" | "risk_off" | "manual" | "none";
export type RegimeKind = "trend_long" | "trend_short" | "range" | "mixed";

export interface MarketCandle {
  timestamp?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FrameSnapshot {
  interval: "1m" | "5m" | "15m";
  close: number;
  open: number;
  ema20: number;
  ema50: number;
  emaSpreadPct: number;
  emaSlopePct: number;
  rsi: number;
  atr: number;
  atrPct: number;
  realizedVolPct: number;
  trendEfficiency: number;
  adx: number;
  vwap: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerZ: number;
  bollingerWidthPct: number;
  previousHigh: number;
  previousLow: number;
  momentum1Pct: number;
  momentum3Pct: number;
  momentum5Pct: number;
  rangePct: number;
  closeLocation: number;
  bodyToRange: number;
  volumeRatio: number;
  volumeSpike: boolean;
  distFromVwapAtr: number;
  wickBullish: boolean;
  wickBearish: boolean;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  venue: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  imbalance: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  timestamp?: number;
}

export interface MarketMicrostructure {
  primaryBook: OrderBookSnapshot | null;
  secondaryBook: OrderBookSnapshot | null;
  fundingRatePct8h: number | null;
  openInterestUsd: number | null;
  openInterestChangePct: number | null;
  longShortRatio: number | null;
  takerImbalance: number | null;
  liquidationBias: number | null;
  liquidationIntensity: number | null;
  crossVenueBasisBps: number | null;
  crowdingScore: number | null;
  markPriceUsd?: number | null;
  indexPriceUsd?: number | null;
  premiumIndexBps?: number | null;
  markIndexBasisBps?: number | null;
}

export interface MarketState {
  timeframe1m: FrameSnapshot;
  timeframe5m: FrameSnapshot;
  timeframe15m: FrameSnapshot;
  hasPosition: boolean;
  positionSide: PositionSide;
  activeSetupType?: StrategySetup | null;
  latestTimestamp?: number;
  latestHourUtc: number | null;
  microstructure: MarketMicrostructure | null;
}

export interface SessionRiskState {
  startingBalance: number;
  currentBalance: number;
  dailyRealizedPnl: number;
  consecutiveLosses: number;
}

export interface StrategySettings {
  riskPct: number;
  leverage: number;
  minConfidence: number;
  dailyLossLimitPct: number;
  maxConsecutiveLosses: number;
  allowTrendTrades: boolean;
  allowMeanReversionTrades: boolean;
  feeBps: number;
  slippageBps: number;
  maxBarsInTrade: number;
  partialTakeProfitRR: number;
  allowSessionFilter: boolean;
  sessionStartHourUtc: number;
  sessionEndHourUtc: number;
}

export interface StrategyDecision {
  action: TradeAction;
  confidence: number;
  reasoning: string;
  regime: RegimeKind;
  setupType: StrategySetup;
  stopPct: number;
  takeProfitPct: number;
  riskReward: number;
  features: Record<string, number | boolean | string | null>;
}

export interface PositionSizing {
  sizeBtc: number;
  contracts: number;
  riskAmount: number;
}

export interface SimulatedTrade {
  side: "long" | "short";
  setupType: StrategySetup;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  pnl: number;
  grossPnl: number;
  feesPaid: number;
  slippagePaid: number;
  confidence: number;
  entryTime: number | null;
  exitTime: number | null;
  barsHeld: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  exitReason: string;
}

export interface BacktestResult {
  equity: Array<{ time: string; equity: number }>;
  totalPnl: number;
  trades: number;
  winRate: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  profitFactor: number;
  expectancy: number;
  payoffRatio: number;
  avgTrade: number;
  feesPaid: number;
  tradesLog: SimulatedTrade[];
}

const CONTRACT_SIZE_BTC = 0.0001;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function standardDeviation(values: number[]) {
  if (values.length === 0) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function percentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return 0;
  }
  return ((current - previous) / previous) * 100;
}

function emaSeries(values: number[], period: number) {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const ema: number[] = [values[0]];

  for (let index = 1; index < values.length; index += 1) {
    ema.push(values[index] * multiplier + ema[index - 1] * (1 - multiplier));
  }

  return ema;
}

function rsiSeries(values: number[], period = 14) {
  if (values.length === 0) return [];
  const series = Array.from({ length: values.length }, () => 50);
  if (values.length < period + 1) {
    return series;
  }

  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  series[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    series[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return series;
}

function trueRangeSeries(candles: MarketCandle[]) {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

function wilderSmoothing(values: number[], period: number) {
  const result = Array.from({ length: values.length }, () => 0);
  if (values.length === 0) return result;
  let rolling = values.slice(0, period).reduce((sum, value) => sum + value, 0);

  for (let index = 0; index < values.length; index += 1) {
    if (index < period - 1) {
      result[index] = 0;
      continue;
    }
    if (index === period - 1) {
      result[index] = rolling;
      continue;
    }
    rolling = result[index - 1] - result[index - 1] / period + values[index];
    result[index] = rolling;
  }

  return result;
}

function atrSeries(candles: MarketCandle[], period = 14) {
  const tr = trueRangeSeries(candles);
  const result = Array.from({ length: candles.length }, () => 0);
  if (candles.length < period) {
    return result;
  }

  let currentAtr = average(tr.slice(0, period));
  result[period - 1] = currentAtr;

  for (let index = period; index < tr.length; index += 1) {
    currentAtr = (currentAtr * (period - 1) + tr[index]) / period;
    result[index] = currentAtr;
  }

  return result;
}

function adxSeries(candles: MarketCandle[], period = 14) {
  const length = candles.length;
  const result = Array.from({ length }, () => 0);
  if (length <= period * 2) {
    return result;
  }

  const plusDm = Array.from({ length }, () => 0);
  const minusDm = Array.from({ length }, () => 0);
  const tr = trueRangeSeries(candles);

  for (let index = 1; index < length; index += 1) {
    const upMove = candles[index].high - candles[index - 1].high;
    const downMove = candles[index - 1].low - candles[index].low;
    plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const smoothedTr = wilderSmoothing(tr, period);
  const smoothedPlusDm = wilderSmoothing(plusDm, period);
  const smoothedMinusDm = wilderSmoothing(minusDm, period);
  const dx = Array.from({ length }, () => 0);

  for (let index = period - 1; index < length; index += 1) {
    if (smoothedTr[index] === 0) continue;
    const plusDi = (smoothedPlusDm[index] / smoothedTr[index]) * 100;
    const minusDi = (smoothedMinusDm[index] / smoothedTr[index]) * 100;
    const denominator = plusDi + minusDi;
    dx[index] = denominator === 0 ? 0 : (Math.abs(plusDi - minusDi) / denominator) * 100;
  }

  const start = period * 2 - 2;
  let adx = average(dx.slice(period - 1, start + 1));
  result[start] = adx;

  for (let index = start + 1; index < length; index += 1) {
    adx = ((adx * (period - 1)) + dx[index]) / period;
    result[index] = adx;
  }

  return result;
}

function cumulativeVwapSeries(candles: MarketCandle[]) {
  const result: number[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  candles.forEach((candle) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    result.push(cumulativeVolume === 0 ? candle.close : cumulativePriceVolume / cumulativeVolume);
  });

  return result;
}

function bollinger(values: number[], period = 20, deviation = 2) {
  const upper = Array.from({ length: values.length }, () => 0);
  const lower = Array.from({ length: values.length }, () => 0);
  const zScores = Array.from({ length: values.length }, () => 0);

  for (let index = period - 1; index < values.length; index += 1) {
    const slice = values.slice(index - period + 1, index + 1);
    const mean = average(slice);
    const std = standardDeviation(slice);
    upper[index] = mean + std * deviation;
    lower[index] = mean - std * deviation;
    zScores[index] = std === 0 ? 0 : (values[index] - mean) / std;
  }

  return { upper, lower, zScores };
}

function realizedVolatilityPct(values: number[], lookback = 20) {
  if (values.length < lookback + 1) return 0;
  const start = Math.max(1, values.length - lookback);
  const returns = values.slice(start).map((value, index) => percentChange(value, values[start + index - 1]));
  return standardDeviation(returns);
}

function trendEfficiency(values: number[], lookback = 10) {
  if (values.length < lookback + 1) return 0;
  const slice = values.slice(-(lookback + 1));
  const netChange = Math.abs(slice[slice.length - 1] - slice[0]);
  const pathLength = slice.slice(1).reduce((sum, value, index) => sum + Math.abs(value - slice[index]), 0);
  return pathLength === 0 ? 0 : netChange / pathLength;
}

function emaSlopePct(series: number[], lookback = 5) {
  if (series.length < lookback + 1) return 0;
  const latest = series[series.length - 1];
  const baseline = series[series.length - 1 - lookback];
  return percentChange(latest, baseline);
}

function closeLocation(candle: MarketCandle) {
  const range = Math.max(candle.high - candle.low, 0.0000001);
  return clamp((candle.close - candle.low) / range, 0, 1);
}

function bodyToRange(candle: MarketCandle) {
  const range = Math.max(candle.high - candle.low, 0.0000001);
  return clamp(Math.abs(candle.close - candle.open) / range, 0, 1.5);
}

function relativeVolume(candles: MarketCandle[], lookback = 20) {
  if (candles.length < lookback + 1) return 1;
  const recent = candles.slice(-(lookback + 1), -1).map((candle) => candle.volume);
  const baseline = average(recent);
  return baseline === 0 ? 1 : candles[candles.length - 1].volume / baseline;
}

function isBullishWick(candle: MarketCandle) {
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBottom = Math.min(candle.open, candle.close);
  const lowerWick = bodyBottom - candle.low;
  const body = Math.max(Math.abs(candle.close - candle.open), 0.0000001);
  return lowerWick / body >= 1.5 && candle.close > candle.open;
}

function isBearishWick(candle: MarketCandle) {
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBottom = Math.min(candle.open, candle.close);
  const upperWick = candle.high - bodyTop;
  const body = Math.max(Math.abs(candle.close - candle.open), 0.0000001);
  return upperWick / body >= 1.5 && candle.close < candle.open;
}

function volumeSpike(candles: MarketCandle[], threshold = 1.8) {
  return relativeVolume(candles, 20) > threshold;
}

function safeDivide(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function signed(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function summarizeOrderBook(
  venue: string,
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  timestamp?: number,
): OrderBookSnapshot | null {
  if (bids.length === 0 || asks.length === 0) {
    return null;
  }

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
    return null;
  }

  const midPrice = (bestBid + bestAsk) / 2;
  const spreadBps = safeDivide(bestAsk - bestBid, midPrice) * 10_000;
  const bidDepthUsd = bids.slice(0, 10).reduce((sum, level) => sum + level.price * level.size, 0);
  const askDepthUsd = asks.slice(0, 10).reduce((sum, level) => sum + level.price * level.size, 0);
  const imbalance = safeDivide(bidDepthUsd - askDepthUsd, bidDepthUsd + askDepthUsd);

  return {
    venue,
    bestBid,
    bestAsk,
    midPrice,
    spreadBps: round(spreadBps, 4),
    imbalance: round(imbalance, 4),
    bidDepthUsd: round(bidDepthUsd, 2),
    askDepthUsd: round(askDepthUsd, 2),
    timestamp,
  };
}

export function buildMarketMicrostructure(input: Partial<MarketMicrostructure> = {}): MarketMicrostructure | null {
  const primaryBook = input.primaryBook ?? null;
  const secondaryBook = input.secondaryBook ?? null;
  const primaryMid = primaryBook?.midPrice ?? null;
  const secondaryMid = secondaryBook?.midPrice ?? null;
  const markPriceUsd = input.markPriceUsd ?? null;
  const indexPriceUsd = input.indexPriceUsd ?? null;
  const premiumIndexBps = input.premiumIndexBps ?? null;
  const markIndexBasisBps = input.markIndexBasisBps ?? (
    markPriceUsd !== null && indexPriceUsd !== null && indexPriceUsd !== 0
      ? round(safeDivide(markPriceUsd - indexPriceUsd, indexPriceUsd) * 10_000, 4)
      : null
  );
  const crossVenueBasisBps = input.crossVenueBasisBps ?? markIndexBasisBps ?? (
    primaryMid && secondaryMid
      ? round(safeDivide(primaryMid - secondaryMid, secondaryMid) * 10_000, 4)
      : null
  );
  const crowdingScore = input.crowdingScore ?? round(
    (
      (input.fundingRatePct8h ?? 0) * 18 +
      (input.openInterestChangePct ?? 0) * 0.9 +
      ((input.longShortRatio ?? 1) - 1) * 30 +
      (input.takerImbalance ?? 0) * 35 +
      (input.liquidationBias ?? 0) * 14
    ),
    3,
  );

  if (
    !primaryBook &&
    !secondaryBook &&
    input.fundingRatePct8h === undefined &&
    input.openInterestUsd === undefined &&
    input.openInterestChangePct === undefined &&
    input.longShortRatio === undefined &&
    input.takerImbalance === undefined &&
    input.liquidationBias === undefined &&
    input.liquidationIntensity === undefined &&
    input.crossVenueBasisBps === undefined &&
    input.crowdingScore === undefined &&
    input.markPriceUsd === undefined &&
    input.indexPriceUsd === undefined &&
    input.premiumIndexBps === undefined &&
    input.markIndexBasisBps === undefined
  ) {
    return null;
  }

  return {
    primaryBook,
    secondaryBook,
    fundingRatePct8h: input.fundingRatePct8h ?? null,
    openInterestUsd: input.openInterestUsd ?? null,
    openInterestChangePct: input.openInterestChangePct ?? null,
    longShortRatio: input.longShortRatio ?? null,
    takerImbalance: input.takerImbalance ?? null,
    liquidationBias: input.liquidationBias ?? null,
    liquidationIntensity: input.liquidationIntensity ?? null,
    crossVenueBasisBps,
    crowdingScore,
    markPriceUsd,
    indexPriceUsd,
    premiumIndexBps,
    markIndexBasisBps,
  };
}

export function normalizeCandles(candles: MarketCandle[]) {
  return candles
    .map((candle) => ({
      timestamp: candle.timestamp,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
    }))
    .filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.close))
    .filter((candle) => candle.high >= candle.low);
}

export function aggregateCandles(candles: MarketCandle[], intervalMinutes: number) {
  if (intervalMinutes <= 1) return candles;

  const aggregated: MarketCandle[] = [];
  let currentBucket: number | null = null;
  let current: MarketCandle | null = null;

  candles.forEach((candle, index) => {
    const normalizedTimestamp = candle.timestamp === undefined || !Number.isFinite(candle.timestamp) || candle.timestamp <= 0
      ? undefined
      : candle.timestamp < 1_000_000_000_000
        ? candle.timestamp * 1000
        : candle.timestamp;
    const bucket = normalizedTimestamp !== undefined
      ? Math.floor(normalizedTimestamp / (intervalMinutes * 60 * 1000))
      : Math.floor(index / intervalMinutes);

    if (currentBucket !== bucket || !current) {
      if (current) aggregated.push(current);
      currentBucket = bucket;
      current = {
        timestamp: normalizedTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      return;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  });

  if (current) aggregated.push(current);
  return aggregated;
}

export function frameSnapshot(candles: MarketCandle[], interval: FrameSnapshot["interval"]): FrameSnapshot {
  const closes = candles.map((candle) => candle.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(candles, 14);
  const adx = adxSeries(candles, 14);
  const vwap = cumulativeVwapSeries(candles);
  const bands = bollinger(closes, 20, 2);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2] ?? latest;
  const oneBack = candles[candles.length - 2] ?? latest;
  const threeBack = candles[candles.length - 4] ?? previous;
  const fiveBack = candles[candles.length - 6] ?? previous;
  const latestAtr = atr[atr.length - 1] || Math.abs(latest.close - previous.close) || latest.close * 0.001;
  const currentVwap = vwap[vwap.length - 1] || latest.close;
  const ema20Latest = ema20[ema20.length - 1] || latest.close;
  const ema50Latest = ema50[ema50.length - 1] || latest.close;
  const upperBand = bands.upper[bands.upper.length - 1] || latest.close;
  const lowerBand = bands.lower[bands.lower.length - 1] || latest.close;
  const volumeRatio = relativeVolume(candles, 20);

  return {
    interval,
    close: latest.close,
    open: latest.open,
    ema20: ema20Latest,
    ema50: ema50Latest,
    emaSpreadPct: percentChange(ema20Latest, ema50Latest),
    emaSlopePct: emaSlopePct(ema20, 5),
    rsi: rsi[rsi.length - 1] || 50,
    atr: latestAtr,
    atrPct: latest.close === 0 ? 0 : latestAtr / latest.close,
    realizedVolPct: realizedVolatilityPct(closes, 20),
    trendEfficiency: trendEfficiency(closes, 10),
    adx: adx[adx.length - 1] || 0,
    vwap: currentVwap,
    bollingerUpper: upperBand,
    bollingerLower: lowerBand,
    bollingerZ: bands.zScores[bands.zScores.length - 1] || 0,
    bollingerWidthPct: latest.close === 0 ? 0 : ((upperBand - lowerBand) / latest.close) * 100,
    previousHigh: previous.high,
    previousLow: previous.low,
    momentum1Pct: percentChange(latest.close, oneBack.close),
    momentum3Pct: percentChange(latest.close, threeBack.close),
    momentum5Pct: percentChange(latest.close, fiveBack.close),
    rangePct: latest.close === 0 ? 0 : ((latest.high - latest.low) / latest.close) * 100,
    closeLocation: closeLocation(latest),
    bodyToRange: bodyToRange(latest),
    volumeRatio: volumeRatio,
    volumeSpike: volumeSpike(candles),
    distFromVwapAtr: latestAtr === 0 ? 0 : (latest.close - currentVwap) / latestAtr,
    wickBullish: isBullishWick(latest),
    wickBearish: isBearishWick(latest),
  };
}

export function buildMarketState(
  candles1m: MarketCandle[],
  positionSide: PositionSide,
  setupType?: StrategySetup | null,
  microstructure?: MarketMicrostructure | null,
): MarketState {
  const normalized = normalizeCandles(candles1m);
  const candles5m = aggregateCandles(normalized, 5);
  const candles15m = aggregateCandles(normalized, 15);
  const latestTimestamp = normalized[normalized.length - 1]?.timestamp;

  return {
    timeframe1m: frameSnapshot(normalized, "1m"),
    timeframe5m: frameSnapshot(candles5m, "5m"),
    timeframe15m: frameSnapshot(candles15m, "15m"),
    hasPosition: positionSide !== null,
    positionSide,
    activeSetupType: setupType ?? null,
    latestTimestamp,
    latestHourUtc: latestTimestamp === undefined ? null : new Date(latestTimestamp).getUTCHours(),
    microstructure: microstructure ?? null,
  };
}

function isWithinSessionWindow(hourUtc: number | null, startHourUtc: number, endHourUtc: number) {
  if (hourUtc === null) return true;
  if (startHourUtc === endHourUtc) return true;
  if (startHourUtc < endHourUtc) {
    return hourUtc >= startHourUtc && hourUtc < endHourUtc;
  }
  return hourUtc >= startHourUtc || hourUtc < endHourUtc;
}

function detectRegime(state: MarketState): RegimeKind {
  const tf5 = state.timeframe5m;
  const tf15 = state.timeframe15m;

  const trendLong =
    tf15.ema20 > tf15.ema50 &&
    tf5.ema20 > tf5.ema50 &&
    tf15.adx >= 18 &&
    tf5.adx >= 16 &&
    tf15.emaSlopePct > 0 &&
    tf5.emaSlopePct > 0 &&
    tf15.trendEfficiency >= 0.22;
  const trendShort =
    tf15.ema20 < tf15.ema50 &&
    tf5.ema20 < tf5.ema50 &&
    tf15.adx >= 18 &&
    tf5.adx >= 16 &&
    tf15.emaSlopePct < 0 &&
    tf5.emaSlopePct < 0 &&
    tf15.trendEfficiency >= 0.22;
  const range =
    tf15.adx < 18 &&
    tf5.adx < 18 &&
    Math.abs(tf15.distFromVwapAtr) < 1.1 &&
    tf15.trendEfficiency < 0.4 &&
    tf5.bollingerWidthPct < Math.max(tf15.bollingerWidthPct * 1.35, 1.2);

  if (trendLong) return "trend_long";
  if (trendShort) return "trend_short";
  if (range) return "range";
  return "mixed";
}

function microstructureFeatures(
  microstructure: MarketMicrostructure | null,
): Record<string, number | boolean | string | null> {
  return {
    primarySpreadBps: microstructure?.primaryBook?.spreadBps ?? null,
    primaryImbalance: microstructure?.primaryBook?.imbalance ?? null,
    secondarySpreadBps: microstructure?.secondaryBook?.spreadBps ?? null,
    secondaryImbalance: microstructure?.secondaryBook?.imbalance ?? null,
    fundingRatePct8h: microstructure?.fundingRatePct8h ?? null,
    openInterestUsd: microstructure?.openInterestUsd ? round(microstructure.openInterestUsd, 2) : null,
    openInterestChangePct: microstructure?.openInterestChangePct ?? null,
    longShortRatio: microstructure?.longShortRatio ?? null,
    takerImbalance: microstructure?.takerImbalance ?? null,
    liquidationBias: microstructure?.liquidationBias ?? null,
    liquidationIntensity: microstructure?.liquidationIntensity ?? null,
    crossVenueBasisBps: microstructure?.crossVenueBasisBps ?? null,
    crowdingScore: microstructure?.crowdingScore ?? null,
  };
}

function microstructureRiskGate(state: MarketState) {
  const micro = state.microstructure;
  if (!micro?.primaryBook) {
    return null;
  }

  if (micro.primaryBook.spreadBps >= 7) {
    return {
      reasoning: "Risk-off: market spread is too wide for scalping",
      features: microstructureFeatures(micro),
    };
  }

  if ((micro.crossVenueBasisBps ?? 0) !== 0 && Math.abs(micro.crossVenueBasisBps ?? 0) >= 18) {
    return {
      reasoning: "Risk-off: cross-venue basis is unstable",
      features: microstructureFeatures(micro),
    };
  }

  return null;
}

function microstructureBias(side: "long" | "short", microstructure: MarketMicrostructure | null) {
  const reasons: string[] = [];
  let score = 0;

  if (!microstructure) {
    return { score, reasons };
  }

  const primaryImbalance = microstructure.primaryBook?.imbalance ?? 0;
  const fundingRate = microstructure.fundingRatePct8h ?? 0;
  const oiChange = microstructure.openInterestChangePct ?? 0;
  const longShortRatio = microstructure.longShortRatio ?? 1;
  const takerImbalance = microstructure.takerImbalance ?? 0;
  const liquidationBias = microstructure.liquidationBias ?? 0;
  const liquidationIntensity = microstructure.liquidationIntensity ?? 0;
  const crowdedLong = fundingRate > 0.03 && longShortRatio > 1.18;
  const crowdedShort = fundingRate < -0.03 && longShortRatio < 0.88;

  if (side === "long") {
    if (primaryImbalance >= 0.12) {
      score += 1;
      reasons.push("order book bid imbalance supports longs");
    }
    if (takerImbalance >= 0.08) {
      score += 1;
      reasons.push("aggressive taker flow supports longs");
    }
    if (oiChange >= 2.5 && liquidationBias >= 0.15) {
      score += 1;
      reasons.push("open interest and liquidations confirm squeeze higher");
    }
    if (crowdedLong) {
      score -= 2;
      reasons.push("long crowding is elevated");
    }
    if (primaryImbalance <= -0.15) {
      score -= 2;
      reasons.push("book imbalance leans against longs");
    }
    if (signed(liquidationBias) < 0 && liquidationIntensity >= 1) {
      score -= 1;
      reasons.push("liquidation flow leans lower");
    }
  } else {
    if (primaryImbalance <= -0.12) {
      score += 1;
      reasons.push("order book ask imbalance supports shorts");
    }
    if (takerImbalance <= -0.08) {
      score += 1;
      reasons.push("aggressive taker flow supports shorts");
    }
    if (oiChange >= 2.5 && liquidationBias <= -0.15) {
      score += 1;
      reasons.push("open interest and liquidations confirm squeeze lower");
    }
    if (crowdedShort) {
      score -= 2;
      reasons.push("short crowding is elevated");
    }
    if (primaryImbalance >= 0.15) {
      score -= 2;
      reasons.push("book imbalance leans against shorts");
    }
    if (signed(liquidationBias) > 0 && liquidationIntensity >= 1) {
      score -= 1;
      reasons.push("liquidation flow leans higher");
    }
  }

  return { score, reasons };
}

function directionalValue(side: "long" | "short", value: number) {
  return side === "long" ? value : -value;
}

function expectedExecutionCostBps(settings: StrategySettings, microstructure: MarketMicrostructure | null) {
  const spreadBps = microstructure?.primaryBook?.spreadBps ?? 0;
  const basisPenalty = Math.abs(microstructure?.crossVenueBasisBps ?? 0) * 0.15;
  return round(spreadBps + settings.feeBps * 2 + settings.slippageBps * 2 + basisPenalty, 4);
}

function trendRegimeQuality(side: "long" | "short", state: MarketState) {
  const tf1 = state.timeframe1m;
  const tf5 = state.timeframe5m;
  const tf15 = state.timeframe15m;
  const alignment =
    directionalValue(side, tf1.emaSpreadPct) * 4 +
    directionalValue(side, tf5.emaSpreadPct) * 8 +
    directionalValue(side, tf15.emaSpreadPct) * 10 +
    directionalValue(side, tf5.emaSlopePct) * 18 +
    directionalValue(side, tf15.emaSlopePct) * 22;
  const adxSupport = clamp((tf5.adx - 16) * 1.2, -10, 18) + clamp((tf15.adx - 18) * 1.2, -10, 22);
  const efficiencySupport = tf5.trendEfficiency * 22 + tf15.trendEfficiency * 26;
  const volatilityPenalty = clamp((tf1.realizedVolPct - tf15.realizedVolPct * 1.8) * 5.5, 0, 18);

  return clamp(34 + alignment + adxSupport + efficiencySupport - volatilityPenalty, 0, 100);
}

function meanReversionRegimeQuality(side: "long" | "short", state: MarketState) {
  const tf1 = state.timeframe1m;
  const tf5 = state.timeframe5m;
  const tf15 = state.timeframe15m;
  const stretchSupport = Math.abs(tf1.distFromVwapAtr) * 10 + Math.abs(tf1.bollingerZ) * 8;
  const calmSupport = clamp(22 - tf5.adx, 0, 18) + clamp(22 - tf15.adx, 0, 18);
  const rejectionSupport = side === "long"
    ? (tf1.wickBullish ? 10 : -2) + (tf1.closeLocation >= 0.55 ? 6 : -4)
    : (tf1.wickBearish ? 10 : -2) + (tf1.closeLocation <= 0.45 ? 6 : -4);
  const volatilityPenalty = clamp((tf1.realizedVolPct - tf5.realizedVolPct * 1.9) * 5, 0, 18);

  return clamp(24 + stretchSupport + calmSupport + rejectionSupport - volatilityPenalty, 0, 100);
}

function setupQuality(side: "long" | "short", setupType: StrategySetup, state: MarketState) {
  const tf1 = state.timeframe1m;
  const tf5 = state.timeframe5m;
  const desiredRsi = setupType === "trend" ? (side === "long" ? 52 : 48) : (side === "long" ? 28 : 72);
  const rsiPenaltyDivisor = setupType === "trend" ? 1.2 : 1.4;
  const rsiSupport = clamp(18 - Math.abs(tf1.rsi - desiredRsi) / rsiPenaltyDivisor, 0, 18);
  const momentumSupport = clamp(
    directionalValue(side, tf1.momentum1Pct) * 70 +
      directionalValue(side, tf1.momentum3Pct) * 45 +
      directionalValue(side, tf5.momentum3Pct) * 28,
    -12,
    24,
  );
  const valueZoneSupport = setupType === "trend"
    ? clamp(16 - Math.abs(tf1.distFromVwapAtr + (side === "long" ? 0.12 : -0.12)) * 9, 0, 18)
    : clamp(Math.abs(tf1.distFromVwapAtr) * 10 + Math.abs(tf1.bollingerZ) * 6, 0, 24);
  const candleSupport = side === "long"
    ? tf1.closeLocation * 8 + tf1.bodyToRange * 8 + (tf1.wickBullish ? 6 : 0)
    : (1 - tf1.closeLocation) * 8 + tf1.bodyToRange * 8 + (tf1.wickBearish ? 6 : 0);
  const volumeSupport = clamp((tf1.volumeRatio - 1) * 12, -4, 12);

  return clamp(24 + rsiSupport + momentumSupport + valueZoneSupport + candleSupport + volumeSupport, 0, 100);
}

function executionQuality(side: "long" | "short", state: MarketState, settings: StrategySettings) {
  const micro = state.microstructure;
  if (!micro?.primaryBook) {
    const lowCostFallback = clamp(80 - expectedExecutionCostBps(settings, micro) * 2.2, 25, 78);
    return round(lowCostFallback, 2);
  }

  const imbalanceSupport =
    directionalValue(side, micro.primaryBook.imbalance ?? 0) * 28 +
    directionalValue(side, micro.secondaryBook?.imbalance ?? 0) * 12;
  const takerSupport = directionalValue(side, micro.takerImbalance ?? 0) * 24;
  const liquidationSupport = directionalValue(side, micro.liquidationBias ?? 0) * ((micro.liquidationIntensity ?? 0) + 1) * 10;
  const spreadPenalty = clamp((micro.primaryBook.spreadBps - 1.2) * 8, 0, 34);
  const basisPenalty = clamp(Math.max(Math.abs(micro.crossVenueBasisBps ?? 0) - 3, 0) * 0.9, 0, 18);
  const crowdingPenalty = clamp(directionalValue(side, micro.crowdingScore ?? 0) * 2.6, 0, 20);

  return clamp(62 + imbalanceSupport + takerSupport + liquidationSupport - spreadPenalty - basisPenalty - crowdingPenalty, 0, 100);
}

function enrichEntryDecision(
  side: "long" | "short",
  decision: StrategyDecision,
  state: MarketState,
  settings: StrategySettings,
) {
  const regimeQuality = decision.setupType === "mean_reversion"
    ? meanReversionRegimeQuality(side, state)
    : trendRegimeQuality(side, state);
  const entrySetupQuality = setupQuality(side, decision.setupType, state);
  const marketExecutionQuality = executionQuality(side, state, settings);
  const qualityScore = round((regimeQuality + entrySetupQuality + marketExecutionQuality) / 3, 2);
  const expectedCostBps = expectedExecutionCostBps(settings, state.microstructure);
  const targetBps = decision.takeProfitPct * 10_000;
  const stopBps = decision.stopPct * 10_000;
  const edgeToCostRatio = expectedCostBps <= 0 ? 99 : targetBps / expectedCostBps;
  const riskMultiplier = round(clamp((qualityScore - 15) / 55, 0.35, 1), 4);
  const leverageMultiplier = round(clamp((marketExecutionQuality + regimeQuality - 60) / 75, 0.55, 1), 4);
  const confidence = clamp(
    decision.confidence + (qualityScore - 60) * 0.38 + (edgeToCostRatio - 2.4) * 4,
    0,
    98,
  );
  const features = {
    ...decision.features,
    regimeQuality: round(regimeQuality, 2),
    setupQuality: round(entrySetupQuality, 2),
    executionQuality: round(marketExecutionQuality, 2),
    qualityScore,
    expectedCostBps: round(expectedCostBps, 4),
    targetBps: round(targetBps, 2),
    stopBps: round(stopBps, 2),
    edgeToCostRatio: round(edgeToCostRatio, 4),
    riskMultiplier,
    leverageMultiplier,
  };

  if (edgeToCostRatio < 1.85) {
    return {
      ...decision,
      action: "hold" as TradeAction,
      confidence,
      reasoning: `${decision.reasoning} · edge after costs is too thin`,
      features,
    };
  }

  if (qualityScore < 54 || marketExecutionQuality < 34) {
    return {
      ...decision,
      action: "hold" as TradeAction,
      confidence,
      reasoning: `${decision.reasoning} · setup quality is not strong enough`,
      features,
    };
  }

  return {
    ...decision,
    confidence,
    reasoning: `${decision.reasoning} · quality ${round(qualityScore, 0)} / cost ${round(edgeToCostRatio, 1)}x`,
    features,
  };
}

function decisionFromScore(
  action: TradeAction,
  regime: RegimeKind,
  setupType: StrategySetup,
  score: number,
  reasons: string[],
  stopPct: number,
  takeProfitPct: number,
  features: Record<string, number | boolean | string | null>,
): StrategyDecision {
  return {
    action,
    confidence: clamp(42 + score * 6, 0, 98),
    reasoning: reasons.join(" · "),
    regime,
    setupType,
    stopPct,
    takeProfitPct,
    riskReward: stopPct === 0 ? 0 : takeProfitPct / stopPct,
    features,
  };
}

export function deriveAdvancedDecision(
  state: MarketState,
  settings: StrategySettings,
  riskState: SessionRiskState,
): StrategyDecision {
  const regime = detectRegime(state);
  const tf1 = state.timeframe1m;
  const tf5 = state.timeframe5m;
  const tf15 = state.timeframe15m;
  const sharedMicroFeatures = microstructureFeatures(state.microstructure);

  if (
    riskState.currentBalance <= 0 ||
    riskState.dailyRealizedPnl <= -(riskState.startingBalance * settings.dailyLossLimitPct) / 100 ||
    riskState.consecutiveLosses >= settings.maxConsecutiveLosses
  ) {
    return {
      action: "hold",
      confidence: 0,
      reasoning: "Risk-off: session drawdown or consecutive-loss limit reached",
      regime,
      setupType: "risk_off",
      stopPct: 0,
      takeProfitPct: 0,
      riskReward: 0,
      features: {
        ...sharedMicroFeatures,
        dailyRealizedPnl: round(riskState.dailyRealizedPnl, 2),
        consecutiveLosses: riskState.consecutiveLosses,
      },
    };
  }

  if (
    !state.hasPosition &&
    settings.allowSessionFilter &&
    !isWithinSessionWindow(state.latestHourUtc, settings.sessionStartHourUtc, settings.sessionEndHourUtc)
  ) {
    return {
      action: "hold",
      confidence: 0,
      reasoning: "Outside configured trading session window",
      regime,
      setupType: "risk_off",
      stopPct: 0,
      takeProfitPct: 0,
      riskReward: 0,
      features: {
        ...sharedMicroFeatures,
        latestHourUtc: state.latestHourUtc,
      },
    };
  }

  if (!state.hasPosition) {
    const gate = microstructureRiskGate(state);
    if (gate) {
      return {
        action: "hold",
        confidence: 0,
        reasoning: gate.reasoning,
        regime,
        setupType: "risk_off",
        stopPct: 0,
        takeProfitPct: 0,
        riskReward: 0,
        features: gate.features,
      };
    }
  }

  if (state.hasPosition) {
    const closeReasons: string[] = [];
    let closeScore = 0;

    if (state.positionSide === "long") {
      if (regime === "trend_short") {
        closeScore += 3;
        closeReasons.push("higher timeframes flipped bearish");
      }
      if (tf1.close < tf1.ema20) {
        closeScore += 1;
        closeReasons.push("lost 1m EMA20");
      }
      if (tf1.rsi >= 74 || tf1.bollingerZ >= 2.1) {
        closeScore += 1;
        closeReasons.push("long side extension reached");
      }
      if (tf1.momentum1Pct <= -0.12 || tf1.close < tf1.previousLow) {
        closeScore += 1;
        closeReasons.push("micro momentum rolled over");
      }
      if (state.activeSetupType === "mean_reversion" && tf1.distFromVwapAtr >= -0.1) {
        closeScore += 2;
        closeReasons.push("mean reversion target back near VWAP");
      }
      if ((state.microstructure?.primaryBook?.imbalance ?? 0) <= -0.16) {
        closeScore += 1;
        closeReasons.push("order book flipped against the long");
      }
      if ((state.microstructure?.crowdingScore ?? 0) >= 4.5) {
        closeScore += 1;
        closeReasons.push("long crowding is now elevated");
      }
    }

    if (state.positionSide === "short") {
      if (regime === "trend_long") {
        closeScore += 3;
        closeReasons.push("higher timeframes flipped bullish");
      }
      if (tf1.close > tf1.ema20) {
        closeScore += 1;
        closeReasons.push("reclaimed 1m EMA20");
      }
      if (tf1.rsi <= 26 || tf1.bollingerZ <= -2.1) {
        closeScore += 1;
        closeReasons.push("short side extension reached");
      }
      if (tf1.momentum1Pct >= 0.12 || tf1.close > tf1.previousHigh) {
        closeScore += 1;
        closeReasons.push("micro momentum reversed higher");
      }
      if (state.activeSetupType === "mean_reversion" && tf1.distFromVwapAtr <= 0.1) {
        closeScore += 2;
        closeReasons.push("mean reversion target back near VWAP");
      }
      if ((state.microstructure?.primaryBook?.imbalance ?? 0) >= 0.16) {
        closeScore += 1;
        closeReasons.push("order book flipped against the short");
      }
      if ((state.microstructure?.crowdingScore ?? 0) <= -4.5) {
        closeScore += 1;
        closeReasons.push("short crowding is now elevated");
      }
    }

    if (closeScore >= 3) {
      return decisionFromScore("close", regime, state.activeSetupType ?? "trend", closeScore, closeReasons, 0, 0, {
        ...sharedMicroFeatures,
        tf1Rsi: round(tf1.rsi, 2),
        tf1Adx: round(tf1.adx, 2),
      });
    }

    return {
      action: "hold",
      confidence: 55,
      reasoning: "Open position remains valid under the current regime",
      regime,
      setupType: state.activeSetupType ?? "none",
      stopPct: 0,
      takeProfitPct: 0,
      riskReward: 0,
      features: {
        ...sharedMicroFeatures,
        tf1Rsi: round(tf1.rsi, 2),
        tf1Adx: round(tf1.adx, 2),
      },
    };
  }

  let bestDecision: StrategyDecision = {
    action: "hold",
    confidence: 48,
    reasoning: "No setup qualified",
    regime,
    setupType: "none",
    stopPct: 0,
    takeProfitPct: 0,
    riskReward: 0,
    features: {},
  };

  if (settings.allowTrendTrades) {
    const longReasons: string[] = [];
    let longScore = 0;
    if (regime === "trend_long") {
      longScore += 3;
      longReasons.push("15m and 5m trend aligned long");
    }
    if (tf1.rsi >= 42 && tf1.rsi <= 62) {
      longScore += 2;
      longReasons.push(`RSI reset ${round(tf1.rsi, 1)}`);
    }
    if (tf1.close > tf1.ema20) {
      longScore += 1;
      longReasons.push("price above 1m EMA20");
    }
    if (tf1.close > tf1.previousHigh) {
      longScore += 1;
      longReasons.push("reclaimed prior candle high");
    }
    if (tf1.distFromVwapAtr >= -0.6 && tf1.distFromVwapAtr <= 0.9) {
      longScore += 1;
      longReasons.push("entry near VWAP/ATR value zone");
    }
    if (tf1.volumeSpike) {
      longScore += 1;
      longReasons.push("volume confirmation");
    }
    if (tf1.momentum3Pct > 0.04 && tf5.momentum3Pct >= 0) {
      longScore += 1;
      longReasons.push("short-term momentum agrees");
    }
    if (tf1.bollingerZ > 1.8) {
      longScore -= 1;
    }
    const longMicro = microstructureBias("long", state.microstructure);
    longScore += longMicro.score;
    longReasons.push(...longMicro.reasons);

    if (longScore >= 5) {
      const stopPct = clamp(tf1.atrPct * 1.15, 0.0014, 0.0075);
      const takeProfitPct = stopPct * 1.9;
      const candidate = enrichEntryDecision(
        "long",
        decisionFromScore("long", regime, "trend", longScore, longReasons, stopPct, takeProfitPct, {
          ...sharedMicroFeatures,
          tf1Rsi: round(tf1.rsi, 2),
          tf1Adx: round(tf1.adx, 2),
          tf5Adx: round(tf5.adx, 2),
          tf15Adx: round(tf15.adx, 2),
          tf1EmaSlopePct: round(tf1.emaSlopePct, 4),
          tf5TrendEfficiency: round(tf5.trendEfficiency, 4),
          tf15TrendEfficiency: round(tf15.trendEfficiency, 4),
        }),
        state,
        settings,
      );
      if (candidate.action !== "hold" && candidate.confidence > bestDecision.confidence) {
        bestDecision = candidate;
      }
    }

    const shortReasons: string[] = [];
    let shortScore = 0;
    if (regime === "trend_short") {
      shortScore += 3;
      shortReasons.push("15m and 5m trend aligned short");
    }
    if (tf1.rsi >= 38 && tf1.rsi <= 58) {
      shortScore += 2;
      shortReasons.push(`RSI reset ${round(tf1.rsi, 1)}`);
    }
    if (tf1.close < tf1.ema20) {
      shortScore += 1;
      shortReasons.push("price below 1m EMA20");
    }
    if (tf1.close < tf1.previousLow) {
      shortScore += 1;
      shortReasons.push("lost prior candle low");
    }
    if (tf1.distFromVwapAtr <= 0.6 && tf1.distFromVwapAtr >= -0.9) {
      shortScore += 1;
      shortReasons.push("entry near VWAP/ATR value zone");
    }
    if (tf1.volumeSpike) {
      shortScore += 1;
      shortReasons.push("volume confirmation");
    }
    if (tf1.momentum3Pct < -0.04 && tf5.momentum3Pct <= 0) {
      shortScore += 1;
      shortReasons.push("short-term momentum agrees");
    }
    if (tf1.bollingerZ < -1.8) {
      shortScore -= 1;
    }
    const shortMicro = microstructureBias("short", state.microstructure);
    shortScore += shortMicro.score;
    shortReasons.push(...shortMicro.reasons);

    if (shortScore >= 5) {
      const stopPct = clamp(tf1.atrPct * 1.15, 0.0014, 0.0075);
      const takeProfitPct = stopPct * 1.9;
      const candidate = enrichEntryDecision(
        "short",
        decisionFromScore("short", regime, "trend", shortScore, shortReasons, stopPct, takeProfitPct, {
          ...sharedMicroFeatures,
          tf1Rsi: round(tf1.rsi, 2),
          tf1Adx: round(tf1.adx, 2),
          tf5Adx: round(tf5.adx, 2),
          tf15Adx: round(tf15.adx, 2),
          tf1EmaSlopePct: round(tf1.emaSlopePct, 4),
          tf5TrendEfficiency: round(tf5.trendEfficiency, 4),
          tf15TrendEfficiency: round(tf15.trendEfficiency, 4),
        }),
        state,
        settings,
      );
      if (candidate.action !== "hold" && candidate.confidence > bestDecision.confidence) {
        bestDecision = candidate;
      }
    }
  }

  if (settings.allowMeanReversionTrades) {
    const longReasons: string[] = [];
    let longScore = 0;
    if (regime === "range") {
      longScore += 3;
      longReasons.push("higher timeframes are ranging");
    }
    if (tf1.rsi <= 30) {
      longScore += 2;
      longReasons.push(`RSI oversold ${round(tf1.rsi, 1)}`);
    }
    if (tf1.distFromVwapAtr <= -1.1 || tf1.bollingerZ <= -1.7) {
      longScore += 2;
      longReasons.push("price stretched below value");
    }
    if (tf1.wickBullish) {
      longScore += 1;
      longReasons.push("bullish rejection wick");
    }
    if (tf1.close > tf1.open) {
      longScore += 1;
      longReasons.push("recovery candle closed green");
    }
    if ((state.microstructure?.primaryBook?.imbalance ?? 0) >= 0.1) {
      longScore += 1;
      longReasons.push("bid imbalance supports the bounce");
    }
    if ((state.microstructure?.liquidationBias ?? 0) >= 0.12) {
      longScore += 1;
      longReasons.push("liquidation flow supports mean reversion higher");
    }

    if (longScore >= 5) {
      const stopPct = clamp(tf1.atrPct * 0.95, 0.0012, 0.0055);
      const takeProfitPct = stopPct * 1.4;
      const candidate = enrichEntryDecision(
        "long",
        decisionFromScore("long", regime, "mean_reversion", longScore, longReasons, stopPct, takeProfitPct, {
          ...sharedMicroFeatures,
          tf1Rsi: round(tf1.rsi, 2),
          tf1DistFromVwapAtr: round(tf1.distFromVwapAtr, 2),
          tf1BollingerZ: round(tf1.bollingerZ, 4),
          tf1CloseLocation: round(tf1.closeLocation, 4),
        }),
        state,
        settings,
      );
      if (candidate.action !== "hold" && candidate.confidence > bestDecision.confidence) {
        bestDecision = candidate;
      }
    }

    const shortReasons: string[] = [];
    let shortScore = 0;
    if (regime === "range") {
      shortScore += 3;
      shortReasons.push("higher timeframes are ranging");
    }
    if (tf1.rsi >= 70) {
      shortScore += 2;
      shortReasons.push(`RSI overbought ${round(tf1.rsi, 1)}`);
    }
    if (tf1.distFromVwapAtr >= 1.1 || tf1.bollingerZ >= 1.7) {
      shortScore += 2;
      shortReasons.push("price stretched above value");
    }
    if (tf1.wickBearish) {
      shortScore += 1;
      shortReasons.push("bearish rejection wick");
    }
    if (tf1.close < tf1.open) {
      shortScore += 1;
      shortReasons.push("reversal candle closed red");
    }
    if ((state.microstructure?.primaryBook?.imbalance ?? 0) <= -0.1) {
      shortScore += 1;
      shortReasons.push("ask imbalance supports the fade");
    }
    if ((state.microstructure?.liquidationBias ?? 0) <= -0.12) {
      shortScore += 1;
      shortReasons.push("liquidation flow supports mean reversion lower");
    }

    if (shortScore >= 5) {
      const stopPct = clamp(tf1.atrPct * 0.95, 0.0012, 0.0055);
      const takeProfitPct = stopPct * 1.4;
      const candidate = enrichEntryDecision(
        "short",
        decisionFromScore("short", regime, "mean_reversion", shortScore, shortReasons, stopPct, takeProfitPct, {
          ...sharedMicroFeatures,
          tf1Rsi: round(tf1.rsi, 2),
          tf1DistFromVwapAtr: round(tf1.distFromVwapAtr, 2),
          tf1BollingerZ: round(tf1.bollingerZ, 4),
          tf1CloseLocation: round(tf1.closeLocation, 4),
        }),
        state,
        settings,
      );
      if (candidate.action !== "hold" && candidate.confidence > bestDecision.confidence) {
        bestDecision = candidate;
      }
    }
  }

  return bestDecision.confidence >= settings.minConfidence
    ? bestDecision
    : {
      ...bestDecision,
      action: "hold",
      reasoning: `${bestDecision.reasoning} · confidence below threshold`,
      features: {
        ...sharedMicroFeatures,
        ...bestDecision.features,
      },
    };
}

export function calculatePositionSize(
  balance: number,
  riskPct: number,
  entryPrice: number,
  stopPrice: number,
  leverage: number,
): PositionSizing | null {
  const riskAmount = balance * (riskPct / 100);
  const stopDistance = Math.abs(entryPrice - stopPrice);

  if (riskAmount <= 0 || stopDistance <= 0 || entryPrice <= 0) {
    return null;
  }

  const rawSizeBtc = riskAmount / stopDistance;
  const maxSizeBtc = (balance * leverage) / entryPrice;
  const sizeBtc = Math.floor(Math.min(rawSizeBtc, maxSizeBtc) / CONTRACT_SIZE_BTC) * CONTRACT_SIZE_BTC;

  if (sizeBtc < CONTRACT_SIZE_BTC) {
    return null;
  }

  return {
    sizeBtc: round(sizeBtc, 4),
    contracts: Math.floor(sizeBtc / CONTRACT_SIZE_BTC),
    riskAmount: round(riskAmount, 2),
  };
}

export function toStopAndTakeProfit(entryPrice: number, action: Extract<TradeAction, "long" | "short">, decision: StrategyDecision) {
  if (action === "long") {
    return {
      stopPrice: entryPrice * (1 - decision.stopPct),
      takeProfitPrice: entryPrice * (1 + decision.takeProfitPct),
    };
  }

  return {
    stopPrice: entryPrice * (1 + decision.stopPct),
    takeProfitPrice: entryPrice * (1 - decision.takeProfitPct),
  };
}

function formatBacktestTime(timestamp: number | undefined, index: number) {
  if (timestamp === undefined) {
    return `#${index + 1}`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function applyEntrySlippage(price: number, side: "long" | "short", slippageBps: number) {
  const factor = slippageBps / 10_000;
  return side === "long" ? price * (1 + factor) : price * (1 - factor);
}

function applyExitSlippage(price: number, side: "long" | "short", slippageBps: number) {
  const factor = slippageBps / 10_000;
  return side === "long" ? price * (1 - factor) : price * (1 + factor);
}

function feeForExecution(price: number, sizeBtc: number, feeBps: number) {
  return price * sizeBtc * (feeBps / 10_000);
}

export function parseCsvCandles(text: string): MarketCandle[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const indexOf = (candidates: string[]) => headers.findIndex((header) => candidates.includes(header));

  const timeIndex = indexOf(["timestamp", "time", "date", "datetime"]);
  const openIndex = indexOf(["open"]);
  const highIndex = indexOf(["high"]);
  const lowIndex = indexOf(["low"]);
  const closeIndex = indexOf(["close"]);
  const volumeIndex = indexOf(["volume", "vol"]);

  if ([openIndex, highIndex, lowIndex, closeIndex].some((index) => index === -1)) {
    return [];
  }

  return lines.slice(1).map((line) => {
    const parts = line.split(",").map((part) => part.trim());
    const rawTime = timeIndex === -1 ? undefined : parts[timeIndex];
    const parsedTime = rawTime === undefined
      ? undefined
      : Number.isFinite(Number(rawTime))
        ? Number(rawTime)
        : Date.parse(rawTime);

    return {
      timestamp: parsedTime && Number.isFinite(parsedTime) ? parsedTime : undefined,
      open: Number(parts[openIndex]),
      high: Number(parts[highIndex]),
      low: Number(parts[lowIndex]),
      close: Number(parts[closeIndex]),
      volume: volumeIndex === -1 ? 0 : Number(parts[volumeIndex]),
    };
  }).filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.close));
}

export function simulateStrategy(candles: MarketCandle[], settings: StrategySettings, startingBalance = 10_000): BacktestResult {
  const normalized = normalizeCandles(candles);
  const equity: Array<{ time: string; equity: number }> = [];
  const tradesLog: SimulatedTrade[] = [];
  const warmup = 15 * 50;
  let balance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  let totalFeesPaid = 0;
  let lastTradeDay: number | null = null;
  let dailyRealizedPnl = 0;
  let consecutiveLosses = 0;
  let openPosition: {
    side: "long" | "short";
    setupType: StrategySetup;
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    initialSizeBtc: number;
    remainingSizeBtc: number;
    confidence: number;
    entryIndex: number;
    initialRiskPerUnit: number;
    partialTaken: boolean;
    realizedGrossPnl: number;
    realizedNetPnl: number;
    feesPaid: number;
    slippagePaid: number;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
  } | null = null;

  for (let index = warmup; index < normalized.length; index += 1) {
    const current = normalized[index];
    const dayBucket = current.timestamp !== undefined ? Math.floor(current.timestamp / DAY_MS) : null;
    if (dayBucket !== null && dayBucket !== lastTradeDay) {
      dailyRealizedPnl = 0;
      consecutiveLosses = 0;
      lastTradeDay = dayBucket;
    }

    const window = normalized.slice(0, index + 1);
    const state = buildMarketState(window, openPosition?.side ?? null, openPosition?.setupType ?? null);
    const decision = deriveAdvancedDecision(state, settings, {
      startingBalance,
      currentBalance: balance,
      dailyRealizedPnl,
      consecutiveLosses,
    });

    if (openPosition) {
      const barsHeld = index - openPosition.entryIndex;
      const favorableMove = openPosition.side === "long"
        ? current.high - openPosition.entryPrice
        : openPosition.entryPrice - current.low;
      const adverseMove = openPosition.side === "long"
        ? openPosition.entryPrice - current.low
        : current.high - openPosition.entryPrice;

      openPosition.maxFavorableExcursion = Math.max(openPosition.maxFavorableExcursion, favorableMove);
      openPosition.maxAdverseExcursion = Math.max(openPosition.maxAdverseExcursion, adverseMove);

      if (!openPosition.partialTaken && favorableMove >= openPosition.initialRiskPerUnit * settings.partialTakeProfitRR) {
        const partialBasePrice = openPosition.side === "long"
          ? openPosition.entryPrice + openPosition.initialRiskPerUnit * settings.partialTakeProfitRR
          : openPosition.entryPrice - openPosition.initialRiskPerUnit * settings.partialTakeProfitRR;
        const partialPrice = applyExitSlippage(partialBasePrice, openPosition.side, settings.slippageBps);
        const partialSize = openPosition.remainingSizeBtc / 2;
        const partialGrossPnl = openPosition.side === "long"
          ? (partialPrice - openPosition.entryPrice) * partialSize
          : (openPosition.entryPrice - partialPrice) * partialSize;
        const partialFee = feeForExecution(partialPrice, partialSize, settings.feeBps);

        balance += partialGrossPnl - partialFee;
        dailyRealizedPnl += partialGrossPnl - partialFee;
        totalFeesPaid += partialFee;
        openPosition.realizedGrossPnl += partialGrossPnl;
        openPosition.realizedNetPnl += partialGrossPnl - partialFee;
        openPosition.feesPaid += partialFee;
        openPosition.slippagePaid += Math.abs(partialPrice - partialBasePrice) * partialSize;
        openPosition.remainingSizeBtc -= partialSize;
        openPosition.partialTaken = true;
        openPosition.stopPrice = openPosition.entryPrice;
      }

      if (favorableMove >= openPosition.initialRiskPerUnit) {
        openPosition.stopPrice = openPosition.side === "long"
          ? Math.max(openPosition.stopPrice, openPosition.entryPrice)
          : Math.min(openPosition.stopPrice, openPosition.entryPrice);
      }

      if (openPosition.partialTaken) {
        const trailingDistance = state.timeframe1m.atr * 1.15;
        const trailingStop = openPosition.side === "long"
          ? current.close - trailingDistance
          : current.close + trailingDistance;
        openPosition.stopPrice = openPosition.side === "long"
          ? Math.max(openPosition.stopPrice, trailingStop)
          : Math.min(openPosition.stopPrice, trailingStop);
      }

      const hitStop = openPosition.side === "long"
        ? current.low <= openPosition.stopPrice
        : current.high >= openPosition.stopPrice;
      const hitTakeProfit = openPosition.side === "long"
        ? current.high >= openPosition.takeProfitPrice
        : current.low <= openPosition.takeProfitPrice;
      const hitTimeStop = barsHeld >= settings.maxBarsInTrade;
      const requestedClose = decision.action === "close";

      if (hitStop || hitTakeProfit || hitTimeStop || requestedClose) {
        const baseExitPrice = hitStop
          ? openPosition.stopPrice
          : hitTakeProfit
            ? openPosition.takeProfitPrice
            : current.close;
        const exitReason = hitStop
          ? "stop"
          : hitTakeProfit
            ? "take_profit"
            : hitTimeStop
              ? "time_stop"
              : "signal_close";
        const exitPrice = applyExitSlippage(baseExitPrice, openPosition.side, settings.slippageBps);
        const exitFee = feeForExecution(exitPrice, openPosition.remainingSizeBtc, settings.feeBps);
        const exitGrossPnl = openPosition.side === "long"
          ? (exitPrice - openPosition.entryPrice) * openPosition.remainingSizeBtc
          : (openPosition.entryPrice - exitPrice) * openPosition.remainingSizeBtc;
        const totalGrossPnl = openPosition.realizedGrossPnl + exitGrossPnl;
        const totalNetPnl = openPosition.realizedNetPnl + exitGrossPnl - exitFee;

        balance += exitGrossPnl - exitFee;
        dailyRealizedPnl += exitGrossPnl - exitFee;
        consecutiveLosses = totalNetPnl < 0 ? consecutiveLosses + 1 : 0;
        totalFeesPaid += exitFee;
        tradesLog.push({
          side: openPosition.side,
          setupType: openPosition.setupType,
          entryPrice: round(openPosition.entryPrice, 2),
          exitPrice: round(exitPrice, 2),
          stopPrice: round(openPosition.stopPrice, 2),
          takeProfitPrice: round(openPosition.takeProfitPrice, 2),
          pnl: round(totalNetPnl, 2),
          grossPnl: round(totalGrossPnl, 2),
          feesPaid: round(openPosition.feesPaid + exitFee, 2),
          slippagePaid: round(
            openPosition.slippagePaid + Math.abs(exitPrice - baseExitPrice) * openPosition.remainingSizeBtc,
            2,
          ),
          confidence: openPosition.confidence,
          entryTime: normalized[openPosition.entryIndex].timestamp ?? null,
          exitTime: current.timestamp ?? null,
          barsHeld,
          maxFavorableExcursion: round(openPosition.maxFavorableExcursion, 2),
          maxAdverseExcursion: round(openPosition.maxAdverseExcursion, 2),
          exitReason,
        });
        openPosition = null;
      }
    }

    if (!openPosition && (decision.action === "long" || decision.action === "short")) {
      const rawEntryPrice = current.close;
      const entryPrice = applyEntrySlippage(rawEntryPrice, decision.action, settings.slippageBps);
      const { stopPrice, takeProfitPrice } = toStopAndTakeProfit(entryPrice, decision.action, decision);
      const riskMultiplier = clamp(
        typeof decision.features.riskMultiplier === "number" ? decision.features.riskMultiplier : 1,
        0.35,
        1,
      );
      const leverageMultiplier = clamp(
        typeof decision.features.leverageMultiplier === "number" ? decision.features.leverageMultiplier : 1,
        0.55,
        1,
      );
      const effectiveRiskPct = clamp(settings.riskPct * riskMultiplier, 0.1, settings.riskPct);
      const effectiveLeverage = Math.max(1, Math.round(settings.leverage * leverageMultiplier));
      const sizing = calculatePositionSize(balance, effectiveRiskPct, entryPrice, stopPrice, effectiveLeverage);

      if (sizing) {
        const entryFee = feeForExecution(entryPrice, sizing.sizeBtc, settings.feeBps);
        balance -= entryFee;
        dailyRealizedPnl -= entryFee;
        totalFeesPaid += entryFee;
        openPosition = {
          side: decision.action,
          setupType: decision.setupType,
          entryPrice,
          stopPrice,
          takeProfitPrice,
          initialSizeBtc: sizing.sizeBtc,
          remainingSizeBtc: sizing.sizeBtc,
          confidence: decision.confidence,
          entryIndex: index,
          initialRiskPerUnit: Math.abs(entryPrice - stopPrice),
          partialTaken: false,
          realizedGrossPnl: 0,
          realizedNetPnl: -entryFee,
          feesPaid: entryFee,
          slippagePaid: Math.abs(entryPrice - rawEntryPrice) * sizing.sizeBtc,
          maxFavorableExcursion: 0,
          maxAdverseExcursion: 0,
        };
      }
    }

    peakBalance = Math.max(peakBalance, balance);
    maxDrawdown = Math.max(maxDrawdown, peakBalance === 0 ? 0 : ((peakBalance - balance) / peakBalance) * 100);
    equity.push({
      time: formatBacktestTime(current.timestamp, index),
      equity: round(balance, 2),
    });
  }

  const returns = equity.slice(1).map((point, index) => {
    const previous = equity[index].equity;
    return previous === 0 ? 0 : (point.equity - previous) / previous;
  });
  const sharpe = returns.length === 0
    ? 0
    : average(returns) / Math.max(standardDeviation(returns), 0.000001) * Math.sqrt(252);
  const downsideReturns = returns.filter((value) => value < 0);
  const sortino = returns.length === 0
    ? 0
    : average(returns) / Math.max(standardDeviation(downsideReturns), 0.000001) * Math.sqrt(252);
  const wins = tradesLog.filter((trade) => trade.pnl > 0);
  const losses = tradesLog.filter((trade) => trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
  const profitFactor = grossLoss === 0 ? grossProfit > 0 ? 999 : 0 : grossProfit / grossLoss;
  const expectancy = tradesLog.length === 0 ? 0 : tradesLog.reduce((sum, trade) => sum + trade.pnl, 0) / tradesLog.length;
  const averageWin = wins.length === 0 ? 0 : grossProfit / wins.length;
  const averageLoss = losses.length === 0 ? 0 : grossLoss / losses.length;
  const payoffRatio = averageLoss === 0 ? 0 : averageWin / averageLoss;
  const avgTrade = expectancy;
  const years = normalized.length === 0 ? 1 : Math.max(normalized.length / (60 * 24 * 365), 1 / 365);
  const annualizedReturn = years <= 0 ? 0 : (balance / startingBalance) ** (1 / years) - 1;
  const calmar = maxDrawdown === 0 ? 0 : (annualizedReturn * 100) / maxDrawdown;

  return {
    equity,
    totalPnl: round(balance - startingBalance, 2),
    trades: tradesLog.length,
    winRate: tradesLog.length === 0 ? 0 : round((wins.length / tradesLog.length) * 100, 1),
    maxDrawdown: round(maxDrawdown, 2),
    sharpe: round(sharpe, 2),
    sortino: round(sortino, 2),
    calmar: round(calmar, 2),
    profitFactor: round(profitFactor, 2),
    expectancy: round(expectancy, 2),
    payoffRatio: round(payoffRatio, 2),
    avgTrade: round(avgTrade, 2),
    feesPaid: round(totalFeesPaid, 2),
    tradesLog,
  };
}
