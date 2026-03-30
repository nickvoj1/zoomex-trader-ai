import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { buildMarketMicrostructure, type MarketMicrostructure } from "../../src/lib/strategy-core";
import { booleanArg, ensureParentDirectory, numberArg, parseArgs, stringArg, writeJson } from "./shared";

const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";
const DEFAULT_PERIOD = "5m";
const DAY_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

interface FundingRateRow {
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

interface OpenInterestHistRow {
  timestamp: number;
  sumOpenInterestValue: string;
}

interface LongShortRatioRow {
  timestamp: number;
  longShortRatio: string;
  longAccount?: string;
  shortAccount?: string;
}

interface TakerRatioRow {
  timestamp: number;
  buySellRatio: string;
  buyVol?: string;
  sellVol?: string;
}

type ArchiveKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

interface HistoricalMicrostructureRecord {
  timestamp: number;
  source: string;
  microstructure: MarketMicrostructure | null;
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

function ratioToImbalance(ratio: number | null) {
  if (ratio === null || ratio <= 0) return null;
  return round((ratio - 1) / (ratio + 1), 6);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }
  return await response.json() as T;
}

async function loadPremiumIndexRowsFromArchives(options: {
  archivesDir: string;
  startTime: number;
  endTime: number;
}) {
  const files = await readdir(options.archivesDir)
    .then((entries) => entries.filter((file) => file.endsWith(".zip")).sort((left, right) => left.localeCompare(right)))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  if (files.length === 0) {
    return [] as ArchiveKlineRow[];
  }

  const rows: ArchiveKlineRow[] = [];
  for (const file of files) {
    const zipPath = path.join(options.archivesDir, file);
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath], {
      maxBuffer: 512 * 1024 * 1024,
    });
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (lower.startsWith("open_time,")) continue;
      const parts = line.split(",");
      if (parts.length < 12) continue;
      const openTime = safeNumber(parts[0]);
      if (openTime === null || openTime < options.startTime || openTime > options.endTime) {
        continue;
      }
      rows.push([
        openTime,
        parts[1] ?? "0",
        parts[2] ?? "0",
        parts[3] ?? "0",
        parts[4] ?? "0",
        parts[5] ?? "0",
        safeNumber(parts[6]) ?? openTime,
        parts[7] ?? "0",
        safeNumber(parts[8]) ?? 0,
        parts[9] ?? "0",
        parts[10] ?? "0",
        parts[11] ?? "0",
      ]);
    }
  }

  return rows.sort((left, right) => left[0] - right[0]);
}

async function fetchPaginatedRows<T>(options: {
  endpoint: string;
  symbol: string;
  startTime: number;
  endTime: number;
  period?: string;
  limit: number;
  sleepMs: number;
  extractTimestamp: (row: T) => number | null;
}) {
  const rows: T[] = [];
  let cursor = options.startTime;

  while (cursor <= options.endTime) {
    const url = new URL(`${BINANCE_FUTURES_BASE_URL}${options.endpoint}`);
    url.searchParams.set("symbol", options.symbol);
    url.searchParams.set("limit", String(options.limit));
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(options.endTime));
    if (options.period) {
      url.searchParams.set("period", options.period);
    }

    const page = await fetchJson<T[]>(url.toString());
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    let lastTimestamp = cursor;
    for (const row of page) {
      const timestamp = options.extractTimestamp(row);
      if (timestamp === null) continue;
      rows.push(row);
      lastTimestamp = Math.max(lastTimestamp, timestamp);
    }

    if (lastTimestamp <= cursor) {
      break;
    }
    cursor = lastTimestamp + 1;
    if (options.sleepMs > 0) {
      await sleep(options.sleepMs);
    }
  }

  return rows;
}

