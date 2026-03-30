import { buildMarketMicrostructure } from "../../src/lib/strategy-core";
import { booleanArg, numberArg, parseArgs, stringArg, writeJson } from "./shared";

const COINALYZE_BASE_URL = "https://api.coinalyze.net/v1";

interface OhlcSeriesRow {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface OhlcvSeriesRow extends OhlcSeriesRow {
  v?: number;
  bv?: number;
  tx?: number;
  btx?: number;
}

interface LiquidationSeriesRow {
  t: number;
  l?: number;
  s?: number;
}

interface LongShortRatioRow {
  t: number;
  r?: number;
  l?: number;
  s?: number;
}

interface ApiEnvelope<T> {
  symbol: string;
  history: T[];
}

interface HistoricalSnapshotRecord {
  timestamp: number;
  source: string;
  microstructure: ReturnType<typeof buildMarketMicrostructure>;
  rawPayload: Record<string, unknown>;
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimeInput(value: string, fallback: number) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPercent(value: number | null) {
  if (value === null) return null;
  return Math.abs(value) <= 1 ? round(value * 100, 8) : round(value, 8);
}

function safeDivide(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function logIntensity(value: number | null) {
  if (value === null || value <= 0) return null;
  return round(Math.log10(value + 1), 6);
}

async function fetchHistory<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
) {
  const url = new URL(`${COINALYZE_BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      api_key: apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Coinalyze ${endpoint} failed ${response.status}: ${body.slice(0, 240)}`);
  }

