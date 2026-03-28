import { ParameterSpace, SweepObjective, walkForwardOptimize } from "../../src/lib/quant-research";
import {
  csvBooleanArg,
  csvNumberArg,
  defaultStrategySettings,
  loadCandlesFromCsv,
  numberArg,
  parseArgs,
  stringArg,
  timestampedFile,
  writeJson,
} from "./shared";
import { insertResearchRun } from "./supabase";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = stringArg(args, "input");
  if (!input) {
    throw new Error("Missing required --input /absolute/path/to/candles.csv");
  }

  const objective = (stringArg(args, "objective", "composite") ?? "composite") as SweepObjective;
  const output = stringArg(args, "output", `research/${timestampedFile("walk-forward", "json")}`)!;
  const trainingCandles = numberArg(args, "training-candles", 8_000);
  const validationCandles = numberArg(args, "validation-candles", 2_000);
  const stepCandles = numberArg(args, "step-candles", validationCandles);
  const maxEvaluations = numberArg(args, "limit", 72);
  const candles = await loadCandlesFromCsv(input);
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

  const report = walkForwardOptimize(candles, base, parameterSpace, {
    trainingCandles,
    validationCandles,
    stepCandles,
    maxEvaluations,
    objective,
  });

  await writeJson(output, {
    createdAt: new Date().toISOString(),
    input,
    objective,
    trainingCandles,
    validationCandles,
    stepCandles,
    report,
  });

  await insertResearchRun({
    user_id: stringArg(args, "user-id", process.env.BOT_USER_ID) ?? null,
    run_type: "walk_forward",
    symbol: "BTCUSDT",
    objective,
    config: {
      input,
      trainingCandles,
      validationCandles,
      stepCandles,
      maxEvaluations,
    },
    summary: report,
    artifact_path: output,
  }).catch(() => null);

  console.log(JSON.stringify({
    output,
    folds: report.folds.length,
    aggregate: report.aggregate,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
