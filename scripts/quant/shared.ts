import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildMarketMicrostructure,
  MarketCandle,
  MarketMicrostructure,
  normalizeCandles,
  parseCsvCandles,
  StrategySettings,
} from "../../src/lib/strategy-core";
import {
  HistoricalContextSnapshot,
  HistoricalMicrostructureSnapshot,
  prepareHistoricalContext,
  prepareHistoricalMicrostructure,
} from "../../src/lib/quant-research";

export type Args = Record<string, string | boolean>;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CandleQualityReport {
  rowsRead: number;
  cleanedRows: number;
  invalidRowsRemoved: number;
  repairedRows: number;
  unsortedRowsDetected: number;
  duplicateTimestampsRemoved: number;
  missingBarsDetected: number;
  syntheticBarsInserted: number;
  unresolvedGapBars: number;
  zeroVolumeBars: number;
  suspiciousMoveBars: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
  expectedBars: number;
  coverageDays: number;
  qualityScore: number;
}

export interface LoadedCandleDataset {
  candles: MarketCandle[];
  quality: CandleQualityReport;
}

export function parseArgs(argv: string[]) {
  const args: Args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }

  return args;
}

export function stringArg(args: Args, key: string, fallback?: string) {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function numberArg(args: Args, key: string, fallback: number) {
  const value = args[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function booleanArg(args: Args, key: string, fallback = false) {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

export function csvNumberArg(args: Args, key: string, fallback: number[]) {
  const raw = stringArg(args, key);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : fallback;
}

export function csvBooleanArg(args: Args, key: string, fallback: boolean[]) {
  const raw = stringArg(args, key);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => ["1", "true", "yes", "on"].includes(value));
  return values.length > 0 ? values : fallback;
}

export function csvStringArg(args: Args, key: string, fallback: string[] = []) {
  const raw = stringArg(args, key);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function isMinuteAlignedGap(deltaMs: number, intervalMs: number) {
  if (deltaMs <= intervalMs) return 0;
  const rawBars = deltaMs / intervalMs;
  const roundedBars = Math.round(rawBars);
  if (Math.abs(rawBars - roundedBars) > 0.01) {
    return 0;
  }
  return Math.max(roundedBars - 1, 0);
}

function repairAndNormalizeCandles(candles: MarketCandle[]) {
  let invalidRowsRemoved = 0;
  let repairedRows = 0;
  const repaired: MarketCandle[] = [];

  for (const candle of candles) {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);
    const timestamp = candle.timestamp;

    if (![open, high, low, close, volume].every(Number.isFinite) || volume < 0) {
      invalidRowsRemoved += 1;
      continue;
    }

    let nextHigh = high;
    let nextLow = low;
    const expectedHigh = Math.max(open, close, high, low);
    const expectedLow = Math.min(open, close, high, low);
    if (nextHigh !== expectedHigh || nextLow !== expectedLow) {
      nextHigh = expectedHigh;
      nextLow = expectedLow;
      repairedRows += 1;
    }

    repaired.push({
      timestamp,
      open,
      high: nextHigh,
      low: nextLow,
      close,
      volume,
    });
  }

  return {
    candles: normalizeCandles(repaired),
    invalidRowsRemoved,
    repairedRows,
  };
}

function cleanCandleSeries(
  candles: MarketCandle[],
  options: { intervalMs?: number; maxSyntheticGapBars?: number; suspiciousMovePct?: number } = {},
): LoadedCandleDataset {
  const intervalMs = options.intervalMs ?? 60_000;
  const maxSyntheticGapBars = options.maxSyntheticGapBars ?? 3;
  const suspiciousMovePct = options.suspiciousMovePct ?? 3.5;
  const rowsRead = candles.length;
  const repaired = repairAndNormalizeCandles(candles);
  const normalized = repaired.candles;
  const timestamped = normalized.filter((candle): candle is MarketCandle & { timestamp: number } => typeof candle.timestamp === "number");
  const untimestamped = normalized.filter((candle) => typeof candle.timestamp !== "number");
  const unsortedRowsDetected = timestamped.some((candle, index) => index > 0 && candle.timestamp < timestamped[index - 1].timestamp) ? 1 : 0;
  const sorted = [...timestamped].sort((left, right) => left.timestamp - right.timestamp);
  const deduped: Array<MarketCandle & { timestamp: number }> = [];
  let duplicateTimestampsRemoved = 0;

  for (const candle of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].timestamp === candle.timestamp) {
      deduped[deduped.length - 1] = candle;
      duplicateTimestampsRemoved += 1;
      continue;
    }
    deduped.push(candle);
  }

  const cleaned: MarketCandle[] = [];
  let missingBarsDetected = 0;
  let syntheticBarsInserted = 0;
  let unresolvedGapBars = 0;

  for (const candle of deduped) {
    const previous = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
    if (previous && typeof previous.timestamp === "number" && typeof candle.timestamp === "number") {
      const gapBars = isMinuteAlignedGap(candle.timestamp - previous.timestamp, intervalMs);
      if (gapBars > 0) {
        missingBarsDetected += gapBars;
        if (gapBars <= maxSyntheticGapBars) {
          for (let step = 1; step <= gapBars; step += 1) {
            cleaned.push({
              timestamp: previous.timestamp + intervalMs * step,
              open: previous.close,
              high: previous.close,
              low: previous.close,
              close: previous.close,
              volume: 0,
            });
            syntheticBarsInserted += 1;
          }
        } else {
          unresolvedGapBars += gapBars;
        }
      }
    }
    cleaned.push(candle);
  }

  const finalCandles = [...cleaned, ...untimestamped];
  let zeroVolumeBars = 0;
  let suspiciousMoveBars = 0;

  finalCandles.forEach((candle, index) => {
    if (candle.volume === 0) zeroVolumeBars += 1;
    if (index === 0) return;
    const previousClose = finalCandles[index - 1].close;
    if (!Number.isFinite(previousClose) || previousClose === 0) return;
    const movePct = Math.abs(((candle.close - previousClose) / previousClose) * 100);
    if (movePct >= suspiciousMovePct) suspiciousMoveBars += 1;
  });

  const startTimestamp = deduped[0]?.timestamp ?? null;
  const endTimestamp = deduped.length > 0 ? deduped[deduped.length - 1].timestamp : null;
  const expectedBars = startTimestamp !== null && endTimestamp !== null
    ? Math.max(Math.round((endTimestamp - startTimestamp) / intervalMs) + 1, finalCandles.length)
    : finalCandles.length;
  const coverageDays = startTimestamp !== null && endTimestamp !== null
    ? Number(((endTimestamp - startTimestamp) / DAY_MS).toFixed(4))
    : 0;
  const penalty =
    repaired.invalidRowsRemoved * 0.7 +
    repaired.repairedRows * 0.15 +
    duplicateTimestampsRemoved * 0.2 +
    unresolvedGapBars * 0.35 +
    Math.max(syntheticBarsInserted - 3, 0) * 0.05 +
    suspiciousMoveBars * 0.1;
  const qualityScore = Number(Math.max(0, Math.min(100, 100 - penalty)).toFixed(2));

  return {
    candles: finalCandles,
    quality: {
      rowsRead,
      cleanedRows: finalCandles.length,
      invalidRowsRemoved: repaired.invalidRowsRemoved,
      repairedRows: repaired.repairedRows,
      unsortedRowsDetected,
      duplicateTimestampsRemoved,
      missingBarsDetected,
      syntheticBarsInserted,
      unresolvedGapBars,
      zeroVolumeBars,
      suspiciousMoveBars,
      startTimestamp,
      endTimestamp,
      expectedBars,
      coverageDays,
      qualityScore,
    },
  };
}

export async function loadCandleDatasetFromCsv(
  filePath: string,
  options: { intervalMs?: number; maxSyntheticGapBars?: number; suspiciousMovePct?: number } = {},
) {
  const text = await readFile(filePath, "utf8");
  return cleanCandleSeries(parseCsvCandles(text), options);
}

export async function loadCandlesFromCsv(filePath: string) {
  const dataset = await loadCandleDatasetFromCsv(filePath);
  return dataset.candles;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toMicrostructure(entry: unknown): MarketMicrostructure | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const rawPayload = record.raw_payload;
  if (rawPayload && typeof rawPayload === "object") {
    const payloadRecord = rawPayload as Record<string, unknown>;
    if (payloadRecord.microstructure && typeof payloadRecord.microstructure === "object") {
      return payloadRecord.microstructure as MarketMicrostructure;
    }
  }

  if (record.microstructure && typeof record.microstructure === "object") {
    return record.microstructure as MarketMicrostructure;
  }

  return buildMarketMicrostructure({
    fundingRatePct8h: safeNumber(record.funding_rate_pct_8h ?? record.fundingRatePct8h),
    openInterestUsd: safeNumber(record.open_interest_usd ?? record.openInterestUsd),
    openInterestChangePct: safeNumber(record.open_interest_change_pct ?? record.openInterestChangePct),
    longShortRatio: safeNumber(record.long_short_ratio ?? record.longShortRatio),
    takerImbalance: safeNumber(record.taker_imbalance ?? record.takerImbalance),
    liquidationBias: safeNumber(record.liquidation_bias ?? record.liquidationBias),
    liquidationIntensity: safeNumber(record.liquidation_intensity ?? record.liquidationIntensity),
    crossVenueBasisBps: safeNumber(record.cross_venue_basis_bps ?? record.crossVenueBasisBps),
  });
}

function extractContextPayload(entry: unknown) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  if (record.context && typeof record.context === "object") {
    return record.context as Record<string, unknown>;
  }

  const rawPayload = record.raw_payload;
  if (rawPayload && typeof rawPayload === "object") {
    const payloadRecord = rawPayload as Record<string, unknown>;
    if (payloadRecord.context && typeof payloadRecord.context === "object") {
      return payloadRecord.context as Record<string, unknown>;
    }
    return payloadRecord;
  }

  return record;
}

