import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ArchivedOrderBookSnapshot,
  ArchivedTradeTick,
  fetchBinanceOrderBookSnapshot,
  fetchBinanceRecentTradeTicks,
  fetchMexcOrderBookSnapshot,
  fetchMexcRecentTradeTicks,
} from "../../src/lib/market-intel";
import {
  computeForwardValidationReport,
  ForwardValidationReport,
  ForwardValidationTca,
  ForwardValidationTrade,
  mergeTradesWithTca,
} from "../../src/lib/forward-validation";
import { fetchLatestResearchRun, insertResearchRun } from "./supabase";

type SupabaseAdmin = SupabaseClient;

interface ArchiveCoverage {
  orderbookSnapshots: number;
  tradeTicks: number;
}

export interface OpsControlRow {
  scope: string;
  symbol: string;
  kill_switch: boolean;
  pause_new_entries: boolean;
  disable_live_entries_until: string | null;
  max_market_snapshot_age_seconds: number;
  max_archive_sample_age_seconds: number;
  max_heartbeat_age_seconds: number;
  max_cycle_latency_ms: number;
  notes: string | null;
  updated_at: string;
}

interface OpsHeartbeatRow {
  created_at: string;
  service_name: string;
  symbol: string;
  status: string;
  source_host: string | null;
  process_id: string | null;
  details: Record<string, unknown> | null;
}

function round(value: number, precision = 4) {
  return Number(value.toFixed(precision));
}

export function createSupabaseAdminFromEnv() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

export async function fetchOpsControl(
  supabase: SupabaseAdmin,
  symbol = "BTCUSDT",
): Promise<OpsControlRow | null> {
  const { data, error } = await supabase
    .from("ops_controls")
    .select(
      "scope, symbol, kill_switch, pause_new_entries, disable_live_entries_until, max_market_snapshot_age_seconds, max_archive_sample_age_seconds, max_heartbeat_age_seconds, max_cycle_latency_ms, notes, updated_at",
    )
    .eq("scope", "global")
    .eq("symbol", symbol)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as OpsControlRow | null;
}

export async function upsertOpsControl(
  supabase: SupabaseAdmin,
  symbol: string,
  payload: Partial<OpsControlRow> & { notes?: string | null },
) {
  const { error } = await supabase.from("ops_controls").upsert({
    scope: "global",
    symbol,
    ...payload,
    updated_at: new Date().toISOString(),
  }, { onConflict: "scope,symbol" });

  if (error) {
    throw error;
  }
}