  const payload = await response.json() as ApiEnvelope<T>[];
  return Array.isArray(payload) && payload.length > 0 ? payload[0]?.history ?? [] : [];
}

function latestValueAtOrBefore<T extends { t: number }>(rows: T[], timestampMs: number, pointer: { index: number }) {
  while (pointer.index + 1 < rows.length && rows[pointer.index + 1]!.t * 1000 <= timestampMs) {
    pointer.index += 1;
  }
  const row = rows[pointer.index];
  return row && row.t * 1000 <= timestampMs ? row : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = stringArg(args, "api-key", process.env.COINALYZE_API_KEY);
  if (!apiKey) {
    throw new Error("Missing Coinalyze API key. Use --api-key or COINALYZE_API_KEY.");
  }

  const symbol = stringArg(args, "symbol", "BTCUSDT_PERP.A")!;
  const interval = stringArg(args, "interval", "daily")!;
  const startTime = parseTimeInput(stringArg(args, "start", "2020-01-01T00:00:00Z")!, Date.UTC(2020, 0, 1));
  const endTime = parseTimeInput(stringArg(args, "end", new Date().toISOString())!, Date.now());
  const output = stringArg(args, "output", `research/datasets/${symbol}-coinalyze-crowding.json`)!;
  const resampleIntervalMs = Math.max(60_000, numberArg(args, "resample-interval-ms", interval === "daily" ? 300_000 : 60_000));
  const includeOhlcv = booleanArg(args, "include-ohlcv", true);
  const includeRawPayload = booleanArg(args, "include-raw-payload", true);

  const commonParams = {
    symbols: symbol,
    interval,
    from: String(Math.floor(startTime / 1000)),
    to: String(Math.floor(endTime / 1000)),
  };

  const [openInterest, fundingRate, longShortRatio, liquidationHistory, ohlcvHistory] = await Promise.all([
    fetchHistory<OhlcSeriesRow>("open-interest-history", { ...commonParams, convert_to_usd: "true" }, apiKey),
    fetchHistory<OhlcSeriesRow>("funding-rate-history", commonParams, apiKey),
    fetchHistory<LongShortRatioRow>("long-short-ratio-history", commonParams, apiKey),
    fetchHistory<LiquidationSeriesRow>("liquidation-history", { ...commonParams, convert_to_usd: "true" }, apiKey),
    includeOhlcv
      ? fetchHistory<OhlcvSeriesRow>("ohlcv-history", commonParams, apiKey).catch(() => [])
      : Promise.resolve([]),
  ]);

  const openInterestRows = [...openInterest].sort((left, right) => left.t - right.t);
  const fundingRows = [...fundingRate].sort((left, right) => left.t - right.t);
  const longShortRows = [...longShortRatio].sort((left, right) => left.t - right.t);
  const liquidationRows = [...liquidationHistory].sort((left, right) => left.t - right.t);
  const ohlcvRows = [...ohlcvHistory].sort((left, right) => left.t - right.t);

  const snapshots: HistoricalSnapshotRecord[] = [];
  const pointers = {
    oi: { index: 0 },
    funding: { index: 0 },
    longShort: { index: 0 },
    liquidation: { index: 0 },
    ohlcv: { index: 0 },
  };

  const startBucket = Math.floor(startTime / resampleIntervalMs) * resampleIntervalMs;
  for (let timestamp = startBucket; timestamp <= endTime; timestamp += resampleIntervalMs) {
    const oiRow = latestValueAtOrBefore(openInterestRows, timestamp, pointers.oi);
    const fundingRow = latestValueAtOrBefore(fundingRows, timestamp, pointers.funding);
    const longShortRow = latestValueAtOrBefore(longShortRows, timestamp, pointers.longShort);
    const liquidationRow = latestValueAtOrBefore(liquidationRows, timestamp, pointers.liquidation);
    const ohlcvRow = latestValueAtOrBefore(ohlcvRows, timestamp, pointers.ohlcv);

    const openInterestUsd = safeNumber(oiRow?.c);
    const fundingRatePct8h = toPercent(safeNumber(fundingRow?.c));
    const longShort = safeNumber(longShortRow?.r);
    const buyVolume = safeNumber(ohlcvRow?.bv);
    const totalVolume = safeNumber(ohlcvRow?.v);
    const takerImbalance = buyVolume !== null && totalVolume !== null && totalVolume > 0
      ? round(safeDivide(buyVolume - (totalVolume - buyVolume), totalVolume), 6)
      : null;
    const longLiquidationsUsd = safeNumber(liquidationRow?.l);
    const shortLiquidationsUsd = safeNumber(liquidationRow?.s);
    const liquidationTotalUsd =
      (longLiquidationsUsd ?? 0) +
      (shortLiquidationsUsd ?? 0);
    const liquidationBias = liquidationTotalUsd > 0
      ? round(safeDivide((shortLiquidationsUsd ?? 0) - (longLiquidationsUsd ?? 0), liquidationTotalUsd), 6)
      : null;
    const liquidationIntensity = logIntensity(liquidationTotalUsd > 0 ? liquidationTotalUsd : null);

    const microstructure = buildMarketMicrostructure({
      fundingRatePct8h,
      openInterestUsd,
      longShortRatio: longShort,
      takerImbalance,
      liquidationBias,
      liquidationIntensity,
    });

    if (!microstructure) {
      continue;
    }

    snapshots.push({
      timestamp,
      source: "coinalyze-history",
      microstructure,
      rawPayload: includeRawPayload
        ? {
          symbol,
          interval,
          openInterest: oiRow ?? null,
          fundingRate: fundingRow ?? null,
          longShortRatio: longShortRow ?? null,
          liquidationHistory: liquidationRow ?? null,
          ohlcvHistory: ohlcvRow ?? null,
        }
        : {},
    });
  }

  const result = {
    createdAt: new Date().toISOString(),
    provider: "coinalyze",
    symbol,
    interval,
    startTime,
    endTime,
    resampleIntervalMs,
    counts: {
      openInterest: openInterestRows.length,
      fundingRate: fundingRows.length,
      longShortRatio: longShortRows.length,
      liquidationHistory: liquidationRows.length,
      ohlcvHistory: ohlcvRows.length,
      mergedSnapshots: snapshots.length,
    },
    snapshots,
  };

  await writeJson(output, result);
  console.log(JSON.stringify({
    output,
    createdAt: result.createdAt,
    provider: result.provider,
    symbol,
    interval,
    counts: result.counts,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
