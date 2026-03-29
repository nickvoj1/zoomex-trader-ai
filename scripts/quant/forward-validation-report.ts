import { numberArg, parseArgs, stringArg, timestampedFile, writeJson } from "./shared";
import {
  buildAndPersistForwardValidationReports,
  createSupabaseAdminFromEnv,
  fetchLatestForwardValidationReports,
} from "./live-ops";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID);
  if (!userId) {
    throw new Error("Missing required --user-id or BOT_USER_ID");
  }

  const lookbackDays = numberArg(args, "lookback-days", 14);
  const startingBalanceUsd = numberArg(args, "starting-balance", 10_000);
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const output = stringArg(args, "output", `research/${timestampedFile("forward-validation", "json")}`)!;
  const supabase = createSupabaseAdminFromEnv();

  const reports = await buildAndPersistForwardValidationReports(supabase, {
    userId,
    symbol,
    lookbackDays,
    startingBalanceUsd,
    includeEmpty: false,
  });

  const latest = await fetchLatestForwardValidationReports(supabase, userId, symbol, 6);
  await writeJson(output, {
    createdAt: new Date().toISOString(),
    userId,
    symbol,
    lookbackDays,
    reports,
    latest,
  });

  console.log(JSON.stringify({
    output,
    reports,
    latest,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
