import { booleanArg, numberArg, parseArgs, stringArg, timestampedFile, writeJson } from "./shared";
import {
  collectMicrostructureArchiveSample,
  createSupabaseAdminFromEnv,
  persistMicrostructureArchiveSample,
} from "./live-ops";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const iterations = numberArg(args, "iterations", 1);
  const intervalMs = numberArg(args, "interval-ms", 15_000);
  const persist = booleanArg(args, "persist", true);
  const writeFile = booleanArg(args, "write-file", false);
  const output = stringArg(args, "output", `research/${timestampedFile("microstructure-archive", "json")}`)!;
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const depthLimit = numberArg(args, "depth-limit", 20);
  const tradeLimit = numberArg(args, "trade-limit", 1_000);
  const mexcSymbol = stringArg(args, "mexc-symbol", "BTC_USDT")!;
  const binanceSymbol = stringArg(args, "binance-symbol", "BTCUSDT")!;

  const supabase = persist ? createSupabaseAdminFromEnv() : null;
  const samples: unknown[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const sample = supabase
      ? await persistMicrostructureArchiveSample(supabase, {
        symbol,
        mexcSymbol,
        binanceSymbol,
        depthLimit,
        tradeLimit,
      })
      : await collectMicrostructureArchiveSample({
        symbol,
        mexcSymbol,
        binanceSymbol,
        depthLimit,
        tradeLimit,
      });

    samples.push({
      createdAt: new Date().toISOString(),
      sample,
    });

    if (index + 1 < iterations) {
      await sleep(intervalMs);
    }
  }

  if (writeFile) {
    await writeJson(output, {
      createdAt: new Date().toISOString(),
      iterations,
      intervalMs,
      samples,
    });
  }

  console.log(JSON.stringify({
    iterations,
    intervalMs,
    persisted: persist,
    output: writeFile ? output : null,
    lastSample: samples[samples.length - 1] ?? null,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
