import { numberArg, parseArgs, stringArg, timestampedFile, writeJson } from "./shared";
import {
  buildAndPersistForwardValidationReports,
  compareResearchVsForwardValidation,
  createSupabaseAdminFromEnv,
} from "./live-ops";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID);
  if (!userId) {
    throw new Error("Missing required --user-id or BOT_USER_ID");
  }

  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const lookbackDays = numberArg(args, "lookback-days", 14);
  const supabase = createSupabaseAdminFromEnv();
  await buildAndPersistForwardValidationReports(supabase, {
    userId,
    symbol,
    lookbackDays,
    includeEmpty: false,
  }).catch(() => []);
  const comparison = await compareResearchVsForwardValidation(supabase, {
    userId,
    symbol,
    persist: true,
  });

  const output = stringArg(args, "output", `research/${timestampedFile("research-live-comparison", "json")}`)!;
  await writeJson(output, {
    createdAt: new Date().toISOString(),
    userId,
    symbol,
    comparison,
  });

  console.log(JSON.stringify({
    output,
    comparison,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
