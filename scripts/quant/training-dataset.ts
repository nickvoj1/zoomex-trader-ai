import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import readline from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
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
  const snapshots: unknown[] = [];
  const rl = readline.createInterface({
    input: createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

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

  await writeJson(outputPath, {
    createdAt: new Date().toISOString(),
    snapshots,
  });
  return snapshots.length;
}

export async function buildUnifiedTrainingDataset(options: {
  klinesDir: string;
  output: string;
  reportPath?: string;
  snapshotsJsonl?: string;
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
  let snapshotCount = 0;
  let snapshotsOutput: string | null = null;
  if (options.snapshotsJsonl && options.snapshotsOutput) {
    snapshotsOutput = options.snapshotsOutput;
    await ensureParentDirectory(snapshotsOutput);
    snapshotCount = await exportSnapshotsFromJsonl(options.snapshotsJsonl, snapshotsOutput);
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
  };
}
