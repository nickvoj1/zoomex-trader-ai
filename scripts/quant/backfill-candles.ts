import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureParentDirectory,
  loadCandleDatasetFromCsv,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
  writeJson,
} from "./shared";

const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";
const MAX_LIMIT = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BinanceKlineRow extends Array<string | number> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

function parseTimestampArg(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

function intervalToMs(interval: string) {
  const match = interval.trim().match(/^(\d+)([mhdw])$/i);
  if (!match) {
    throw new Error(`Unsupported interval: ${interval}`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m"
    ? 60_000
    : unit === "h"
      ? 60 * 60_000
      : unit === "d"
        ? 24 * 60 * 60_000
        : 7 * 24 * 60 * 60_000;
  return value * multiplier;
}

async function fetchKlines(symbol: string, interval: string, startTime: number, endTime: number) {
  const allRows: BinanceKlineRow[] = [];
  let nextStartTime = startTime;

  while (nextStartTime < endTime) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(nextStartTime),
      endTime: String(endTime),
      limit: String(MAX_LIMIT),
    });
    const response = await fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Binance kline request failed with ${response.status}`);
    }

    const rows = await response.json() as BinanceKlineRow[];
    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    allRows.push(...rows);
    const lastOpenTime = Number(rows[rows.length - 1][0]);
    if (!Number.isFinite(lastOpenTime)) {
      break;
    }
    const next = lastOpenTime + intervalToMs(interval);
    if (next <= nextStartTime) {
      break;
    }
    nextStartTime = next;

    if (rows.length < MAX_LIMIT) {
      break;
    }
  }

  return allRows;
}

function rowsToCsv(rows: BinanceKlineRow[]) {
  const header = "timestamp,open,high,low,close,volume";
  const lines = rows.map((row) => [row[0], row[1], row[2], row[3], row[4], row[5]].join(","));
  return [header, ...lines].join("\n");
}

function candlesToCsv(
  candles: Array<{ timestamp?: number; open: number; high: number; low: number; close: number; volume: number }>,
) {
  const header = "timestamp,open,high,low,close,volume";
  const lines = candles.map((candle) =>
    [
      candle.timestamp ?? "",
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const interval = stringArg(args, "interval", "1m")!;
  const intervalMs = intervalToMs(interval);
  const now = Date.now();
  const defaultStart = now - 90 * DAY_MS;
  const startTime = parseTimestampArg(stringArg(args, "start"), defaultStart);
  const endTime = parseTimestampArg(stringArg(args, "end"), now);
  if (endTime <= startTime) {
    throw new Error("--end must be after --start");
  }

  const output = stringArg(
    args,
    "output",
    path.join("research", timestampedFile(`${symbol.toLowerCase()}-${interval}-backfill`, "csv")),
  )!;
  const reportPath = stringArg(args, "report", output.replace(/\.csv$/i, "-quality.json"))!;

  const rows = await fetchKlines(symbol, interval, startTime, endTime);
  if (rows.length === 0) {
    throw new Error("No klines returned from Binance");
  }

  await ensureParentDirectory(output);
  await writeFile(output, `${rowsToCsv(rows)}\n`, "utf8");
  const dataset = await loadCandleDatasetFromCsv(output, {
    intervalMs,
    maxSyntheticGapBars: numberArg(args, "max-synthetic-gap-bars", interval === "1m" ? 3 : 1),
    suspiciousMovePct: numberArg(args, "suspicious-move-pct", interval === "1m" ? 3.5 : 6),
  });
  await writeFile(output, `${candlesToCsv(dataset.candles)}\n`, "utf8");
  await writeJson(reportPath, {
    createdAt: new Date().toISOString(),
    symbol,
    interval,
    startTime,
    endTime,
    requestedDays: Number(((endTime - startTime) / DAY_MS).toFixed(2)),
    fetchedRows: rows.length,
    cleanedRows: dataset.candles.length,
    quality: dataset.quality,
  });

  console.log(JSON.stringify({
    symbol,
    interval,
    output,
    reportPath,
    fetchedRows: rows.length,
    cleanedRows: dataset.candles.length,
    qualityScore: dataset.quality.qualityScore,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
