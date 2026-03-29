import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import readline from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
import type { MarketMicrostructure } from "../../src/lib/strategy-core";
import { ensureParentDirectory, loadCandleDatasetFromCsv, writeJson } from "./shared";

const execFileAsync = promisify(execFile);

export interface PreparedTrainingDatasetResult {
  output: string;
  reportPath: string;
  monthsIncluded: string[];
  rawRows: number;
  cleanedRows: number;
  qualityScore: number;
  snapshotsOutput: string | null;
  snapshotCount: number;
  snapshotSources: string[];
}

interface HistoricalSnapshotRecord {
  timestamp: number;
  source: string;
  microstructure: MarketMicrostructure | null;
  rawPayload?: Record<string, unknown>;
}

interface AggTradeBucket {
  timestamp: number;
  totalNotionalUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  tradeCount: number;
  closePrice: number | null;
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

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: string) {
  if (stream.write(chunk)) {
    return;
  }
  await once(stream, "drain");
}

function monthFromZipName(fileName: string) {
  const match = fileName.match(/(\d{4}-\d{2})\.zip$/);
  return match ? match[1] : fileName;
}

async function appendKlineArchive(zipPath: string, stream: ReturnType<typeof createWriteStream>, writeHeader: boolean) {
  const { stdout } = await execFileAsync("unzip", ["-p", zipPath], {
    maxBuffer: 512 * 1024 * 1024,
  });
  let headerWritten = !writeHeader;
  let rowCount = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.toLowerCase();
    if (normalized.startsWith("open_time,")) {
      if (!headerWritten) {
        await writeChunk(stream, "timestamp,open,high,low,close,volume\n");
        headerWritten = true;
      }
      continue;
    }

    const parts = line.split(",");
    if (parts.length < 6) {
      continue;
    }
    if (!headerWritten) {
      await writeChunk(stream, "timestamp,open,high,low,close,volume\n");
      headerWritten = true;
    }
    await writeChunk(stream, `${parts[0]},${parts[1]},${parts[2]},${parts[3]},${parts[4]},${parts[5]}\n`);
    rowCount += 1;
  }

  return rowCount;
}

export async function exportSnapshotsFromJsonl(jsonlPath: string, outputPath: string) {
  const snapshots = await loadSnapshotsFromJsonl(jsonlPath);
  await writeJson(outputPath, {
    createdAt: new Date().toISOString(),
    snapshots,
  });
  return snapshots.length;
}

async function loadSnapshotsFromJsonl(jsonlPath: string) {
  const snapshots: unknown[] = [];
  const input = createReadStream(jsonlPath, { encoding: "utf8" });
  input.on("error", () => {
    // handled below through async iteration completion
  });
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.snapshot && typeof parsed.snapshot === "object") {
          snapshots.push(parsed.snapshot);
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return snapshots;
}

function parseAggTradeHeader(header: string[]) {
  const normalized = header.map((value) => value.trim().toLowerCase());
  const indexOf = (aliases: string[]) => normalized.findIndex((value) => aliases.includes(value));
  return {
    price: indexOf(["price", "p"]),
    quantity: indexOf(["quantity", "qty", "q"]),
    timestamp: indexOf(["transact_time", "timestamp", "time", "t"]),
    isBuyerMaker: indexOf(["is_buyer_maker", "m"]),
  };
}

function round(value: number, precision = 6) {
  return Number(value.toFixed(precision));
}

