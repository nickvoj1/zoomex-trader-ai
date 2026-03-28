import { createClient } from "@supabase/supabase-js";
import { buildMarketMicrostructure, MarketMicrostructure } from "../../src/lib/strategy-core";
import {
  HistoricalMicrostructureSnapshot,
  prepareHistoricalMicrostructure,
} from "../../src/lib/quant-research";

interface MarketSnapshotRow {
  created_at: string;
  raw_payload?: Record<string, unknown> | null;
  spread_bps?: number | null;
  imbalance?: number | null;
  funding_rate_pct_8h?: number | null;
  open_interest_usd?: number | null;
  open_interest_change_pct?: number | null;
  long_short_ratio?: number | null;
  taker_imbalance?: number | null;
  liquidation_bias?: number | null;
  liquidation_intensity?: number | null;
  cross_venue_basis_bps?: number | null;
}

function safeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToMicrostructure(row: MarketSnapshotRow): MarketMicrostructure | null {
  const rawPayload = row.raw_payload;
  if (rawPayload && typeof rawPayload === "object" && rawPayload.microstructure && typeof rawPayload.microstructure === "object") {
    return rawPayload.microstructure as MarketMicrostructure;
  }

  return buildMarketMicrostructure({
    fundingRatePct8h: safeNumber(row.funding_rate_pct_8h),
    openInterestUsd: safeNumber(row.open_interest_usd),
    openInterestChangePct: safeNumber(row.open_interest_change_pct),
    longShortRatio: safeNumber(row.long_short_ratio),
    takerImbalance: safeNumber(row.taker_imbalance),
    liquidationBias: safeNumber(row.liquidation_bias),
    liquidationIntensity: safeNumber(row.liquidation_intensity),
    crossVenueBasisBps: safeNumber(row.cross_venue_basis_bps),
  });
}

function maybeCreateSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

export async function fetchHistoricalMicrostructureSnapshots(options: {
  symbol?: string;
  startAt?: string;
  endAt?: string;
  limit?: number;
} = {}): Promise<HistoricalMicrostructureSnapshot[]> {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return [];

  let query = supabase
    .from("market_snapshots")
    .select(
      "created_at, raw_payload, spread_bps, imbalance, funding_rate_pct_8h, open_interest_usd, open_interest_change_pct, long_short_ratio, taker_imbalance, liquidation_bias, liquidation_intensity, cross_venue_basis_bps",
    )
    .eq("venue", "composite")
    .eq("snapshot_type", "microstructure")
    .eq("symbol", options.symbol ?? "BTCUSDT")
    .order("created_at", { ascending: true });

  if (options.startAt) {
    query = query.gte("created_at", options.startAt);
  }
  if (options.endAt) {
    query = query.lte("created_at", options.endAt);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const history: HistoricalMicrostructureSnapshot[] = [];
  for (const row of (data ?? []) as MarketSnapshotRow[]) {
    const timestamp = Date.parse(row.created_at);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    history.push({
      timestamp,
      microstructure: rowToMicrostructure(row),
      source: "supabase",
    });
  }

  return prepareHistoricalMicrostructure(history);
}

export async function insertResearchRun(payload: Record<string, unknown>) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.from("research_runs").insert(payload as unknown).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}

export async function insertModelArtifact(payload: Record<string, unknown>) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.from("model_artifacts").insert(payload as unknown).select("id").maybeSingle();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}