function toHistoricalContext(entry: unknown): HistoricalContextSnapshot | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const context = extractContextPayload(entry);
  if (!context) {
    return null;
  }

  const timestamp = parseTimestamp(
    record.published_at ??
      record.publishedAt ??
      record.released_at ??
      record.releasedAt ??
      record.fetchedAt ??
      record.created_at ??
      record.createdAt ??
      record.timestamp ??
      context.timestamp,
  );
  if (timestamp === null) {
    return null;
  }

  return {
    timestamp,
    newsEventCount: safeNumber(context.news_event_count ?? context.newsEventCount),
    newsSentiment: safeNumber(context.news_sentiment ?? context.newsSentiment),
    newsImpact: safeNumber(context.news_impact ?? context.newsImpact),
    newsPositiveCount: safeNumber(context.news_positive_count ?? context.newsPositiveCount),
    newsNegativeCount: safeNumber(context.news_negative_count ?? context.newsNegativeCount),
    newsBtcRelevance: safeNumber(context.news_btc_relevance ?? context.newsBtcRelevance),
    newsShockScore: safeNumber(context.news_shock_score ?? context.newsShockScore),
    macroCpiYoY: safeNumber(context.macro_cpi_yoy ?? context.macroCpiYoY),
    macroCpiMoM: safeNumber(context.macro_cpi_mom ?? context.macroCpiMoM),
    macroCoreCpiYoY: safeNumber(context.macro_core_cpi_yoy ?? context.macroCoreCpiYoY),
    macroCoreCpiMoM: safeNumber(context.macro_core_cpi_mom ?? context.macroCoreCpiMoM),
    macroUnemploymentRate: safeNumber(context.macro_unemployment_rate ?? context.macroUnemploymentRate),
    macroUnemploymentChange: safeNumber(context.macro_unemployment_change ?? context.macroUnemploymentChange),
    macroInflationTrend: safeNumber(context.macro_inflation_trend ?? context.macroInflationTrend),
    macroRiskBias: safeNumber(context.macro_risk_bias ?? context.macroRiskBias),
    source: typeof (context.source ?? record.source) === "string" ? String(context.source ?? record.source) : "json",
  };
}

