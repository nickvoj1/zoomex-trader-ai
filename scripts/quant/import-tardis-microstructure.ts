import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import {
  buildMarketMicrostructure,
  type MarketMicrostructure,
  type OrderBookLevel,
  summarizeOrderBook,
} from "../../src/lib/strategy-core";
import { booleanArg, csvStringArg, numberArg, parseArgs, stringArg, writeJson } from "./shared";

interface HistoricalSnapshotRecord {
  timestamp: number;
  source: string;
  microstructure: MarketMicrostructure | null;
  rawPayload?: Record<string, unknown>;
}

interface TradeBucket {
  totalNotionalUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  count: number;
}

interface LiquidationBucket {
  longUsd: number;
  shortUsd: number;
  count: number;
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDivide(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function parseMicrosToMs(value: unknown) {
  const numeric = safeNumber(value);
  return numeric === null ? null : Math.floor(numeric / 1_000);
}

function alignTimestamp(timestampMs: number, intervalMs: number) {
  return Math.floor(timestampMs / intervalMs) * intervalMs;
}

function parseBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeFundingPct(value: number | null) {
  if (value === null) return null;
  return Math.abs(value) <= 1 ? round(value * 100, 8) : round(value, 8);
}

function snapshotCompleteness(entry: HistoricalSnapshotRecord) {
  if (!entry.microstructure) return 0;
  return Object.values(entry.microstructure).filter((value) => value !== null && value !== undefined).length;
}

function mergeMicrostructure(left: MarketMicrostructure | null, right: MarketMicrostructure | null) {
  if (!left) return right;
  if (!right) return left;
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as MarketMicrostructure;
}

function mergeSnapshotEntries(entries: HistoricalSnapshotRecord[]) {
  const byTimestamp = new Map<number, HistoricalSnapshotRecord>();
  const sorted = [...entries].sort((left, right) => left.timestamp - right.timestamp);

  for (const entry of sorted) {
    const existing = byTimestamp.get(entry.timestamp);
    if (!existing) {
      byTimestamp.set(entry.timestamp, entry);
      continue;
    }

    const preferred = snapshotCompleteness(entry) >= snapshotCompleteness(existing) ? entry : existing;
    const secondary = preferred === entry ? existing : entry;
    byTimestamp.set(entry.timestamp, {
      timestamp: entry.timestamp,
      source: [existing.source, entry.source].filter(Boolean).join("+"),
      microstructure: mergeMicrostructure(secondary.microstructure, preferred.microstructure),
      rawPayload: {
        primary: preferred.rawPayload ?? null,
        secondary: secondary.rawPayload ?? null,
      },
    });
  }

  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

async function collectCsvFiles(inputPath: string): Promise<string[]> {
  const info = await stat(inputPath).catch(() => null);
  if (!info) return [];
  if (info.isFile()) {
    return /\.(csv|csv\.gz)$/i.test(inputPath) ? [inputPath] : [];
  }

  const entries = await readdir(inputPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCsvFiles(nextPath));
      continue;
    }
    if (/\.(csv|csv\.gz)$/i.test(entry.name)) {
      files.push(nextPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function splitCsvLine(line: string) {
  return line.split(",");
}

async function streamCsvFile(
  filePath: string,
  onHeader: (header: string[]) => void,
  onRow: (row: string[]) => void,
) {
  const input = createReadStream(filePath);
  const stream = filePath.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = splitCsvLine(line);
    if (!headerParsed) {
      onHeader(parts.map((value) => value.trim()));
      headerParsed = true;
      continue;
    }
    onRow(parts);
  }
}

function topLevelsFromMap(levels: Map<number, number>, descending: boolean, limit: number) {
  return [...levels.entries()]
    .filter(([, size]) => Number.isFinite(size) && size > 0)
    .sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0])
    .slice(0, limit)
    .map<OrderBookLevel>(([price, size]) => ({ price, size }));
}

function upsertRecord(
  target: HistoricalSnapshotRecord[],
  timestamp: number,
  source: string,
  microstructure: MarketMicrostructure | null,
  rawPayload?: Record<string, unknown>,
) {
  target.push({
    timestamp,
    source,
    microstructure,
    rawPayload,
  });
}

async function importDerivativeTicker(options: {
  files: string[];
  exchange: string;
  symbol: string;
  intervalMs: number;
  openInterestUnit: "usd" | "base" | "contracts";
  openInterestContractMultiplier: number;
  includeRawPayload: boolean;
}) {
  const records: HistoricalSnapshotRecord[] = [];

  for (const filePath of options.files) {
    let headerIndex = new Map<string, number>();
    await streamCsvFile(filePath, (header) => {
      headerIndex = new Map(header.map((value, index) => [value, index]));
    }, (row) => {
      const timestampMs = parseMicrosToMs(row[headerIndex.get("timestamp") ?? -1]);
      if (timestampMs === null) return;
      const bucket = alignTimestamp(timestampMs, options.intervalMs);
      const markPriceUsd = safeNumber(row[headerIndex.get("mark_price") ?? -1]);
      const indexPriceUsd = safeNumber(row[headerIndex.get("index_price") ?? -1]);
      const lastPriceUsd = safeNumber(row[headerIndex.get("last_price") ?? -1]);
      const referencePrice = markPriceUsd ?? indexPriceUsd ?? lastPriceUsd;
      const rawOpenInterest = safeNumber(row[headerIndex.get("open_interest") ?? -1]);
      let openInterestUsd: number | null = null;
      if (rawOpenInterest !== null && referencePrice !== null) {
        if (options.openInterestUnit === "usd") {
          openInterestUsd = rawOpenInterest;
        } else if (options.openInterestUnit === "base") {
          openInterestUsd = rawOpenInterest * referencePrice;
        } else {
          openInterestUsd = rawOpenInterest * options.openInterestContractMultiplier * referencePrice;
        }
      }
      const fundingRatePct8h = normalizeFundingPct(safeNumber(row[headerIndex.get("funding_rate") ?? -1]));
      const premiumIndexBps = markPriceUsd !== null && indexPriceUsd !== null && indexPriceUsd !== 0
        ? round(((markPriceUsd - indexPriceUsd) / indexPriceUsd) * 10_000, 6)
        : null;
      upsertRecord(
        records,
        bucket,
        "tardis-derivative-ticker",
        buildMarketMicrostructure({
          fundingRatePct8h,
          openInterestUsd,
          markPriceUsd,
          indexPriceUsd,
          premiumIndexBps,
          markIndexBasisBps: premiumIndexBps,
          crossVenueBasisBps: premiumIndexBps,
        }),
        options.includeRawPayload
          ? {
            exchange: options.exchange,
            symbol: options.symbol,
            funding_rate: safeNumber(row[headerIndex.get("funding_rate") ?? -1]),
            open_interest: rawOpenInterest,
            mark_price: markPriceUsd,
            index_price: indexPriceUsd,
            last_price: lastPriceUsd,
          }
          : undefined,
      );
    });
  }

  return mergeSnapshotEntries(records);
}

async function importBookSnapshots(options: {
  files: string[];
  exchange: string;
  intervalMs: number;
  depthLevels: number;
  includeRawPayload: boolean;
}) {
  const records: HistoricalSnapshotRecord[] = [];

  for (const filePath of options.files) {
    let header: string[] = [];
    await streamCsvFile(filePath, (nextHeader) => {
      header = nextHeader;
    }, (row) => {
      const timestampMs = parseMicrosToMs(row[header.indexOf("timestamp")]);
      if (timestampMs === null) return;
      const bucket = alignTimestamp(timestampMs, options.intervalMs);
      const bids: OrderBookLevel[] = [];
      const asks: OrderBookLevel[] = [];

      for (let level = 0; level < options.depthLevels; level += 1) {
        const askPrice = safeNumber(row[header.indexOf(`asks[${level}].price`)]);
        const askAmount = safeNumber(row[header.indexOf(`asks[${level}].amount`)]);
        const bidPrice = safeNumber(row[header.indexOf(`bids[${level}].price`)]);
        const bidAmount = safeNumber(row[header.indexOf(`bids[${level}].amount`)]);
        if (askPrice !== null && askAmount !== null && askAmount > 0) {
          asks.push({ price: askPrice, size: askAmount });
        }
        if (bidPrice !== null && bidAmount !== null && bidAmount > 0) {
          bids.push({ price: bidPrice, size: bidAmount });
        }
      }

      const primaryBook = summarizeOrderBook(options.exchange, bids, asks, bucket);
      if (!primaryBook) return;
      upsertRecord(
        records,
        bucket,
        "tardis-book-snapshot",
        buildMarketMicrostructure({ primaryBook }),
        options.includeRawPayload ? { filePath, bids, asks } : undefined,
      );
    });
  }

  return mergeSnapshotEntries(records);
}

async function importIncrementalBook(options: {
  files: string[];
  exchange: string;
  intervalMs: number;
  depthLevels: number;
  includeRawPayload: boolean;
}) {
  const records: HistoricalSnapshotRecord[] = [];

  for (const filePath of options.files) {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    let headerIndex = new Map<string, number>();
    let initialized = false;
    let previousWasSnapshot = false;
    let currentBucket: number | null = null;

    const emitCurrentBook = () => {
      if (!initialized || currentBucket === null) return;
      const bidLevels = topLevelsFromMap(bids, true, options.depthLevels);
      const askLevels = topLevelsFromMap(asks, false, options.depthLevels);
      const primaryBook = summarizeOrderBook(options.exchange, bidLevels, askLevels, currentBucket);
      if (!primaryBook) return;
      upsertRecord(
        records,
        currentBucket,
        "tardis-incremental-book-l2",
        buildMarketMicrostructure({ primaryBook }),
        options.includeRawPayload
          ? {
            filePath,
            levelsCaptured: {
              bids: bidLevels.length,
              asks: askLevels.length,
            },
          }
          : undefined,
      );
    };

    await streamCsvFile(filePath, (header) => {
      headerIndex = new Map(header.map((value, index) => [value, index]));
    }, (row) => {
      const timestampMs = parseMicrosToMs(row[headerIndex.get("timestamp") ?? -1]);
      if (timestampMs === null) return;
      const bucket = alignTimestamp(timestampMs, options.intervalMs);
      if (currentBucket !== null && bucket !== currentBucket) {
        emitCurrentBook();
      }

      const isSnapshot = parseBoolean(row[headerIndex.get("is_snapshot") ?? -1]);
      if (isSnapshot && !previousWasSnapshot) {
        bids.clear();
        asks.clear();
        initialized = true;
      }
      previousWasSnapshot = isSnapshot;
      if (!initialized) {
        currentBucket = bucket;
        return;
      }

      const side = String(row[headerIndex.get("side") ?? -1] ?? "").trim().toLowerCase();
      const price = safeNumber(row[headerIndex.get("price") ?? -1]);
      const amount = safeNumber(row[headerIndex.get("amount") ?? -1]);
      if (price === null || amount === null) {
        currentBucket = bucket;
        return;
      }

      const target = side.startsWith("b") ? bids : asks;
      if (amount <= 0) {
        target.delete(price);
      } else {
        target.set(price, amount);
      }

      currentBucket = bucket;
    });

    if (currentBucket !== null) {
      const bidLevels = topLevelsFromMap(bids, true, options.depthLevels);
      const askLevels = topLevelsFromMap(asks, false, options.depthLevels);
      const primaryBook = summarizeOrderBook(options.exchange, bidLevels, askLevels, currentBucket);
      if (primaryBook) {
        upsertRecord(
          records,
          currentBucket,
          "tardis-incremental-book-l2",
          buildMarketMicrostructure({ primaryBook }),
          options.includeRawPayload ? { filePath } : undefined,
        );
      }
    }
  }

  return mergeSnapshotEntries(records);
}

async function importTrades(options: {
  files: string[];
  intervalMs: number;
  includeRawPayload: boolean;
}) {
  const buckets = new Map<number, TradeBucket>();

  for (const filePath of options.files) {
    let headerIndex = new Map<string, number>();
    await streamCsvFile(filePath, (header) => {
      headerIndex = new Map(header.map((value, index) => [value, index]));
    }, (row) => {
      const timestampMs = parseMicrosToMs(row[headerIndex.get("timestamp") ?? -1]);
      const price = safeNumber(row[headerIndex.get("price") ?? -1]);
      const amount = safeNumber(row[headerIndex.get("amount") ?? -1]);
      if (timestampMs === null || price === null || amount === null) return;
      const bucket = alignTimestamp(timestampMs, options.intervalMs);
      const side = String(row[headerIndex.get("side") ?? -1] ?? "").trim().toLowerCase();
      const notionalUsd = price * amount;
      const current = buckets.get(bucket) ?? {
        totalNotionalUsd: 0,
        buyNotionalUsd: 0,
        sellNotionalUsd: 0,
        count: 0,
      };
      current.totalNotionalUsd += notionalUsd;
      if (side.startsWith("b")) {
        current.buyNotionalUsd += notionalUsd;
      } else if (side.startsWith("s")) {
        current.sellNotionalUsd += notionalUsd;
      }
      current.count += 1;
      buckets.set(bucket, current);
    });
  }

  return mergeSnapshotEntries([...buckets.entries()].map(([timestamp, bucket]) => {
    const takerImbalance = bucket.totalNotionalUsd > 0
      ? round(safeDivide(bucket.buyNotionalUsd - bucket.sellNotionalUsd, bucket.totalNotionalUsd), 6)
      : null;
    return {
      timestamp,
      source: "tardis-trades",
      microstructure: buildMarketMicrostructure({
        takerImbalance,
        crowdingScore: bucket.totalNotionalUsd > 0 ? round(Math.log10(bucket.totalNotionalUsd + 1), 6) : null,
      }),
      rawPayload: options.includeRawPayload
        ? {
          totalNotionalUsd: round(bucket.totalNotionalUsd, 6),
          buyNotionalUsd: round(bucket.buyNotionalUsd, 6),
          sellNotionalUsd: round(bucket.sellNotionalUsd, 6),
          tradeCount: bucket.count,
        }
        : undefined,
    };
  }));
}

async function importLiquidations(options: {
  files: string[];
  intervalMs: number;
  includeRawPayload: boolean;
}) {
  const buckets = new Map<number, LiquidationBucket>();

  for (const filePath of options.files) {
    let headerIndex = new Map<string, number>();
    await streamCsvFile(filePath, (header) => {
      headerIndex = new Map(header.map((value, index) => [value, index]));
    }, (row) => {
      const timestampMs = parseMicrosToMs(row[headerIndex.get("timestamp") ?? -1]);
      const price = safeNumber(row[headerIndex.get("price") ?? -1]);
      const amount = safeNumber(row[headerIndex.get("amount") ?? -1]);
      if (timestampMs === null || price === null || amount === null) return;
      const bucket = alignTimestamp(timestampMs, options.intervalMs);
      const side = String(row[headerIndex.get("side") ?? -1] ?? "").trim().toLowerCase();
      const notionalUsd = price * amount;
      const current = buckets.get(bucket) ?? {
        longUsd: 0,
        shortUsd: 0,
        count: 0,
      };
      if (side.startsWith("b")) {
        current.shortUsd += notionalUsd;
      } else if (side.startsWith("s")) {
        current.longUsd += notionalUsd;
      }
      current.count += 1;
      buckets.set(bucket, current);
    });
  }

  return mergeSnapshotEntries([...buckets.entries()].map(([timestamp, bucket]) => {
    const totalUsd = bucket.longUsd + bucket.shortUsd;
    return {
      timestamp,
      source: "tardis-liquidations",
      microstructure: buildMarketMicrostructure({
        liquidationBias: totalUsd > 0 ? round(safeDivide(bucket.shortUsd - bucket.longUsd, totalUsd), 6) : null,
        liquidationIntensity: totalUsd > 0 ? round(Math.log10(totalUsd + 1), 6) : null,
      }),
      rawPayload: options.includeRawPayload
        ? {
          longLiquidationsUsd: round(bucket.longUsd, 6),
          shortLiquidationsUsd: round(bucket.shortUsd, 6),
          totalLiquidationsUsd: round(totalUsd, 6),
          liquidationCount: bucket.count,
        }
        : undefined,
    };
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exchange = stringArg(args, "exchange", "binance-futures")!;
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const intervalMs = Math.max(1_000, numberArg(args, "interval-ms", 60_000));
  const depthLevels = Math.max(1, numberArg(args, "depth-levels", 25));
  const openInterestUnit = stringArg(args, "open-interest-unit", "base") as "usd" | "base" | "contracts";
  const openInterestContractMultiplier = Math.max(0.0000001, numberArg(args, "open-interest-contract-multiplier", 1));
  const includeRawPayload = booleanArg(args, "include-raw-payload", false);
  const output = stringArg(args, "output", `research/datasets/${exchange}-${symbol}-tardis-microstructure.json`)!;

  const derivativeInputs = csvStringArg(args, "derivative-inputs");
  const bookInputs = csvStringArg(args, "book-inputs");
  const incrementalBookInputs = csvStringArg(args, "incremental-book-inputs");
  const tradesInputs = csvStringArg(args, "trades-inputs");
  const liquidationsInputs = csvStringArg(args, "liquidations-inputs");

  if (
    derivativeInputs.length === 0 &&
    bookInputs.length === 0 &&
    incrementalBookInputs.length === 0 &&
    tradesInputs.length === 0 &&
    liquidationsInputs.length === 0
  ) {
    throw new Error("Provide at least one input: --derivative-inputs, --book-inputs, --incremental-book-inputs, --trades-inputs, or --liquidations-inputs");
  }

  const [
    derivativeFiles,
    bookFiles,
    incrementalBookFiles,
    tradeFiles,
    liquidationFiles,
  ] = await Promise.all([
    Promise.all(derivativeInputs.map((input) => collectCsvFiles(input))).then((groups) => groups.flat()),
    Promise.all(bookInputs.map((input) => collectCsvFiles(input))).then((groups) => groups.flat()),
    Promise.all(incrementalBookInputs.map((input) => collectCsvFiles(input))).then((groups) => groups.flat()),
    Promise.all(tradesInputs.map((input) => collectCsvFiles(input))).then((groups) => groups.flat()),
    Promise.all(liquidationsInputs.map((input) => collectCsvFiles(input))).then((groups) => groups.flat()),
  ]);

  const [
    derivativeSnapshots,
    bookSnapshots,
    incrementalBookSnapshots,
    tradeSnapshots,
    liquidationSnapshots,
  ] = await Promise.all([
    derivativeFiles.length > 0
      ? importDerivativeTicker({
        files: derivativeFiles,
        exchange,
        symbol,
        intervalMs,
        openInterestUnit,
        openInterestContractMultiplier,
        includeRawPayload,
      })
      : Promise.resolve([]),
    bookFiles.length > 0
      ? importBookSnapshots({
        files: bookFiles,
        exchange,
        intervalMs,
        depthLevels,
        includeRawPayload,
      })
      : Promise.resolve([]),
    incrementalBookFiles.length > 0
      ? importIncrementalBook({
        files: incrementalBookFiles,
        exchange,
        intervalMs,
        depthLevels,
        includeRawPayload,
      })
      : Promise.resolve([]),
    tradeFiles.length > 0
      ? importTrades({
        files: tradeFiles,
        intervalMs,
        includeRawPayload,
      })
      : Promise.resolve([]),
    liquidationFiles.length > 0
      ? importLiquidations({
        files: liquidationFiles,
        intervalMs,
        includeRawPayload,
      })
      : Promise.resolve([]),
  ]);

  const snapshots = mergeSnapshotEntries([
    ...derivativeSnapshots,
    ...bookSnapshots,
    ...incrementalBookSnapshots,
    ...tradeSnapshots,
    ...liquidationSnapshots,
  ]);

  const result = {
    createdAt: new Date().toISOString(),
    provider: "tardis",
    exchange,
    symbol,
    intervalMs,
    depthLevels,
    counts: {
      derivativeFiles: derivativeFiles.length,
      bookFiles: bookFiles.length,
      incrementalBookFiles: incrementalBookFiles.length,
      tradeFiles: tradeFiles.length,
      liquidationFiles: liquidationFiles.length,
      derivativeSnapshots: derivativeSnapshots.length,
      bookSnapshots: bookSnapshots.length,
      incrementalBookSnapshots: incrementalBookSnapshots.length,
      tradeSnapshots: tradeSnapshots.length,
      liquidationSnapshots: liquidationSnapshots.length,
      mergedSnapshots: snapshots.length,
    },
    snapshots,
  };

  await writeJson(output, result);
  console.log(JSON.stringify({
    output,
    createdAt: result.createdAt,
    provider: result.provider,
    exchange,
    symbol,
    counts: result.counts,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
