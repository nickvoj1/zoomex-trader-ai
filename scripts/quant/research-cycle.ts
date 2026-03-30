import path from "node:path";
import {
  buildParameterGrid,
  LogisticModelArtifact,
  ParameterSpace,
  runParameterSweep,
  trainLogisticModel,
  walkForwardOptimize,
} from "../../src/lib/quant-research.ts";
import {
  csvStringArg,
  csvBooleanArg,
  csvNumberArg,
  defaultStrategySettings,
  ensureParentDirectory,
  loadCandleDatasetFromCsv,
  loadMicrostructureHistoryFromJsonFiles,
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

export interface ResearchCycleOptions {
  input: string;
  outputDir?: string;
  userId?: string | null;
  snapshotsFiles?: string[];
  microstructureLookbackMinutes?: number;
  limit?: number;
  trainingCandles?: number;
  validationCandles?: number;
  stepCandles?: number;
  horizonBars?: number;
  moveThresholdPct?: number;
}

export interface ResearchCycleResult {
  outputDir: string;
  summaryPath: string;
  bestSettings: typeof defaultStrategySettings extends () => infer T ? T : never;
  walkForward: ReturnType<typeof walkForwardOptimize>["aggregate"];
  summary: Record<string, unknown>;
  longModel: LogisticModelArtifact;
  shortModel: LogisticModelArtifact;
}

export async function runResearchCycle(options: ResearchCycleOptions): Promise<ResearchCycleResult> {
  const outputDir = options.outputDir ?? path.join("research", timestampedFile("cycle", "dir").replace(/\.dir$/, ""));
  await ensureParentDirectory(path.join(outputDir, "placeholder.txt"));
  const userId = options.userId ?? null;
  const dataset = await loadCandleDatasetFromCsv(options.input);
  const candles = dataset.candles;
  const snapshotsFiles = options.snapshotsFiles ?? [];
  const firstCandle = candles[0];
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
  const startAt = firstCandle?.timestamp ? new Date(firstCandle.timestamp - 30 * 60_000).toISOString() : undefined;
  const endAt = lastCandle?.timestamp ? new Date(lastCandle.timestamp + 60_000).toISOString() : undefined;
  const fileHistory = snapshotsFiles.length > 0 ? await loadMicrostructureHistoryFromJsonFiles(snapshotsFiles) : [];
  const supabaseHistory = await fetchHistoricalMicrostructureSnapshots({
    symbol: "BTCUSDT",
    startAt,
    endAt,
  }).catch(() => []);
  const microstructureHistory = [...fileHistory, ...supabaseHistory];
  const microstructureLookbackMs = (options.microstructureLookbackMinutes ?? 15) * 60_000;
  const base = defaultStrategySettings();
  const parameterSpace: ParameterSpace = {
    riskPct: [0.25, 0.5, 0.75],
    leverage: [6, 10, 14],
    minConfidence: [72, 78, 84],
    dailyLossLimitPct: [2, 3, 4],
    maxConsecutiveLosses: [2, 3, 4],
    allowTrendTrades: [true],
    allowMeanReversionTrades: [true],
    feeBps: [4],
    slippageBps: [2, 3, 4],
    maxBarsInTrade: [60, 90, 120],
    partialTakeProfitRR: [0.8, 1.2, 1.6],
    allowSessionFilter: [true],
    sessionStartHourUtc: [6],
    sessionEndHourUtc: [22],
  };

  const candidates = buildParameterGrid(base, parameterSpace, options.limit ?? 72);
  const sweep = runParameterSweep(candles, candidates, "composite");
  const best = sweep[0];
  const walkForward = walkForwardOptimize(candles, best.settings, parameterSpace, {
    trainingCandles: options.trainingCandles ?? 8_000,
    validationCandles: options.validationCandles ?? 2_000,
    stepCandles: options.stepCandles ?? 2_000,
    maxEvaluations: options.limit ?? 72,
    objective: "composite",
  });
  const longModel = trainLogisticModel(candles, best.settings, {
    side: "long",
    horizonBars: options.horizonBars ?? 15,
    moveThresholdPct: options.moveThresholdPct ?? 0.18,
    microstructureHistory,
    microstructureLookbackMs,
  });
  const shortModel = trainLogisticModel(candles, best.settings, {
    side: "short",
    horizonBars: options.horizonBars ?? 15,
    moveThresholdPct: options.moveThresholdPct ?? 0.18,
    microstructureHistory,
    microstructureLookbackMs,
  });

  const summary = {
    createdAt: new Date().toISOString(),
    input: options.input,
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
    longModelEligibility: longModel.eligibility,
    shortModelEligibility: shortModel.eligibility,
    longDataset: longModel.dataset,
    shortDataset: shortModel.dataset,
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
      input: options.input,
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
      metrics: { ...longModel.metrics, eligibility: longModel.eligibility, dataset: longModel.dataset },
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
      metrics: { ...shortModel.metrics, eligibility: shortModel.eligibility, dataset: shortModel.dataset },
      artifact: shortModel,
      source_run_id: runId,
    }).catch(() => null),
  ]);

  return {
    outputDir,
    summaryPath,
    bestSettings: best.settings,
    walkForward: walkForward.aggregate,
    summary,
    longModel,
    shortModel,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = stringArg(args, "input");
  if (!input) {
    throw new Error("Missing required --input /absolute/path/to/candles.csv");
  }

  const result = await runResearchCycle({
    input,
    outputDir: stringArg(args, "output-dir", path.join("research", timestampedFile("cycle", "dir").replace(/\.dir$/, ""))),
    userId: stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null,
    snapshotsFiles: csvStringArg(args, "snapshots-file"),
    microstructureLookbackMinutes: numberArg(args, "micro-lookback-minutes", 15),
    limit: numberArg(args, "limit", 72),
    trainingCandles: numberArg(args, "training-candles", 8_000),
    validationCandles: numberArg(args, "validation-candles", 2_000),
    stepCandles: numberArg(args, "step-candles", 2_000),
    horizonBars: numberArg(args, "horizon-bars", 15),
    moveThresholdPct: numberArg(args, "move-threshold-pct", 0.18),
  });

  console.log(JSON.stringify({
    outputDir: result.outputDir,
    summaryPath: result.summaryPath,
    bestSettings: result.bestSettings,
    walkForward: result.walkForward,
    longModelEligibility: result.longModel.eligibility,
    shortModelEligibility: result.shortModel.eligibility,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
