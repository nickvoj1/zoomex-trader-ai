import { createClient } from "@supabase/supabase-js";
import { buildMarketMicrostructure, MarketMicrostructure } from "../../src/lib/strategy-core";
import {
  HistoricalContextSnapshot,
  HistoricalMicrostructureSnapshot,
  prepareHistoricalContext,
  prepareHistoricalMicrostructure,
} from "../../src/lib/quant-research";

interface MarketSnapshotRow {
  created_at: string;
  snapshot_type?: string | null;
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

function extractContextPayload(row: MarketSnapshotRow) {
  const rawPayload = row.raw_payload;
  if (rawPayload && typeof rawPayload === "object") {
    if (rawPayload.context && typeof rawPayload.context === "object") {
      return rawPayload.context as Record<string, unknown>;
    }
    return rawPayload;
  }
  return null;
}

function rowToHistoricalContext(row: MarketSnapshotRow): HistoricalContextSnapshot | null {
  const timestamp = Date.parse(row.created_at);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const payload = extractContextPayload(row);
  if (!payload) {
    return null;
  }

  return {
    timestamp,
    newsEventCount: safeNumber(payload.news_event_count ?? payload.newsEventCount),
    newsSentiment: safeNumber(payload.news_sentiment ?? payload.newsSentiment),
    newsImpact: safeNumber(payload.news_impact ?? payload.newsImpact),
    newsPositiveCount: safeNumber(payload.news_positive_count ?? payload.newsPositiveCount),
    newsNegativeCount: safeNumber(payload.news_negative_count ?? payload.newsNegativeCount),
    newsBtcRelevance: safeNumber(payload.news_btc_relevance ?? payload.newsBtcRelevance),
    newsShockScore: safeNumber(payload.news_shock_score ?? payload.newsShockScore),
    macroCpiYoY: safeNumber(payload.macro_cpi_yoy ?? payload.macroCpiYoY),
    macroCpiMoM: safeNumber(payload.macro_cpi_mom ?? payload.macroCpiMoM),
    macroCoreCpiYoY: safeNumber(payload.macro_core_cpi_yoy ?? payload.macroCoreCpiYoY),
    macroCoreCpiMoM: safeNumber(payload.macro_core_cpi_mom ?? payload.macroCoreCpiMoM),
    macroUnemploymentRate: safeNumber(payload.macro_unemployment_rate ?? payload.macroUnemploymentRate),
    macroUnemploymentChange: safeNumber(payload.macro_unemployment_change ?? payload.macroUnemploymentChange),
    macroInflationTrend: safeNumber(payload.macro_inflation_trend ?? payload.macroInflationTrend),
    macroRiskBias: safeNumber(payload.macro_risk_bias ?? payload.macroRiskBias),
    source: typeof payload.source === "string" ? payload.source : row.snapshot_type ?? "supabase",
  };
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
    .in("symbol", [options.symbol ?? "BTCUSDT", "BTC_USDT"])
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

export async function fetchHistoricalContextSnapshots(options: {
  symbol?: string;
  startAt?: string;
  endAt?: string;
  limit?: number;
  snapshotTypes?: string[];
} = {}): Promise<HistoricalContextSnapshot[]> {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return [];

  let query = supabase
    .from("market_snapshots")
    .select("created_at, snapshot_type, raw_payload")
    .in("snapshot_type", options.snapshotTypes ?? ["news_context", "macro_context"])
    .in("symbol", [options.symbol ?? "BTCUSDT", "BTC_USDT"])
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

  return prepareHistoricalContext(
    ((data ?? []) as MarketSnapshotRow[])
      .map((row) => rowToHistoricalContext(row))
      .filter((row): row is HistoricalContextSnapshot => row !== null),
  );
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

export async function fetchLatestResearchRun(options: {
  userId?: string | null;
  runType?: string;
  symbol?: string;
} = {}) {
  const supabase = maybeCreateSupabaseAdmin();
  if (!supabase) return null;

  let query = supabase
    .from("research_runs")
    .select("id, created_at, run_type, symbol, summary, config, artifact_path, user_id")
    .order("created_at", { ascending: false })
    .limit(1);

  if (options.userId) {
    query = query.eq("user_id", options.userId);
  }
  if (options.runType) {
    query = query.eq("run_type", options.runType);
  }
  if (options.symbol) {
    query = query.eq("symbol", options.symbol);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }

  return data ?? null;
}
