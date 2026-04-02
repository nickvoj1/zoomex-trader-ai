import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { trainLogisticModel } from "../../src/lib/quant-research";
import {
  csvStringArg,
  defaultStrategySettings,
  loadCandleDatasetFromCsv,
  loadContextHistoryFromJsonFiles,
  loadMicrostructureHistoryFromJsonFiles,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
  writeJson,
} from "./shared";
import {
  fetchHistoricalContextSnapshots,
  fetchHistoricalMicrostructureSnapshots,
  insertModelArtifact,
  insertResearchRun,
} from "./supabase";

function writeProgressFile(progressFile: string, payload: Record<string, unknown>) {
  mkdirSync(dirname(progressFile), { recursive: true });
  writeFileSync(progressFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function trainSide(input: string, side: "long" | "short", output: string, progressFile: string) {
  const args = parseArgs(process.argv.slice(2));
  const mark = (payload: Record<string, unknown>) => writeProgressFile(progressFile, {
    updatedAt: new Date().toISOString(),
    side,
    input,
    output,
    ...payload,
  });

  mark({
    status: "running",
    phase: "loading",
    percent: 0,
    message: "Loading candle dataset",
  });

  const dataset = await loadCandleDatasetFromCsv(input);
  const candles = dataset.candles;
  const settings = defaultStrategySettings();
  const snapshotsFiles = csvStringArg(args, "snapshots-file");
  const contextFiles = csvStringArg(args, "context-file");
  const firstCandle = candles[0];
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
  const startAt = firstCandle?.timestamp ? new Date(firstCandle.timestamp - 30 * 60_000).toISOString() : undefined;
  const contextStartAt = firstCandle?.timestamp
    ? new Date(firstCandle.timestamp - 120 * 24 * 60 * 60_000).toISOString()
    : undefined;
  const endAt = lastCandle?.timestamp ? new Date(lastCandle.timestamp + 60_000).toISOString() : undefined;
  const historyLookbackCandles = numberArg(args, "history-lookback-candles", 900);
  const maxTrainExamplesPerSegment = numberArg(args, "max-train-examples-per-segment", 400);
  const progressExampleInterval = numberArg(args, "progress-example-interval", 10_000);
  const progressEpochInterval = numberArg(args, "progress-epoch-interval", 10);
  const newsLookbackMinutes = numberArg(args, "news-lookback-minutes", 360);

  mark({
    status: "running",
    phase: "loading",
    percent: 10,
    message: "Loading historical microstructure",
    details: {
      candles: candles.length,
      snapshotsFiles: snapshotsFiles.length,
      contextFiles: contextFiles.length,
    },
  });

  const fileHistory = snapshotsFiles.length > 0 ? await loadMicrostructureHistoryFromJsonFiles(snapshotsFiles) : [];
  const fileContextHistory = contextFiles.length > 0 ? await loadContextHistoryFromJsonFiles(contextFiles) : [];
  const supabaseHistory = await fetchHistoricalMicrostructureSnapshots({
    symbol: "BTCUSDT",
    startAt,
    endAt,
  }).catch(() => []);
  const supabaseContextHistory = await fetchHistoricalContextSnapshots({
    symbol: "BTCUSDT",
    startAt: contextStartAt,
    endAt,
  }).catch(() => []);
  const minTimestamp = firstCandle?.timestamp ? firstCandle.timestamp - 30 * 60_000 : Number.NEGATIVE_INFINITY;
  const minContextTimestamp = firstCandle?.timestamp
    ? firstCandle.timestamp - 120 * 24 * 60 * 60_000
    : Number.NEGATIVE_INFINITY;
  const maxTimestamp = lastCandle?.timestamp ? lastCandle.timestamp + 60_000 : Number.POSITIVE_INFINITY;
  const microstructureHistory = [...fileHistory, ...supabaseHistory].filter(
    (snapshot) => snapshot.timestamp >= minTimestamp && snapshot.timestamp <= maxTimestamp,
  );
  const contextHistory = [...fileContextHistory, ...supabaseContextHistory].filter(
    (snapshot) => snapshot.timestamp >= minContextTimestamp && snapshot.timestamp <= maxTimestamp,
  );

  mark({
    status: "running",
    phase: "loading",
    percent: 20,
    message: "Loaded candles and microstructure",
    details: {
      candles: candles.length,
      fileSnapshots: fileHistory.length,
      supabaseSnapshots: supabaseHistory.length,
      filteredSnapshots: microstructureHistory.length,
      fileContextSnapshots: fileContextHistory.length,
      supabaseContextSnapshots: supabaseContextHistory.length,
      filteredContextSnapshots: contextHistory.length,
    },
  });

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
    contextHistory,
    microstructureLookbackMs: numberArg(args, "micro-lookback-minutes", 15) * 60_000,
    newsLookbackMs: newsLookbackMinutes * 60_000,
    historyLookbackCandles,
    maxTrainExamplesPerSegment,
    progressExampleInterval,
    progressEpochInterval,
    onProgress: (update) => {
      const phaseBase: Record<string, number> = {
        loading: 0,
        building_examples: 20,
        filtering_candidates: 72,
        splitting: 78,
        balancing: 82,
        training_epochs: 86,
        evaluating: 97,
        completed: 100,
      };
      const phaseSpan: Record<string, number> = {
        loading: 20,
        building_examples: 52,
        filtering_candidates: 6,
        splitting: 4,
        balancing: 4,
        training_epochs: 11,
        evaluating: 3,
        completed: 0,
      };
      const phasePercent = update.percent ?? 0;
      const overallPercent = update.phase === "completed"
        ? 100
        : Math.min(
            99.9,
            (phaseBase[update.phase] ?? 0) + ((phaseSpan[update.phase] ?? 0) * phasePercent) / 100,
          );

      mark({
        status: "running",
        phase: update.phase,
        percent: Number(overallPercent.toFixed(2)),
        phasePercent,
        message: update.message,
        progress: {
          current: update.current ?? null,
          total: update.total ?? null,
        },
        details: update.details ?? null,
      });
    },
  });

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    input,
    dataQuality: dataset.quality,
    model,
  });

  mark({
    status: "completed",
    phase: "completed",
    percent: 100,
    message: "Model artifact written",
    details: {
      approved: model.eligibility.approved,
      validationPrecision: model.metrics.validation.precision,
      testPrecision: model.metrics.test.precision,
      totalExamples: model.dataset.totalExamples,
    },
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
      historyLookbackCandles,
      maxTrainExamplesPerSegment,
      microstructureSnapshots: microstructureHistory.length,
      contextSnapshots: contextHistory.length,
      newsLookbackMinutes,
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
  const progressBase = stringArg(args, "progress-file", outputBase.replace(/\.json$/, "-progress.json"))!;

  if (requestedSide === "long" || requestedSide === "short") {
    const model = await trainSide(input, requestedSide, outputBase, progressBase);
    console.log(JSON.stringify({
      output: outputBase,
      progress: progressBase,
      side: requestedSide,
      metrics: model.metrics,
      eligibility: model.eligibility,
    }, null, 2));
    return;
  }

  const [longModel, shortModel] = await Promise.all([
    trainSide(
      input,
      "long",
      outputBase.replace(/\.json$/, "-long.json"),
      progressBase.replace(/\.json$/, "-long.json"),
    ),
    trainSide(
      input,
      "short",
      outputBase.replace(/\.json$/, "-short.json"),
      progressBase.replace(/\.json$/, "-short.json"),
    ),
  ]);

  console.log(JSON.stringify({
    outputs: [
      outputBase.replace(/\.json$/, "-long.json"),
      outputBase.replace(/\.json$/, "-short.json"),
    ],
    progressOutputs: [
      progressBase.replace(/\.json$/, "-long.json"),
      progressBase.replace(/\.json$/, "-short.json"),
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
