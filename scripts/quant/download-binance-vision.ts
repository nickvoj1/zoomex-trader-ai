import { createWriteStream } from "node:fs";
import { access, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import { booleanArg, ensureParentDirectory, numberArg, parseArgs, stringArg } from "./shared";

const BINANCE_VISION_BASE_URL = "https://data.binance.vision/data/futures/um/monthly";

type DatasetKind = "klines" | "aggTrades";

function parseMonth(raw: string) {
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid month format: ${raw}. Use YYYY-MM.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${raw}`);
  }
  return { year, month };
}

function formatMonth(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function buildMonthRange(startMonth: string, endMonth: string) {
  const start = parseMonth(startMonth);
  const end = parseMonth(endMonth);
  const startIndex = start.year * 12 + (start.month - 1);
  const endIndex = end.year * 12 + (end.month - 1);
  if (endIndex < startIndex) {
    throw new Error("--end-month must be after or equal to --start-month");
  }

  const months: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    months.push(formatMonth(year, month));
  }
  return months;
}

function buildArchivePath(dataset: DatasetKind, symbol: string, month: string, interval?: string) {
  if (dataset === "klines") {
    if (!interval) {
      throw new Error("--interval is required for dataset=klines");
    }
    return {
      remotePath: `klines/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`,
      localName: `${symbol}-${interval}-${month}.zip`,
    };
  }

  return {
    remotePath: `aggTrades/${symbol}/${symbol}-aggTrades-${month}.zip`,
    localName: `${symbol}-aggTrades-${month}.zip`,
  };
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, destination: string) {
  const response = await fetch(url);
  if (response.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} for ${url}`);
  }

  const partPath = `${destination}.part`;
  await ensureParentDirectory(destination);
  const stream = createWriteStream(partPath);
  const body = Readable.fromWeb(response.body as never);
  body.pipe(stream);
  await finished(stream);
  await unlink(destination).catch(() => {});
  await mkdir(path.dirname(destination), { recursive: true });
  await renamePart(partPath, destination);
  return { ok: true, status: response.status };
}

async function renamePart(partPath: string, destination: string) {
  const fs = await import("node:fs/promises");
  await fs.rename(partPath, destination);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = stringArg(args, "dataset", "klines") as DatasetKind;
  if (!["klines", "aggTrades"].includes(dataset)) {
    throw new Error("--dataset must be klines or aggTrades");
  }

  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const interval = dataset === "klines" ? stringArg(args, "interval", "1m")! : undefined;
  const defaultEnd = new Date();
  defaultEnd.setUTCMonth(defaultEnd.getUTCMonth() - 1);
  const defaultEndMonth = formatMonth(defaultEnd.getUTCFullYear(), defaultEnd.getUTCMonth() + 1);
  const startMonth = stringArg(args, "start-month", dataset === "aggTrades" ? "2025-01" : "2024-01")!;
  const endMonth = stringArg(args, "end-month", defaultEndMonth)!;
  const outputDir = stringArg(args, "output-dir", path.join("research", "binance-vision", dataset, symbol))!;
  const maxMonths = numberArg(args, "max-months", Number.MAX_SAFE_INTEGER);
  const skipExisting = booleanArg(args, "skip-existing", true);

  const archives = buildMonthRange(startMonth, endMonth)
    .slice(0, maxMonths)
    .map((month) => {
      const archive = buildArchivePath(dataset, symbol, month, interval);
      return {
        month,
        url: `${BINANCE_VISION_BASE_URL}/${archive.remotePath}`,
        destination: path.join(outputDir, archive.localName),
      };
    });

  const results: Array<Record<string, unknown>> = [];
  let downloaded = 0;
  let skipped = 0;
  let missing = 0;
  let bytes = 0;

  for (const archive of archives) {
    if (skipExisting && await exists(archive.destination)) {
      const info = await stat(archive.destination);
      bytes += info.size;
      skipped += 1;
      results.push({ month: archive.month, status: "skipped", destination: archive.destination, bytes: info.size });
      continue;
    }

    const result = await downloadToFile(archive.url, archive.destination);
    if (!result.ok && result.status === 404) {
      missing += 1;
      results.push({ month: archive.month, status: "missing", url: archive.url });
      continue;
    }

    const info = await stat(archive.destination);
    bytes += info.size;
    downloaded += 1;
    results.push({ month: archive.month, status: "downloaded", destination: archive.destination, bytes: info.size });
  }

  console.log(JSON.stringify({
    dataset,
    symbol,
    interval: interval ?? null,
    outputDir,
    startMonth,
    endMonth,
    requestedMonths: archives.length,
    downloaded,
    skipped,
    missing,
    totalBytes: bytes,
    results,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
