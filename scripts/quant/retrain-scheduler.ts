import path from "node:path";
import { runResearchCycle } from "./research-cycle";
import { buildUnifiedTrainingDataset } from "./training-dataset";
import {
  booleanArg,
  loadCandleDatasetFromCsv,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
} from "./shared";
import { fetchLatestResearchRun } from "./supabase";
import { compareResearchVsForwardValidation, createSupabaseAdminFromEnv } from "./live-ops";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const once = booleanArg(args, "once", false);
  const autoPrepare = booleanArg(args, "auto-prepare", false);
  const everyMinutes = Math.max(5, numberArg(args, "every-minutes", 240));
  const maxRuns = Math.max(0, numberArg(args, "max-runs", once ? 1 : 0));
  const skipIfRecentMinutes = Math.max(0, numberArg(args, "skip-if-recent-minutes", Math.max(60, everyMinutes - 15)));
  const minQualityScore = numberArg(args, "min-quality-score", 70);
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null;
  const directInput = stringArg(args, "input");
  const klinesDir = stringArg(args, "klines-dir", path.join("research", "binance-vision", "klines", "BTCUSDT"))!;
  const preparedOutput = stringArg(args, "prepared-output", path.join("research", "datasets", "BTCUSDT-1m-unified.csv"))!;
  const preparedReport = stringArg(args, "prepared-report", preparedOutput.replace(/\.csv$/i, "-quality.json"))!;
  const snapshotsJsonl = stringArg(args, "snapshots-jsonl");
  const snapshotsOutput = stringArg(args, "snapshots-output", path.join("research", "datasets", "BTCUSDT-market-snapshots.json"))!;
  let snapshotsFile = stringArg(args, "snapshots-file");
  const outputRoot = stringArg(args, "output-root", "research/scheduled")!;

  let runCount = 0;
  while (maxRuns === 0 || runCount < maxRuns) {
    const startedAt = new Date().toISOString();
    let input = directInput;
    if (autoPrepare || !input) {
      const prepared = await buildUnifiedTrainingDataset({
        klinesDir,
        output: preparedOutput,
        reportPath: preparedReport,
        snapshotsJsonl: snapshotsJsonl ?? undefined,
        snapshotsOutput: snapshotsJsonl ? snapshotsOutput : undefined,
      });
      input = prepared.output;
      snapshotsFile = prepared.snapshotsOutput ?? snapshotsFile;
    }
    if (!input) {
      throw new Error("Missing training input and auto-prepare did not produce one");
    }

    const cycleOptions = {
      input,
      userId,
      snapshotsFile,
      microstructureLookbackMinutes: numberArg(args, "micro-lookback-minutes", 15),
      limit: numberArg(args, "limit", 72),
      trainingCandles: numberArg(args, "training-candles", 8_000),
      validationCandles: numberArg(args, "validation-candles", 2_000),
      stepCandles: numberArg(args, "step-candles", 2_000),
      horizonBars: numberArg(args, "horizon-bars", 15),
      moveThresholdPct: numberArg(args, "move-threshold-pct", 0.18),
    };

    const dataset = await loadCandleDatasetFromCsv(input);
    if (dataset.quality.qualityScore < minQualityScore) {
      console.log(JSON.stringify({
        status: "skipped_low_quality",
        startedAt,
        quality: dataset.quality,
        minQualityScore,
      }, null, 2));
    } else {
      const latestRun = await fetchLatestResearchRun({
        userId,
        runType: "research_cycle",
        symbol: "BTCUSDT",
      }).catch(() => null);
      const latestRunAgeMinutes = latestRun?.created_at
        ? (Date.now() - Date.parse(latestRun.created_at)) / 60_000
        : null;

      if (latestRunAgeMinutes !== null && latestRunAgeMinutes < skipIfRecentMinutes) {
        console.log(JSON.stringify({
          status: "skipped_recent_run",
          startedAt,
          latestRunAt: latestRun?.created_at ?? null,
          latestRunAgeMinutes: Number(latestRunAgeMinutes.toFixed(2)),
          skipIfRecentMinutes,
        }, null, 2));
      } else {
        const outputDir = path.join(outputRoot, timestampedFile("cycle", "dir").replace(/\.dir$/, ""));
        const result = await runResearchCycle({
          ...cycleOptions,
          outputDir,
        });
        let comparison = null;
        if (userId) {
          try {
            comparison = await compareResearchVsForwardValidation(createSupabaseAdminFromEnv(), {
              userId,
              symbol: "BTCUSDT",
            });
          } catch {
            comparison = null;
          }
        }
        console.log(JSON.stringify({
          status: "completed",
          startedAt,
          outputDir: result.outputDir,
          summaryPath: result.summaryPath,
          walkForward: result.walkForward,
          longModelEligibility: result.longModel.eligibility,
          shortModelEligibility: result.shortModel.eligibility,
          comparison,
        }, null, 2));
      }
    }

    runCount += 1;
    if (once || (maxRuns !== 0 && runCount >= maxRuns)) {
      break;
    }
    await sleep(everyMinutes * 60_000);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