export async function recordOpsHeartbeat(
  supabase: SupabaseAdmin,
  payload: {
    serviceName: string;
    symbol?: string;
    status: string;
    details?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("ops_heartbeats").insert({
    service_name: payload.serviceName,
    symbol: payload.symbol ?? "BTCUSDT",
    status: payload.status,
    source_host: process.env.HOSTNAME ?? null,
    process_id: String(process.pid),
    details: payload.details ?? {},
  });

  if (error) {
    throw error;
  }
}

export async function createOpsAlert(
  supabase: SupabaseAdmin,
  payload: {
    serviceName: string;
    symbol?: string;
    severity: "info" | "warning" | "critical";
    alertType: string;
    message: string;
    details?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("ops_alerts").insert({
    service_name: payload.serviceName,
    symbol: payload.symbol ?? "BTCUSDT",
    severity: payload.severity,
    alert_type: payload.alertType,
    message: payload.message,
    details: payload.details ?? {},
  });

  if (error) {
    throw error;
  }
}

export async function createOpsAlertWithinCooldown(
  supabase: SupabaseAdmin,
  payload: Parameters<typeof createOpsAlert>[1],
  cooldownMs = 15 * 60_000,
) {
  const { data, error } = await supabase
    .from("ops_alerts")
    .select("created_at")
    .eq("service_name", payload.serviceName)
    .eq("symbol", payload.symbol ?? "BTCUSDT")
    .eq("alert_type", payload.alertType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const createdAt = data?.created_at ? Date.parse(data.created_at) : null;
  if (createdAt !== null && Number.isFinite(createdAt) && Date.now() - createdAt < cooldownMs) {
    return false;
  }

  await createOpsAlert(supabase, payload);
  return true;
}

export async function fetchLatestHeartbeat(
  supabase: SupabaseAdmin,
  serviceName: string,
  symbol = "BTCUSDT",
): Promise<OpsHeartbeatRow | null> {
  const { data, error } = await supabase
    .from("ops_heartbeats")
    .select("created_at, service_name, symbol, status, source_host, process_id, details")
    .eq("service_name", serviceName)
    .eq("symbol", symbol)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as OpsHeartbeatRow | null;
}

function orderBookInsertRow(snapshot: ArchivedOrderBookSnapshot, canonicalSymbol: string) {
  return {
    venue: snapshot.venue,
    symbol: canonicalSymbol,
    depth_limit: snapshot.depthLimit,
    best_bid: snapshot.bestBid,
    best_ask: snapshot.bestAsk,
    spread_bps: snapshot.spreadBps,
    imbalance: snapshot.imbalance,
    bids: snapshot.bids,
    asks: snapshot.asks,
    exchange_timestamp: snapshot.exchangeTimestamp ? new Date(snapshot.exchangeTimestamp).toISOString() : null,
    latency_ms: snapshot.latencyMs,
    raw_payload: snapshot.rawPayload,
  };
}

function tradeTickInsertRow(tick: ArchivedTradeTick, canonicalSymbol: string) {
  return {
    venue: tick.venue,
    symbol: canonicalSymbol,
    exchange_trade_id: tick.exchangeTradeId,
    exchange_timestamp: tick.exchangeTimestamp ? new Date(tick.exchangeTimestamp).toISOString() : null,
    price: tick.price,
    size: tick.size,
    side: tick.side,
    notional_usd: tick.notionalUsd,
    raw_payload: tick.rawPayload,
  };
}

async function countArchiveRows(
  supabase: SupabaseAdmin,
  table: "orderbook_snapshots" | "trade_ticks",
  symbol: string,
  sinceIso: string,
) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("symbol", symbol)
    .gte("created_at", sinceIso);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

export async function fetchArchiveCoverage(
  supabase: SupabaseAdmin,
  symbol = "BTCUSDT",
  lookbackDays = 14,
): Promise<ArchiveCoverage> {
  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const [orderbookSnapshots, tradeTicks] = await Promise.all([
    countArchiveRows(supabase, "orderbook_snapshots", symbol, sinceIso),
    countArchiveRows(supabase, "trade_ticks", symbol, sinceIso),
  ]);

  return {
    orderbookSnapshots,
    tradeTicks,
  };
}

export async function collectMicrostructureArchiveSample(
  options: {
    symbol?: string;
    mexcSymbol?: string;
    binanceSymbol?: string;
    depthLimit?: number;
    tradeLimit?: number;
  } = {},
) {
  const symbol = options.symbol ?? "BTCUSDT";
  const mexcSymbol = options.mexcSymbol ?? "BTC_USDT";
  const binanceSymbol = options.binanceSymbol ?? "BTCUSDT";
  const depthLimit = options.depthLimit ?? 20;
  const tradeLimit = options.tradeLimit ?? 1_000;

  const [mexcBook, binanceBook, mexcTicks, binanceTicks] = await Promise.all([
    fetchMexcOrderBookSnapshot(mexcSymbol, depthLimit),
    fetchBinanceOrderBookSnapshot(binanceSymbol, depthLimit),
    fetchMexcRecentTradeTicks(mexcSymbol, tradeLimit),
    fetchBinanceRecentTradeTicks(binanceSymbol, tradeLimit),
  ]);

  return {
    symbol,
    orderbookCount: 2,
    tradeTickCount: mexcTicks.length + binanceTicks.length,
    mexcBook,
    binanceBook,
    mexcTicks,
    binanceTicks,
  };
}

export async function persistMicrostructureArchiveSample(
  supabase: SupabaseAdmin,
  options: {
    symbol?: string;
    mexcSymbol?: string;
    binanceSymbol?: string;
    depthLimit?: number;
    tradeLimit?: number;
  } = {},
) {
  const sample = await collectMicrostructureArchiveSample(options);

  const [mexcBook, binanceBook, mexcTicks, binanceTicks] = await Promise.all([
    Promise.resolve(sample.mexcBook),
    Promise.resolve(sample.binanceBook),
    Promise.resolve(sample.mexcTicks),
    Promise.resolve(sample.binanceTicks),
  ]);

  const { error: orderBookError } = await supabase.from("orderbook_snapshots").insert([
    orderBookInsertRow(mexcBook, sample.symbol),
    orderBookInsertRow(binanceBook, sample.symbol),
  ]);
  if (orderBookError) {
    throw orderBookError;
  }

  const tradeRows = [...mexcTicks, ...binanceTicks].map((tick) => tradeTickInsertRow(tick, sample.symbol));
  if (tradeRows.length > 0) {
    const { error: tradeTickError } = await supabase
      .from("trade_ticks")
      .upsert(tradeRows, { onConflict: "venue,symbol,exchange_trade_id" });
    if (tradeTickError) {
      throw tradeTickError;
    }
  }

  return {
    ...sample,
    orderbookInserted: 2,
    tradeTicksUpserted: tradeRows.length,
  };
}

interface ForwardValidationReportRow {
  id: string;
  created_at: string;
  window_end: string;
  execution_mode: string;
  trade_count: number;
  win_rate: number;
  gate_passed: boolean;
  gate_reason: string | null;
}

export async function fetchLatestForwardValidationReports(
  supabase: SupabaseAdmin,
  userId: string,
  symbol = "BTCUSDT",
  limit = 10,
) {
  const { data, error } = await supabase
    .from("forward_validation_reports")
    .select("id, created_at, window_end, execution_mode, trade_count, win_rate, gate_passed, gate_reason")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []) as ForwardValidationReportRow[];
}

function withArchiveCoverage(report: ForwardValidationReport, coverage: ArchiveCoverage, lookbackDays: number) {
  return {
    ...report,
    details: {
      ...report.details,
      archiveCoverage: {
        lookbackDays,
        orderbookSnapshots: coverage.orderbookSnapshots,
        tradeTicks: coverage.tradeTicks,
      },
    },
  };
}

export async function buildAndPersistForwardValidationReports(
  supabase: SupabaseAdmin,
  options: {
    userId: string;
    symbol?: string;
    lookbackDays?: number;
    startingBalanceUsd?: number;
    includeEmpty?: boolean;
  },
) {
  const symbol = options.symbol ?? "BTCUSDT";
  const lookbackDays = options.lookbackDays ?? 14;
  const startingBalanceUsd = options.startingBalanceUsd ?? 10_000;
  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: tradesData, error: tradesError } = await supabase
    .from("trades")
    .select("id, created_at, closed_at, pnl, setup_type, trade_metadata")
    .eq("user_id", options.userId)
    .eq("symbol", symbol)
    .eq("status", "closed")
    .gte("closed_at", sinceIso)
    .order("closed_at", { ascending: true });
  if (tradesError) {
    throw tradesError;
  }

  const { data: tcaData, error: tcaError } = await supabase
    .from("trade_tca")
    .select("trade_id, estimated_fees_usd, entry_slippage_bps, exit_slippage_bps, gross_edge_usd, net_edge_usd, holding_minutes, metadata")
    .eq("user_id", options.userId)
    .eq("symbol", symbol);
  if (tcaError) {
    throw tcaError;
  }

  const mergedTrades = mergeTradesWithTca(
    (tradesData ?? []) as ForwardValidationTrade[],
    (tcaData ?? []) as ForwardValidationTca[],
  );
  const coverage = await fetchArchiveCoverage(supabase, symbol, lookbackDays).catch(() => ({
    orderbookSnapshots: 0,
    tradeTicks: 0,
  }));

  const reports = ["paper", "live"]
    .map((executionMode) => computeForwardValidationReport(mergedTrades, executionMode, undefined, startingBalanceUsd))
    .filter((report) => options.includeEmpty || report.tradeCount > 0)
    .map((report) => withArchiveCoverage(report, coverage, lookbackDays));

  if (reports.length === 0) {
    return [];
  }

  const latestExistingReports = await fetchLatestForwardValidationReports(supabase, options.userId, symbol, 6).catch(() => []);
  const latestByMode = new Map(latestExistingReports.map((row) => [row.execution_mode, row]));

  const insertRows = reports
    .filter((report) => {
      const existing = latestByMode.get(report.executionMode);
      if (!existing) {
        return true;
      }
      return existing.trade_count !== report.tradeCount ||
        existing.gate_passed !== report.gatePassed ||
        existing.gate_reason !== report.gateReason ||
        existing.window_end !== report.windowEnd;
    })
    .map((report) => ({
    user_id: options.userId,
    symbol,
    execution_mode: report.executionMode,
    window_start: report.windowStart,
    window_end: report.windowEnd,
    trade_count: report.tradeCount,
    model_assisted_trade_count: report.modelAssistedTradeCount,
    win_rate: round(report.winRate, 6),
    expectancy_usd: round(report.expectancyUsd, 6),
    profit_factor: round(report.profitFactor, 6),
    total_net_pnl_usd: round(report.totalNetPnlUsd, 6),
    total_fees_usd: round(report.totalFeesUsd, 6),
    avg_net_edge_usd: round(report.avgNetEdgeUsd, 6),
    avg_entry_slippage_bps: round(report.avgEntrySlippageBps, 6),
    avg_exit_slippage_bps: round(report.avgExitSlippageBps, 6),
    avg_holding_minutes: round(report.avgHoldingMinutes, 6),
    max_drawdown_pct: round(report.maxDrawdownPct, 6),
    gate_passed: report.gatePassed,
    gate_reason: report.gateReason,
    details: report.details,
  }));

  if (insertRows.length === 0) {
    return reports;
  }

  const { error: insertError } = await supabase.from("forward_validation_reports").insert(insertRows);
  if (insertError) {
    throw insertError;
  }

  return reports;
}

export async function compareResearchVsForwardValidation(
  supabase: SupabaseAdmin,
  options: {
    userId: string;
    symbol?: string;
    persist?: boolean;
  },
) {
  const symbol = options.symbol ?? "BTCUSDT";
  const latestResearchRun = await fetchLatestResearchRun({
    userId: options.userId,
    runType: "research_cycle",
    symbol,
  });
  if (!latestResearchRun) {
    return null;
  }

  const reports = await fetchLatestForwardValidationReports(supabase, options.userId, symbol, 8);
  const paper = reports.find((row) => row.execution_mode === "paper") ?? null;
  const live = reports.find((row) => row.execution_mode === "live") ?? null;
  const summary = (latestResearchRun.summary ?? {}) as Record<string, unknown>;
  const walkForward = (summary.walkForward ?? {}) as Record<string, unknown>;
  const bestSweepResult = (summary.bestSweepResult ?? {}) as Record<string, unknown>;
  const walkForwardWinRate = Number(walkForward.winRate ?? 0);
  const walkForwardTrades = Number(walkForward.trades ?? 0);
  const walkForwardTotalPnl = Number(walkForward.totalTestPnl ?? 0);
  const bestSweepWinRate = Number(bestSweepResult.winRate ?? 0);

  const comparison = {
    createdAt: new Date().toISOString(),
    sourceResearchRunId: latestResearchRun.id ?? null,
    sourceResearchCreatedAt: latestResearchRun.created_at ?? null,
    walkForward: {
      winRate: walkForwardWinRate,
      trades: walkForwardTrades,
      totalTestPnl: walkForwardTotalPnl,
      bestSweepWinRate,
    },
    forwardValidation: {
      paper,
      live,
    },
    deltas: {
      paperWinRateVsWalkForward: paper ? round(paper.win_rate - walkForwardWinRate, 4) : null,
      liveWinRateVsWalkForward: live ? round(live.win_rate - walkForwardWinRate, 4) : null,
      paperTradeCoverageVsWalkForward: paper ? round(paper.trade_count - walkForwardTrades, 4) : null,
      liveTradeCoverageVsWalkForward: live ? round(live.trade_count - walkForwardTrades, 4) : null,
    },
    status: live
      ? live.gate_passed ? "live_confirmed" : "live_underperforming"
      : paper
        ? paper.gate_passed ? "paper_confirmed" : "paper_underperforming"
        : "awaiting_forward_validation",
  };

  if (options.persist !== false) {
    await insertResearchRun({
      user_id: options.userId,
      run_type: "research_live_comparison",
      symbol,
      objective: "monitoring",
      config: {
        sourceResearchRunId: latestResearchRun.id ?? null,
      },
      summary: comparison,
      artifact_path: null,
    }).catch(() => null);
  }

  return comparison;
}