export async function loadMicrostructureHistoryFromJson(filePath: string): Promise<HistoricalMicrostructureSnapshot[]> {
  const text = await readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { snapshots?: unknown[] }).snapshots)
      ? (parsed as { snapshots: unknown[] }).snapshots
      : [];

  const history: HistoricalMicrostructureSnapshot[] = [];
  for (const entry of candidates) {
    const record = entry as Record<string, unknown>;
    const timestamp = parseTimestamp(record.fetchedAt ?? record.created_at ?? record.createdAt ?? record.timestamp);
    if (timestamp === null) continue;
    history.push({
      timestamp,
      microstructure: toMicrostructure(record),
      source: "json",
    });
  }

  return prepareHistoricalMicrostructure(history);
}

export async function loadMicrostructureHistoryFromJsonFiles(filePaths: string[]): Promise<HistoricalMicrostructureSnapshot[]> {
  const uniquePaths = [...new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))];
  if (uniquePaths.length === 0) {
    return [];
  }

  const histories = await Promise.all(uniquePaths.map((filePath) => loadMicrostructureHistoryFromJson(filePath)));
  return prepareHistoricalMicrostructure(histories.flat());
}

export async function loadContextHistoryFromJson(filePath: string): Promise<HistoricalContextSnapshot[]> {
  const text = await readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { snapshots?: unknown[] }).snapshots)
      ? (parsed as { snapshots: unknown[] }).snapshots
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { articles?: unknown[] }).articles)
        ? (parsed as { articles: unknown[] }).articles
        : [];

  const history: HistoricalContextSnapshot[] = [];
  for (const entry of candidates) {
    const snapshot = toHistoricalContext(entry);
    if (!snapshot) continue;
    history.push(snapshot);
  }

  return prepareHistoricalContext(history);
}

export async function loadContextHistoryFromJsonFiles(filePaths: string[]): Promise<HistoricalContextSnapshot[]> {
  const uniquePaths = [...new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))];
  if (uniquePaths.length === 0) {
    return [];
  }

  const histories = await Promise.all(uniquePaths.map((filePath) => loadContextHistoryFromJson(filePath)));
  return prepareHistoricalContext(histories.flat());
}

export async function ensureParentDirectory(filePath: string) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

export function defaultStrategySettings(): StrategySettings {
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
  };
}

export function timestampedFile(prefix: string, extension: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}.${extension}`;
}