async function fetchLatestWindowRows<T>(options: {
  endpoint: string;
  symbol: string;
  period: string;
  limit: number;
}) {
  const url = new URL(`${BINANCE_FUTURES_BASE_URL}${options.endpoint}`);
  url.searchParams.set("symbol", options.symbol);
  url.searchParams.set("period", options.period);
  url.searchParams.set("limit", String(options.limit));
  const rows = await fetchJson<T[]>(url.toString());
  return Array.isArray(rows) ? rows : [];
}

async function fetchPaginatedKlineRows(options: {
  endpoint: string;
  symbol: string;
  symbolParam?: "symbol" | "pair";
  interval: string;
  startTime: number;
  endTime: number;
  limit: number;
  sleepMs: number;
}) {
  const rows: ArchiveKlineRow[] = [];
  let cursor = options.startTime;

  while (cursor <= options.endTime) {
    const url = new URL(`${BINANCE_FUTURES_BASE_URL}${options.endpoint}`);
    url.searchParams.set(options.symbolParam ?? "symbol", options.symbol);
    url.searchParams.set("interval", options.interval);
    url.searchParams.set("limit", String(options.limit));
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(options.endTime));

    const page = await fetchJson<ArchiveKlineRow[]>(url.toString());
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    let lastTimestamp = cursor;
    for (const row of page) {
      const timestamp = safeNumber(row[0]);
      if (timestamp === null) continue;
      rows.push(row);
      lastTimestamp = Math.max(lastTimestamp, timestamp);
    }

    if (lastTimestamp <= cursor) {
      break;
    }
    cursor = lastTimestamp + 1;
    if (options.sleepMs > 0) {
      await sleep(options.sleepMs);
    }
  }

  return rows;
}

function indexByTimestamp<T>(rows: T[], extractTimestamp: (row: T) => number | null) {
  const map = new Map<number, T>();
  for (const row of rows) {
    const timestamp = extractTimestamp(row);
    if (timestamp === null) continue;
    map.set(timestamp, row);
  }
  return map;
}

function latestFundingAtOrBefore(rows: FundingRateRow[], timestamp: number) {
  let latest: FundingRateRow | null = null;
  for (const row of rows) {
    const fundingTime = safeNumber(row.fundingTime);
    if (fundingTime === null) continue;
    if (fundingTime > timestamp) break;
    latest = row;
  }
  return latest;
}