function parseSnapshotTimestamp(record: Record<string, unknown>) {
  const candidates = [record.timestamp, record.fetchedAt, record.created_at, record.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function snapshotCompleteness(entry: HistoricalSnapshotRecord) {
  if (!entry.microstructure) return 0;
  return Object.values(entry.microstructure).filter((value) => value !== null && value !== undefined).length;
}

function mergeMicrostructure(
  left: MarketMicrostructure | null,
  right: MarketMicrostructure | null,
) {
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

export function aggregateAggTradeCsvLines(lines: string[]) {
  const buckets = new Map<number, AggTradeBucket>();
  let headerIndexes: ReturnType<typeof parseAggTradeHeader> | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 7) continue;

    if (headerIndexes === null) {
      const maybeHeader = parseAggTradeHeader(parts);
      if (maybeHeader.price >= 0 && maybeHeader.quantity >= 0 && maybeHeader.timestamp >= 0 && maybeHeader.isBuyerMaker >= 0) {
        headerIndexes = maybeHeader;
        continue;
      }
      headerIndexes = {
        price: 1,
        quantity: 2,
        timestamp: 5,
        isBuyerMaker: 6,
      };
    }

    const price = Number(parts[headerIndexes.price]);
    const quantity = Number(parts[headerIndexes.quantity]);
    const timestamp = Number(parts[headerIndexes.timestamp]);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || !Number.isFinite(timestamp)) {
      continue;
    }
    const isBuyerMaker = String(parts[headerIndexes.isBuyerMaker]).trim().toLowerCase() === "true";
    const minuteTimestamp = Math.floor(timestamp / 60_000) * 60_000;
    const notionalUsd = price * quantity;
    const bucket = buckets.get(minuteTimestamp) ?? {
      timestamp: minuteTimestamp,
      totalNotionalUsd: 0,
      buyNotionalUsd: 0,
      sellNotionalUsd: 0,
      tradeCount: 0,
      closePrice: null,
    };
    bucket.totalNotionalUsd += notionalUsd;
    if (isBuyerMaker) {
      bucket.sellNotionalUsd += notionalUsd;
    } else {
      bucket.buyNotionalUsd += notionalUsd;
    }
    bucket.tradeCount += 1;
    bucket.closePrice = price;
    buckets.set(minuteTimestamp, bucket);
  }

  return [...buckets.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map<HistoricalSnapshotRecord>((bucket) => {
      const takerImbalance = bucket.totalNotionalUsd === 0
        ? null
        : round((bucket.buyNotionalUsd - bucket.sellNotionalUsd) / bucket.totalNotionalUsd, 6);
      return {
        timestamp: bucket.timestamp,
        source: "binance-aggtrades",
        microstructure: {
          primaryBook: null,
          secondaryBook: null,
          fundingRatePct8h: null,
          openInterestUsd: null,
          openInterestChangePct: null,
          longShortRatio: null,
          takerImbalance,
          liquidationBias: null,
          liquidationIntensity: null,
          crossVenueBasisBps: null,
          crowdingScore: bucket.totalNotionalUsd > 0 ? round(Math.log10(bucket.totalNotionalUsd + 1), 6) : null,
        },
        rawPayload: {
          tradeCount: bucket.tradeCount,
          totalNotionalUsd: round(bucket.totalNotionalUsd, 6),
          buyNotionalUsd: round(bucket.buyNotionalUsd, 6),
          sellNotionalUsd: round(bucket.sellNotionalUsd, 6),
          closePrice: bucket.closePrice,
        },
      };
    });
}

async function loadAggTradeSnapshotsFromArchives(aggTradesDir: string) {
  const files = await readdir(aggTradesDir)
    .then((entries) => entries.filter((file) => file.endsWith(".zip")).sort((left, right) => left.localeCompare(right)))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  if (files.length === 0) {
    return [];
  }

  const snapshots: HistoricalSnapshotRecord[] = [];
  for (const file of files) {
    const zipPath = path.join(aggTradesDir, file);
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath], {
      maxBuffer: 512 * 1024 * 1024,
    });
    snapshots.push(...aggregateAggTradeCsvLines(stdout.split(/\r?\n/)));
  }

  return mergeSnapshotEntries(snapshots);
}

