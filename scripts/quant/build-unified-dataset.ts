import path from "node:path";
import { csvStringArg, numberArg, parseArgs, stringArg } from "./shared";
import { buildUnifiedTrainingDataset } from "./training-dataset";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const klinesDir = stringArg(args, "klines-dir", path.join("research", "binance-vision", "klines", symbol))!;
  const aggTradesDir = stringArg(args, "aggtrades-dir", path.join("research", "binance-vision", "aggTrades", symbol));
  const historicalSnapshotsFiles = csvStringArg(
    args,
    "historical-snapshots-file",
    [path.join("research", "datasets", `${symbol}-historical-microstructure.json`)],
  );
  const output = stringArg(args, "output", path.join("research", "datasets", `${symbol}-1m-unified.csv`))!;
  const reportPath = stringArg(args, "report", output.replace(/\.csv$/i, "-quality.json"))!;
  const snapshotsJsonl = stringArg(args, "snapshots-jsonl");
  const snapshotsOutput = stringArg(args, "snapshots-output", path.join("research", "datasets", `${symbol}-market-snapshots.json`));

  const result = await buildUnifiedTrainingDataset({
    klinesDir,
    aggTradesDir: aggTradesDir ?? undefined,
    historicalSnapshotsFiles: historicalSnapshotsFiles.length > 0 ? historicalSnapshotsFiles : undefined,
    output,
    reportPath,
    snapshotsJsonl: snapshotsJsonl ?? undefined,
    snapshotsOutput: snapshotsJsonl || aggTradesDir || historicalSnapshotsFiles.length > 0 ? (snapshotsOutput ?? undefined) : undefined,
    intervalMs: numberArg(args, "interval-ms", 60_000),
    maxSyntheticGapBars: numberArg(args, "max-synthetic-gap-bars", 3),
    suspiciousMovePct: numberArg(args, "suspicious-move-pct", 3.5),
  });

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
