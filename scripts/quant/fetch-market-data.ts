import { appendFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { fetchCrossVenueSnapshot } from "../../src/lib/market-intel";
import { booleanArg, ensureParentDirectory, numberArg, parseArgs, stringArg, timestampedFile, writeJson } from "./shared";

interface SupabaseWriter {
  from: (table: string) => {
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };
}

async function persistSnapshot(snapshot: Awaited<ReturnType<typeof fetchCrossVenueSnapshot>>) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return false;
  }

  const storageSymbol = "BTCUSDT";
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as SupabaseWriter;
  const rows: Array<Record<string, unknown>> = [snapshot.primary, snapshot.secondary]
    .filter((entry) => entry !== null)
    .map((entry) => ({
      venue: entry!.venue,
      symbol: storageSymbol,
      snapshot_type: "venue",
      mid_price: entry!.midPrice,
      mark_price: entry!.markPrice,
      spread_bps: entry!.orderBook?.spreadBps ?? null,
      imbalance: entry!.orderBook?.imbalance ?? null,
      funding_rate_pct_8h: entry!.fundingRatePct8h,
      open_interest_usd: entry!.openInterestUsd,
      open_interest_change_pct: entry!.openInterestChangePct,
      long_short_ratio: entry!.longShortRatio,
      taker_imbalance: entry!.takerImbalance,
      liquidation_bias: entry!.liquidationBias,
      liquidation_intensity: entry!.liquidationIntensity,
      cross_venue_basis_bps: snapshot.microstructure?.crossVenueBasisBps ?? null,
      latency_ms: entry!.latencyMs,
      raw_payload: entry!.raw,
    }));

  if (snapshot.microstructure) {
    rows.push({
      venue: "composite",
      symbol: storageSymbol,
      snapshot_type: "microstructure",
      mid_price: snapshot.primary?.midPrice ?? snapshot.secondary?.midPrice ?? null,
      mark_price: snapshot.primary?.markPrice ?? snapshot.secondary?.markPrice ?? null,
      spread_bps: snapshot.microstructure.primaryBook?.spreadBps ?? null,
      imbalance: snapshot.microstructure.primaryBook?.imbalance ?? null,
      funding_rate_pct_8h: snapshot.microstructure.fundingRatePct8h,
      open_interest_usd: snapshot.microstructure.openInterestUsd,
      open_interest_change_pct: snapshot.microstructure.openInterestChangePct,
      long_short_ratio: snapshot.microstructure.longShortRatio,
      taker_imbalance: snapshot.microstructure.takerImbalance,
      liquidation_bias: snapshot.microstructure.liquidationBias,
      liquidation_intensity: snapshot.microstructure.liquidationIntensity,
      cross_venue_basis_bps: snapshot.microstructure.crossVenueBasisBps,
      latency_ms: (snapshot.primary?.latencyMs ?? 0) + (snapshot.secondary?.latencyMs ?? 0),
      raw_payload: snapshot,
    });
  }

  const { error } = await supabase.from("market_snapshots").insert(rows as unknown);
  if (error) {
    throw error;
  }
  return true;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const iterations = numberArg(args, "iterations", 1);
  const intervalMs = numberArg(args, "interval-ms", 60_000);
  const writeToFile = booleanArg(args, "write-file", true);
  const appendJsonl = booleanArg(args, "append-jsonl", false);
  const output = stringArg(args, "output", `research/${timestampedFile("market-snapshots", "json")}`)!;
  const snapshots: Awaited<ReturnType<typeof fetchCrossVenueSnapshot>>[] = [];
  let lastSnapshot: Awaited<ReturnType<typeof fetchCrossVenueSnapshot>> | null = null;

  if (appendJsonl) {
    await ensureParentDirectory(output);
  }

  for (let index = 0; index < iterations; index += 1) {
    const snapshot = await fetchCrossVenueSnapshot();
    lastSnapshot = snapshot;
    if (appendJsonl) {
      await appendFile(output, `${JSON.stringify({ createdAt: new Date().toISOString(), snapshot })}\n`, "utf8");
    } else {
      snapshots.push(snapshot);
    }
    await persistSnapshot(snapshot).catch((error) => {
      console.error("Supabase persist failed:", error instanceof Error ? error.message : error);
    });
    if (index + 1 < iterations) {
      await sleep(intervalMs);
    }
  }

  if (writeToFile && !appendJsonl) {
    await writeJson(output, {
      createdAt: new Date().toISOString(),
      snapshots,
    });
  }

  console.log(JSON.stringify({
    iterations,
    appendJsonl,
    output: writeToFile || appendJsonl ? output : null,
    lastSnapshot: lastSnapshot ?? snapshots[snapshots.length - 1] ?? null,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