export async function buildUnifiedTrainingDataset(options: {
  klinesDir: string;
  output: string;
  reportPath?: string;
  snapshotsJsonl?: string;
  aggTradesDir?: string;
  snapshotsOutput?: string;
  intervalMs?: number;
  maxSyntheticGapBars?: number;
  suspiciousMovePct?: number;
}) : Promise<PreparedTrainingDatasetResult> {
  const files = (await readdir(options.klinesDir))
    .filter((file) => file.endsWith(".zip"))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error(`No .zip kline archives found in ${options.klinesDir}`);
  }

  await ensureParentDirectory(options.output);
  const tmpOutput = `${options.output}.raw`;
  const stream = createWriteStream(tmpOutput, { encoding: "utf8" });
  let rawRows = 0;
  const monthsIncluded: string[] = [];

  try {
    for (const [index, file] of files.entries()) {
      rawRows += await appendKlineArchive(path.join(options.klinesDir, file), stream, index === 0);
      monthsIncluded.push(monthFromZipName(file));
    }
  } finally {
    stream.end();
    await once(stream, "finish");
  }

  const dataset = await loadCandleDatasetFromCsv(tmpOutput, {
    intervalMs: options.intervalMs ?? 60_000,
    maxSyntheticGapBars: options.maxSyntheticGapBars ?? 3,
    suspiciousMovePct: options.suspiciousMovePct ?? 3.5,
  });
  await writeFile(options.output, `${candlesToCsv(dataset.candles)}\n`, "utf8");
  await rm(tmpOutput, { force: true });

  const reportPath = options.reportPath ?? options.output.replace(/\.csv$/i, "-quality.json");
  const mergedSnapshots: HistoricalSnapshotRecord[] = [];
  const snapshotSources: string[] = [];
  let snapshotsOutput: string | null = null;
  if (options.snapshotsJsonl) {
    const jsonlSnapshots = await loadSnapshotsFromJsonl(options.snapshotsJsonl);
    for (const snapshot of jsonlSnapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const record = snapshot as Record<string, unknown>;
      const timestamp = parseSnapshotTimestamp(record);
      const microstructure = record.microstructure && typeof record.microstructure === "object"
        ? record.microstructure as unknown as MarketMicrostructure
        : null;
      if (timestamp === null) continue;
      mergedSnapshots.push({
        timestamp,
        source: "live-jsonl",
        microstructure,
        rawPayload: record,
      });
    }
    if (jsonlSnapshots.length > 0) {
      snapshotSources.push("live-jsonl");
    }
  }
  if (options.aggTradesDir) {
    const aggTradeSnapshots = await loadAggTradeSnapshotsFromArchives(options.aggTradesDir);
    mergedSnapshots.push(...aggTradeSnapshots);
    if (aggTradeSnapshots.length > 0) {
      snapshotSources.push("binance-aggtrades");
    }
  }
  const finalSnapshots = mergeSnapshotEntries(mergedSnapshots);
  const snapshotCount = finalSnapshots.length;
  if (snapshotCount > 0 && options.snapshotsOutput) {
    snapshotsOutput = options.snapshotsOutput;
    await ensureParentDirectory(snapshotsOutput);
    await writeJson(snapshotsOutput, {
      createdAt: new Date().toISOString(),
      snapshots: finalSnapshots.map((entry) => ({
        timestamp: entry.timestamp,
        source: entry.source,
        microstructure: entry.microstructure,
        rawPayload: entry.rawPayload ?? null,
      })),
    });
  }

  await writeJson(reportPath, {
    createdAt: new Date().toISOString(),
    klinesDir: options.klinesDir,
    monthsIncluded,
    rawRows,
    cleanedRows: dataset.candles.length,
    quality: dataset.quality,
    snapshotsOutput,
    snapshotCount,
    snapshotSources,
  });

  return {
    output: options.output,
    reportPath,
    monthsIncluded,
    rawRows,
    cleanedRows: dataset.candles.length,
    qualityScore: dataset.quality.qualityScore,
    snapshotsOutput,
    snapshotCount,
    snapshotSources,
  };
}