function deriveCrowdingScore(input: {
  fundingRatePct8h: number | null;
  openInterestChangePct: number | null;
  globalLongShortRatio: number | null;
  topAccountRatio: number | null;
  topPositionRatio: number | null;
  takerImbalance: number | null;
  basisBps: number | null;
}) {
  return round(
    (input.fundingRatePct8h ?? 0) * 18 +
    (input.openInterestChangePct ?? 0) * 0.9 +
    ((input.globalLongShortRatio ?? 1) - 1) * 30 +
    ((input.topAccountRatio ?? 1) - 1) * 16 +
    ((input.topPositionRatio ?? 1) - 1) * 14 +
    (input.takerImbalance ?? 0) * 35 +
    Math.sign(input.basisBps ?? 0) * Math.min(Math.abs(input.basisBps ?? 0), 15) * 0.35,
    6,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const startTime = parseTimeInput(stringArg(args, "start", "2024-01-01T00:00:00Z")!, Date.UTC(2024, 0, 1));
  const endTime = parseTimeInput(stringArg(args, "end", new Date().toISOString())!, Date.now());
  const period = stringArg(args, "period", DEFAULT_PERIOD)!;
  const output = stringArg(args, "output", `research/datasets/${symbol}-historical-microstructure.json`)!;
  const premiumArchivesDir = stringArg(args, "premium-archives-dir", path.join("research", "binance-vision", "premiumIndexKlines", symbol, period));
  const markArchivesDir = stringArg(args, "mark-archives-dir", path.join("research", "binance-vision", "markPriceKlines", symbol, period));
  const indexArchivesDir = stringArg(args, "index-archives-dir", path.join("research", "binance-vision", "indexPriceKlines", symbol, period));
  const sleepMs = Math.max(0, numberArg(args, "sleep-ms", 120));
  const limit = Math.max(10, numberArg(args, "limit", 500));
  const writeFile = booleanArg(args, "write-file", true);
  const includeSnapshotsInStdout = booleanArg(args, "include-snapshots-stdout", false);

  const [
    fundingRates,
    openInterestHistory,
    globalLongShortRatios,
    topLongShortAccountRatios,
    topLongShortPositionRatios,
    takerRatios,
    premiumIndexKlines,
    markPriceKlines,
    indexPriceKlines,
  ] = await Promise.all([
    fetchPaginatedRows<FundingRateRow>({
      endpoint: "/fapi/v1/fundingRate",
      symbol,
      startTime,
      endTime,
      limit: 1000,
      sleepMs,
      extractTimestamp: (row) => safeNumber(row.fundingTime),
    }),
    fetchLatestWindowRows<OpenInterestHistRow>({
      endpoint: "/futures/data/openInterestHist",
      symbol,
      period,
      limit: Math.min(limit, 1000),
    }),
    fetchLatestWindowRows<LongShortRatioRow>({
      endpoint: "/futures/data/globalLongShortAccountRatio",
      symbol,
      period,
      limit: Math.min(limit, 1000),
    }),
    fetchLatestWindowRows<LongShortRatioRow>({
      endpoint: "/futures/data/topLongShortAccountRatio",
      symbol,
      period,
      limit: Math.min(limit, 1000),
    }),
    fetchLatestWindowRows<LongShortRatioRow>({
      endpoint: "/futures/data/topLongShortPositionRatio",
      symbol,
      period,
      limit: Math.min(limit, 1000),
    }),
    fetchLatestWindowRows<TakerRatioRow>({
      endpoint: "/futures/data/takerlongshortRatio",
      symbol,
      period,
      limit: Math.min(limit, 1000),
    }),
    loadPremiumIndexRowsFromArchives({
      archivesDir: premiumArchivesDir!,
      startTime,
      endTime,
    }).then(async (rows) => rows.length > 0
      ? rows
      : await fetchPaginatedKlineRows({
        endpoint: "/fapi/v1/premiumIndexKlines",
        symbol,
        symbolParam: "symbol",
        interval: period,
        startTime,
        endTime,
        limit: 1000,
        sleepMs,
      })),
    loadPremiumIndexRowsFromArchives({
      archivesDir: markArchivesDir!,
      startTime,
      endTime,
    }).then(async (rows) => rows.length > 0
      ? rows
      : await fetchPaginatedKlineRows({
        endpoint: "/fapi/v1/markPriceKlines",
        symbol,
        symbolParam: "symbol",
        interval: period,
        startTime,
        endTime,
        limit: 1000,
        sleepMs,
      })),
    loadPremiumIndexRowsFromArchives({
      archivesDir: indexArchivesDir!,
      startTime,
      endTime,
    }).then(async (rows) => rows.length > 0
      ? rows
      : await fetchPaginatedKlineRows({
        endpoint: "/fapi/v1/indexPriceKlines",
        symbol,
        symbolParam: "pair",
        interval: period,
        startTime,
        endTime,
        limit: 1000,
        sleepMs,
      })),
  ]);

  const filterWindow = <T,>(rows: T[], extractTimestamp: (row: T) => number | null) =>
    rows.filter((row) => {
      const timestamp = extractTimestamp(row);
      return timestamp !== null && timestamp >= startTime && timestamp <= endTime;
    });

  const filteredOpenInterestHistory = filterWindow(openInterestHistory, (row) => safeNumber(row.timestamp));
  const filteredGlobalLongShortRatios = filterWindow(globalLongShortRatios, (row) => safeNumber(row.timestamp));
  const filteredTopLongShortAccountRatios = filterWindow(topLongShortAccountRatios, (row) => safeNumber(row.timestamp));
  const filteredTopLongShortPositionRatios = filterWindow(topLongShortPositionRatios, (row) => safeNumber(row.timestamp));
  const filteredTakerRatios = filterWindow(takerRatios, (row) => safeNumber(row.timestamp));

  const oiByTimestamp = indexByTimestamp(filteredOpenInterestHistory, (row) => safeNumber(row.timestamp));
  const globalRatioByTimestamp = indexByTimestamp(filteredGlobalLongShortRatios, (row) => safeNumber(row.timestamp));
  const topAccountByTimestamp = indexByTimestamp(filteredTopLongShortAccountRatios, (row) => safeNumber(row.timestamp));
  const topPositionByTimestamp = indexByTimestamp(filteredTopLongShortPositionRatios, (row) => safeNumber(row.timestamp));
  const takerByTimestamp = indexByTimestamp(filteredTakerRatios, (row) => safeNumber(row.timestamp));
  const premiumByTimestamp = indexByTimestamp(premiumIndexKlines, (row) => safeNumber(row[0]));
  const markByTimestamp = indexByTimestamp(markPriceKlines, (row) => safeNumber(row[0]));
  const indexPriceByTimestamp = indexByTimestamp(indexPriceKlines, (row) => safeNumber(row[0]));

  const baseTimestamps = new Set<number>();
  [
    filteredOpenInterestHistory,
    filteredGlobalLongShortRatios,
    filteredTopLongShortAccountRatios,
    filteredTopLongShortPositionRatios,
    filteredTakerRatios,
    premiumIndexKlines,
    markPriceKlines,
    indexPriceKlines,
  ].forEach((rows) => {
    rows.forEach((row) => {
      const timestamp = Array.isArray(row)
        ? safeNumber(row[0])
        : safeNumber((row as { timestamp?: number }).timestamp);
      if (timestamp !== null) {
        baseTimestamps.add(timestamp);
      }
    });
  });

  const timestamps = [...baseTimestamps].sort((left, right) => left - right);
  let previousOpenInterestUsd: number | null = null;

  const snapshots: HistoricalMicrostructureRecord[] = timestamps.map((timestamp) => {
    const oiRow = oiByTimestamp.get(timestamp) ?? null;
    const globalRatioRow = globalRatioByTimestamp.get(timestamp) ?? null;
    const topAccountRow = topAccountByTimestamp.get(timestamp) ?? null;
    const topPositionRow = topPositionByTimestamp.get(timestamp) ?? null;
    const takerRow = takerByTimestamp.get(timestamp) ?? null;
    const premiumRow = premiumByTimestamp.get(timestamp) ?? null;
    const markRow = markByTimestamp.get(timestamp) ?? null;
    const indexRow = indexPriceByTimestamp.get(timestamp) ?? null;
    const fundingRow = latestFundingAtOrBefore(fundingRates, timestamp);

    const openInterestUsd = safeNumber(oiRow?.sumOpenInterestValue);
    const openInterestChangePct = openInterestUsd !== null && previousOpenInterestUsd && previousOpenInterestUsd > 0
      ? round(((openInterestUsd - previousOpenInterestUsd) / previousOpenInterestUsd) * 100, 6)
      : null;
    if (openInterestUsd !== null) {
      previousOpenInterestUsd = openInterestUsd;
    }

    const fundingRatePct8h = fundingRow ? round((safeNumber(fundingRow.fundingRate) ?? 0) * 100, 6) : null;
    const globalLongShortRatio = safeNumber(globalRatioRow?.longShortRatio);
    const topAccountRatio = safeNumber(topAccountRow?.longShortRatio);
    const topPositionRatio = safeNumber(topPositionRow?.longShortRatio);
    const takerImbalance = ratioToImbalance(safeNumber(takerRow?.buySellRatio));
    const premiumIndexBps = premiumRow ? round((safeNumber(premiumRow[4]) ?? 0) * 10_000, 6) : null;
    const markPriceUsd = safeNumber(markRow?.[4]) ?? safeNumber(fundingRow?.markPrice);
    const indexPriceUsd = safeNumber(indexRow?.[4]);
    const markIndexBasisBps = markPriceUsd !== null && indexPriceUsd !== null && indexPriceUsd !== 0
      ? round(((markPriceUsd - indexPriceUsd) / indexPriceUsd) * 10_000, 6)
      : premiumIndexBps;
    const basisBps = markIndexBasisBps ?? premiumIndexBps;
    const crowdingScore = deriveCrowdingScore({
      fundingRatePct8h,
      openInterestChangePct,
      globalLongShortRatio,
      topAccountRatio,
      topPositionRatio,
      takerImbalance,
      basisBps,
    });

    return {
      timestamp,
      source: "binance-historical-derived",
      microstructure: buildMarketMicrostructure({
        fundingRatePct8h,
        openInterestUsd,
        openInterestChangePct,
        longShortRatio: globalLongShortRatio,
        takerImbalance,
        liquidationBias: null,
        liquidationIntensity: null,
        crossVenueBasisBps: basisBps,
        crowdingScore,
        markPriceUsd,
        indexPriceUsd,
        premiumIndexBps,
        markIndexBasisBps,
      }),
      rawPayload: {
        fundingRate: fundingRow ?? null,
        openInterestHist: oiRow ?? null,
        globalLongShortAccountRatio: globalRatioRow ?? null,
        topLongShortAccountRatio: topAccountRow ?? null,
        topLongShortPositionRatio: topPositionRow ?? null,
        takerLongShortRatio: takerRow ?? null,
        premiumIndexKline: premiumRow ?? null,
        markPriceKline: markRow ?? null,
        indexPriceKline: indexRow ?? null,
      },
    };
  });

  const result = {
    createdAt: new Date().toISOString(),
    symbol,
    period,
    premiumArchivesDir: premiumArchivesDir ?? null,
    markArchivesDir: markArchivesDir ?? null,
    indexArchivesDir: indexArchivesDir ?? null,
    startTime,
    endTime,
    recentDerivedWindow: {
      openInterestHistory: {
        availableRows: openInterestHistory.length,
        matchedRows: filteredOpenInterestHistory.length,
      },
      globalLongShortRatios: {
        availableRows: globalLongShortRatios.length,
        matchedRows: filteredGlobalLongShortRatios.length,
      },
      topLongShortAccountRatios: {
        availableRows: topLongShortAccountRatios.length,
        matchedRows: filteredTopLongShortAccountRatios.length,
      },
      topLongShortPositionRatios: {
        availableRows: topLongShortPositionRatios.length,
        matchedRows: filteredTopLongShortPositionRatios.length,
      },
      takerRatios: {
        availableRows: takerRatios.length,
        matchedRows: filteredTakerRatios.length,
      },
    },
    counts: {
      fundingRates: fundingRates.length,
      openInterestHistory: filteredOpenInterestHistory.length,
      globalLongShortRatios: filteredGlobalLongShortRatios.length,
      topLongShortAccountRatios: filteredTopLongShortAccountRatios.length,
      topLongShortPositionRatios: filteredTopLongShortPositionRatios.length,
      takerRatios: filteredTakerRatios.length,
      premiumIndexKlines: premiumIndexKlines.length,
      markPriceKlines: markPriceKlines.length,
      indexPriceKlines: indexPriceKlines.length,
      mergedSnapshots: snapshots.length,
    },
    snapshots,
  };

  if (writeFile) {
    await ensureParentDirectory(output);
    await writeJson(output, result);
  }

  console.log(JSON.stringify({
    output: writeFile ? output : null,
    createdAt: result.createdAt,
    symbol,
    period,
    premiumArchivesDir: premiumArchivesDir ?? null,
    startTime,
    endTime,
    counts: result.counts,
    snapshots: includeSnapshotsInStdout ? snapshots : undefined,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
