import { trainLogisticModel } from "../../src/lib/quant-research";
import {
  defaultStrategySettings,
  loadCandleDatasetFromCsv,
  loadMicrostructureHistoryFromJson,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
  writeJson,
} from "./shared";
import { fetchHistoricalMicrostructureSnapshots, insertModelArtifact, insertResearchRun } from "./supabase";

async function trainSide(input: string, side: "long" | "short", output: string) {
  const dataset = await loadCandleDatasetFromCsv(input);
  const candles = dataset.candles;
  const settings = defaultStrategySettings();
  const args = parseArgs(process.argv.slice(2));
  const snapshotsFile = stringArg(args, "snapshots-file");
  const firstCandle = candles[0];
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
  const startAt = firstCandle?.timestamp ? new Date(firstCandle.timestamp - 30 * 60_000).toISOString() : undefined;
  const endAt = lastCandle?.timestamp ? new Date(lastCandle.timestamp + 60_000).toISOString() : undefined;
  const fileHistory = snapshotsFile ? await loadMicrostructureHistoryFromJson(snapshotsFile) : [];
  const supabaseHistory = await fetchHistoricalMicrostructureSnapshots({
    symbol: "BTCUSDT",
    startAt,
    endAt,
  }).catch(() => []);
  const microstructureHistory = [...fileHistory, ...supabaseHistory];
  const model = trainLogisticModel(candles, settings, {
    side,
    horizonBars: numberArg(args, "horizon-bars", 15),
    moveThresholdPct: numberArg(args, "move-threshold-pct", 0.18),
    feeBps: numberArg(args, "fee-bps", settings.feeBps),
    slippageBps: numberArg(args, "slippage-bps", settings.slippageBps),
    epochs: numberArg(args, "epochs", 220),
    learningRate: numberArg(args, "learning-rate", 0.03),
    regularization: numberArg(args, "regularization", 0.0005),
    microstructureHistory,
    microstructureLookbackMs: numberArg(args, "micro-lookback-minutes", 15) * 60_000,
  });

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    input,
    dataQuality: dataset.quality,
    model,
  });

  const runId = await insertResearchRun({
    user_id: stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null,
    run_type: "signal_model_training",
    symbol: "BTCUSDT",
    objective: "classification",
    config: {
      input,
      side,
      horizonBars: model.horizonBars,
      moveThresholdPct: model.moveThresholdPct,
      epochs: model.epochs,
      learningRate: model.learningRate,
      regularization: model.regularization,
      microstructureSnapshots: microstructureHistory.length,
      dataQuality: dataset.quality,
    },
    summary: {
      dataQuality: dataset.quality,
      metrics: model.metrics,
      dataset: model.dataset,
      regimeMetrics: model.regimeMetrics,
      eligibility: model.eligibility,
    },
    artifact_path: output,
  }).catch(() => null);

  await insertModelArtifact({
    user_id: stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null,
    model_name: `signal-logistic-${side}`,
    symbol: "BTCUSDT",
    side,
    horizon_bars: model.horizonBars,
    move_threshold_pct: model.moveThresholdPct,
    metrics: { ...model.metrics, dataset: model.dataset, eligibility: model.eligibility },
    artifact: model,
    source_run_id: runId,
  }).catch(() => null);

  return model;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = stringArg(args, "input");
  if (!input) {
    throw new Error("Missing required --input /absolute/path/to/candles.csv");
  }

  const requestedSide = stringArg(args, "side", "both");
  const outputBase = stringArg(args, "output", `research/${timestampedFile("signal-model", "json")}`)!;

  if (requestedSide === "long" || requestedSide === "short") {
    const model = await trainSide(input, requestedSide, outputBase);
    console.log(JSON.stringify({
      output: outputBase,
      side: requestedSide,
      metrics: model.metrics,
      eligibility: model.eligibility,
    }, null, 2));
    return;
  }

  const [longModel, shortModel] = await Promise.all([
    trainSide(input, "long", outputBase.replace(/\.json$/, "-long.json")),
    trainSide(input, "short", outputBase.replace(/\.json$/, "-short.json")),
  ]);

  console.log(JSON.stringify({
    outputs: [
      outputBase.replace(/\.json$/, "-long.json"),
      outputBase.replace(/\.json$/, "-short.json"),
    ],
    longMetrics: longModel.metrics,
    shortMetrics: shortModel.metrics,
    longEligibility: longModel.eligibility,
    shortEligibility: shortModel.eligibility,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
