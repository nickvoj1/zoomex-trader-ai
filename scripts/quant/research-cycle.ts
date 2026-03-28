import path from "node:path";
import {
  buildParameterGrid,
  ParameterSpace,
  runParameterSweep,
  trainLogisticModel,
  walkForwardOptimize,
} from "../../src/lib/quant-research.ts";
import {
  csvBooleanArg,
  csvNumberArg,
  defaultStrategySettings,
  ensureParentDirectory,
  loadCandleDatasetFromCsv,
  loadMicrostructureHistoryFromJson,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
  writeJson,
} from "./shared";
import {
  fetchHistoricalMicrostructureSnapshots,
  insertModelArtifact,
  insertResearchRun,
} from "./supabase";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = stringArg(args, "input");
  if (!input) {
    throw new Error("Missing required --input /absolute/path/to/candles.csv");
  }

  const outputDir = stringArg(args, "output-dir", path.join("research", timestampedFile("cycle", "dir").replace(/\.dir$/, "")))!;
  await ensureParentDirectory(path.join(outputDir, "placeholder.txt"));
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null;
  const dataset = await loadCandleDatasetFromCsv(input);
  const candles = dataset.candles;
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
  const microstructureLookbackMs = numberArg(args, "micro-lookback-minutes", 15) * 60_000;
  const base = defaultStrategySettings();
  const parameterSpace: ParameterSpace = {
    riskPct: csvNumberArg(args, "risk-pct", [0.25, 0.5, 0.75]),
    leverage: csvNumberArg(args, "leverage", [6, 10, 14]),
    minConfidence: csvNumberArg(args, "min-confidence", [72, 78, 84]),
    dailyLossLimitPct: csvNumberArg(args, "daily-loss-limit-pct", [2, 3, 4]),
    maxConsecutiveLosses: csvNumberArg(args, "max-consecutive-losses", [2, 3, 4]),
    allowTrendTrades: csvBooleanArg(args, "allow-trend-trades", [true]),
    allowMeanReversionTrades: csvBooleanArg(args, "allow-mean-reversion-trades", [true]),
    feeBps: csvNumberArg(args, "fee-bps", [4]),
    slippageBps: csvNumberArg(args, "slippage-bps", [2, 3, 4]),
    maxBarsInTrade: csvNumberArg(args, "max-bars-in-trade", [60, 90, 120]),
    partialTakeProfitRR: csvNumberArg(args, "partial-tp-rr", [0.8, 1.2, 1.6]),
    allowSessionFilter: csvBooleanArg(args, "allow-session-filter", [true]),
    sessionStartHourUtc: csvNumberArg(args, "session-start-hour-utc", [6]),
    sessionEndHourUtc: csvNumberArg(args, "session-end-hour-utc", [22]),
  };

  const candidates = buildParameterGrid(base, parameterSpace, numberArg(args, "limit", 72));
  const sweep = runParameterSweep(candles, candidates, "composite");
  const best = sweep[0];
  const walkForward = walkForwardOptimize(candles, best.settings, parameterSpace, {
    trainingCandles: numberArg(args, "training-candles", 8_000),
    validationCandles: numberArg(args, "validation-candles", 2_000),
    stepCandles: numberArg(args, "step-candles", 2_000),
    maxEvaluations: numberArg(args, "limit", 72),
    objective: "composite",
  });
  const longModel = trainLogisticModel(candles, best.settings, {
    side: "long",
    horizonBars: numberArg(args, "horizon-bars", 15),
    moveThresholdPct: numberArg(args, "move-threshold-pct", 0.18),
    microstructureHistory,
    microstructureLookbackMs,
  });
  const shortModel = trainLogisticModel(candles, best.settings, {
    side: "short",
    horizonBars: numberArg(args, "horizon-bars", 15),
    moveThresholdPct: numberArg(args, "move-threshold-pct", 0.18),
    microstructureHistory,
    microstructureLookbackMs,
  });

  const summary = {
    createdAt: new Date().toISOString(),
    input,
    dataQuality: dataset.quality,
    bestSettings: best.settings,
    bestSweepScore: best.score,
    bestSweepResult: {
      totalPnl: best.result.totalPnl,
      trades: best.result.trades,
      winRate: best.result.winRate,
      sharpe: best.result.sharpe,
      sortino: best.result.sortino,
      maxDrawdown: best.result.maxDrawdown,
    },
    walkForward: walkForward.aggregate,
    longModel: longModel.metrics,
    shortModel: shortModel.metrics,
    microstructureSnapshots: microstructureHistory.length,
  };

  const sweepPath = path.join(outputDir, "parameter-sweep.json");
  const walkForwardPath = path.join(outputDir, "walk-forward.json");
  const longModelPath = path.join(outputDir, "signal-model-long.json");
  const shortModelPath = path.join(outputDir, "signal-model-short.json");
  const summaryPath = path.join(outputDir, "summary.json");

  await Promise.all([
    writeJson(sweepPath, { createdAt: summary.createdAt, top: sweep.slice(0, 20) }),
    writeJson(walkForwardPath, walkForward),
    writeJson(longModelPath, longModel),
    writeJson(shortModelPath, shortModel),
    writeJson(summaryPath, summary),
  ]);

  const runId = await insertResearchRun({
    user_id: userId,
    run_type: "research_cycle",
    symbol: "BTCUSDT",
    objective: "composite",
    config: {
      input,
      candidates: candidates.length,
      outputDir,
      microstructureSnapshots: microstructureHistory.length,
      dataQuality: dataset.quality,
    },
    summary,
    artifact_path: summaryPath,
  }).catch(() => null);

  await Promise.all([
    insertModelArtifact({
      user_id: userId,
      model_name: "signal-logistic-long",
      symbol: "BTCUSDT",
      side: "long",
      horizon_bars: longModel.horizonBars,
      move_threshold_pct: longModel.moveThresholdPct,
      metrics: longModel.metrics,
      artifact: longModel,
      source_run_id: runId,
    }).catch(() => null),
    insertModelArtifact({
      user_id: userId,
      model_name: "signal-logistic-short",
      symbol: "BTCUSDT",
      side: "short",
      horizon_bars: shortModel.horizonBars,
      move_threshold_pct: shortModel.moveThresholdPct,
      metrics: shortModel.metrics,
      artifact: shortModel,
      source_run_id: runId,
    }).catch(() => null),
  ]);

  console.log(JSON.stringify({
    outputDir,
    summaryPath,
    bestSettings: best.settings,
    walkForward: walkForward.aggregate,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
