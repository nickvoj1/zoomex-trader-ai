import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchCrossVenueSnapshot } from "../../src/lib/market-intel";
import { getOpenPositions } from "../../supabase/functions/_shared/mexc";
import {
  buildAndPersistForwardValidationReports,
  persistMicrostructureArchiveSample,
} from "./live-ops";
import { booleanArg, numberArg, parseArgs, stringArg } from "./shared";

interface QueryResult<T = unknown> {
  data: T;
  error: { message: string } | null;
}

type SupabaseAdmin = SupabaseClient;

interface ClosedTradeRow {
  id: string;
  user_id: string;
  symbol: string;
  size: number;
  entry_price: number;
  exit_price: number | null;
  created_at: string;
  closed_at: string | null;
  trade_metadata: Record<string, unknown> | null;
  pnl: number | null;
}

interface LiquidationEvent {
  timestamp: number;
  direction: 1 | -1;
  usdSize: number;
}

const BINANCE_FORCE_ORDER_URL = "wss://fstream.binance.com/ws/btcusdt@forceOrder";

function round(value: number, precision = 4) {
  return Number(value.toFixed(precision));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeLiquidationMetrics(events: LiquidationEvent[], lookbackMs: number) {
  const cutoff = Date.now() - lookbackMs;
  const recent = events.filter((event) => event.timestamp >= cutoff);
  const grossUsd = recent.reduce((sum, event) => sum + event.usdSize, 0);
  const signedUsd = recent.reduce((sum, event) => sum + event.usdSize * event.direction, 0);
  return {
    bias: grossUsd === 0 ? 0 : round(signedUsd / grossUsd, 6),
    intensity: round(grossUsd / 1_000_000, 6),
    count: recent.length,
  };
}

function createLiquidationCollector(enabled: boolean) {
  const events: LiquidationEvent[] = [];
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const connect = () => {
    if (!enabled || typeof WebSocket === "undefined") {
      return;
    }

    ws = new WebSocket(BINANCE_FORCE_ORDER_URL);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          o?: { S?: string; ap?: string; q?: string; z?: string; T?: number };
        };
        const order = message.o;
        if (!order) return;
        const price = Number(order.ap ?? 0);
        const quantity = Number(order.z ?? order.q ?? 0);
        const usdSize = price * quantity;
        if (!Number.isFinite(usdSize) || usdSize <= 0) return;
        events.push({
          timestamp: Number(order.T ?? Date.now()),
          direction: order.S === "BUY" ? 1 : -1,
          usdSize,
        });
        const cutoff = Date.now() - 60 * 60 * 1000;
        while (events.length > 0 && events[0].timestamp < cutoff) {
          events.shift();
        }
      } catch {
        // ignore malformed events
      }
    };

    ws.onclose = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 5_000);
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        // ignore close errors
      }
    };
  };

  connect();

  return {
    getMetrics: () => computeLiquidationMetrics(events, 15 * 60 * 1000),
    close: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore close errors
      }
    },
  };
}

async function insertExecutionEvent(
  supabase: SupabaseAdmin,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase.from("execution_events").insert(payload as unknown);
  if (error) {
    console.error("execution_events insert failed:", error.message);
  }
}

async function insertMarketSnapshot(
  supabase: SupabaseAdmin,
  snapshot: Awaited<ReturnType<typeof fetchCrossVenueSnapshot>>,
  symbol: string,
) {
  const rows: Array<Record<string, unknown>> = [snapshot.primary, snapshot.secondary]
    .filter((entry) => entry !== null)
    .map((entry) => ({
      venue: entry!.venue,
      symbol,
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
      symbol,
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
    console.error("market_snapshots insert failed:", error.message);
  }
}

async function reconcilePositions(
  supabase: SupabaseAdmin,
  userId: string,
  symbol: string,
) {
  const { data: keysRow } = await supabase
    .from("api_keys")
    .select("mexc_key, mexc_secret")
    .eq("user_id", userId)
    .maybeSingle();
  const typedKeys = (keysRow ?? null) as { mexc_key?: string | null; mexc_secret?: string | null } | null;
  const mexcKey = typedKeys?.mexc_key;
  const mexcSecret = typedKeys?.mexc_secret;

  const { data: trades, error: tradesError } = await (
    supabase
      .from("trades")
      .select("id, side, size, entry_price, trade_metadata")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .eq("status", "open") as unknown as Promise<QueryResult<unknown>>
  );
  if (tradesError) {
    throw tradesError;
  }
  const typedTrades = (trades ?? []) as Array<Record<string, unknown>>;

  let exchangePositions: unknown[] = [];
  if (mexcKey && mexcSecret) {
    const response = await getOpenPositions(mexcKey, mexcSecret, "BTC_USDT");
    exchangePositions = Array.isArray(response.data) ? response.data : [];
  }

  const tradeCount = typedTrades.length;
  const exchangeCount = exchangePositions.length;
  const status = tradeCount === exchangeCount ? "matched" : "mismatch";

  const { error } = await supabase.from("position_reconciliations").insert({
    user_id: userId,
    symbol,
    status,
    open_trade_count: tradeCount,
    exchange_position_count: exchangeCount,
    trade_snapshot: typedTrades,
    exchange_snapshot: exchangePositions,
    notes: status === "matched" ? "database and exchange position counts match" : "position count mismatch detected",
  } as unknown);
  if (error) {
    console.error("position_reconciliations insert failed:", error.message);
  }

  return { status, tradeCount, exchangeCount };
}

async function analyzeTradeCosts(
  supabase: SupabaseAdmin,
  userId: string,
  symbol: string,
) {
  const { data: trades, error } = await (
    supabase
      .from("trades")
      .select("id, user_id, symbol, side, size, entry_price, exit_price, leverage, created_at, closed_at, trade_metadata, pnl")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(50) as unknown as Promise<QueryResult<unknown>>
  );
  if (error) {
    throw error;
  }

  for (const trade of (trades ?? []) as ClosedTradeRow[]) {
    const metadata = (trade.trade_metadata ?? {}) as Record<string, unknown>;
    const execution = (metadata.execution ?? {}) as Record<string, unknown>;
    const expectedEntryPrice = Number(execution.requestedEntryPrice ?? trade.entry_price);
    const expectedExitPrice = Number(execution.requestedExitPrice ?? trade.exit_price ?? trade.entry_price);
    const exitPrice = Number(trade.exit_price ?? trade.entry_price);
    const entryPrice = Number(trade.entry_price);
    const size = Number(trade.size ?? 0);
    const entrySlippageBps = expectedEntryPrice === 0 ? 0 : Math.abs((entryPrice - expectedEntryPrice) / expectedEntryPrice) * 10_000;
    const exitSlippageBps = expectedExitPrice === 0 ? 0 : Math.abs((exitPrice - expectedExitPrice) / expectedExitPrice) * 10_000;
    const feesEstimate = Number(execution.feesEstimate ?? ((entryPrice + exitPrice) * size * 0.0004));
    const grossEdgeUsd = Number(trade.pnl ?? 0) + feesEstimate;
    const netEdgeUsd = Number(trade.pnl ?? 0);
    const holdingMinutes = trade.closed_at
      ? (Date.parse(trade.closed_at) - Date.parse(trade.created_at)) / 60_000
      : null;

    const { error: upsertError } = await supabase.from("trade_tca").upsert({
      trade_id: trade.id,
      user_id: trade.user_id,
      symbol: trade.symbol,
      estimated_fees_usd: round(feesEstimate, 6),
      entry_slippage_bps: round(entrySlippageBps, 6),
      exit_slippage_bps: round(exitSlippageBps, 6),
      gross_edge_usd: round(grossEdgeUsd, 6),
      net_edge_usd: round(netEdgeUsd, 6),
      holding_minutes: holdingMinutes !== null ? round(holdingMinutes, 4) : null,
      metadata: {
        pnl: trade.pnl,
        execution,
      },
    } as unknown, { onConflict: "trade_id" });
    if (upsertError) {
      console.error("trade_tca upsert failed:", upsertError.message);
    }
  }
}

async function callScalper(
  scalperUrl: string,
  serviceRoleKey: string,
  userId?: string,
) {
  const startedAt = Date.now();
  const response = await fetch(scalperUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(userId ? { user_id: userId } : {}),
  });
  const body = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    body,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const scalperUrl = stringArg(args, "scalper-url", `${supabaseUrl}/functions/v1/scalper`)!;
  const userId = stringArg(args, "user-id", process.env.BOT_USER_ID);
  const symbol = stringArg(args, "symbol", "BTCUSDT")!;
  const intervalMs = numberArg(args, "interval-ms", 60_000);
  const once = booleanArg(args, "once", false);
  const enableLiquidations = booleanArg(args, "enable-liquidations", true);
  const forwardLookbackDays = numberArg(args, "forward-lookback-days", 14);
  const startingBalanceUsd = numberArg(args, "starting-balance", 10_000);
  const archiveDepthLimit = numberArg(args, "archive-depth-limit", 20);
  const archiveTradeLimit = numberArg(args, "archive-trade-limit", 1_000);
  const supabase = createClient(supabaseUrl, serviceRoleKey) as SupabaseAdmin;
  const liquidationCollector = createLiquidationCollector(enableLiquidations);

  try {
    let keepRunning = true;
    while (keepRunning) {
      const cycleStartedAt = Date.now();
      const liquidationMetrics = liquidationCollector.getMetrics();
      const snapshot = await fetchCrossVenueSnapshot({
        mexcSymbol: "BTC_USDT",
        binanceSymbol: symbol,
        liquidationMetrics,
      });
      await insertMarketSnapshot(supabase, snapshot, symbol);
      const archiveSummary = await persistMicrostructureArchiveSample(supabase, {
        symbol,
        mexcSymbol: "BTC_USDT",
        binanceSymbol: symbol,
        depthLimit: archiveDepthLimit,
        tradeLimit: archiveTradeLimit,
      }).catch((error) => {
        console.error("microstructure archive persist failed:", error instanceof Error ? error.message : error);
        return null;
      });

      const scalper = await callScalper(scalperUrl, serviceRoleKey, userId);
      await insertExecutionEvent(supabase, {
        user_id: userId ?? null,
        venue: "supabase",
        symbol,
        event_type: "decision_cycle",
        status: scalper.ok ? "success" : "error",
        latency_ms: scalper.latencyMs,
        details: {
          response: scalper.body,
          marketSnapshot: {
            crossVenueBasisBps: snapshot.microstructure?.crossVenueBasisBps ?? null,
            spreadBps: snapshot.microstructure?.primaryBook?.spreadBps ?? null,
            liquidationMetrics,
          },
        },
      });

      if (userId) {
        const reconciliation = await reconcilePositions(supabase, userId, symbol);
        await insertExecutionEvent(supabase, {
          user_id: userId,
          venue: "mexc",
          symbol,
          event_type: "position_reconciliation",
          status: reconciliation.status,
          latency_ms: Date.now() - cycleStartedAt,
          details: reconciliation,
        });
        await analyzeTradeCosts(supabase, userId, symbol);
        const forwardReports = await buildAndPersistForwardValidationReports(supabase, {
          userId,
          symbol,
          lookbackDays: forwardLookbackDays,
          startingBalanceUsd,
          includeEmpty: false,
        }).catch((error) => {
          console.error("forward validation report failed:", error instanceof Error ? error.message : error);
          return [];
        });
        if (forwardReports.length > 0) {
          await insertExecutionEvent(supabase, {
            user_id: userId,
            venue: "supabase",
            symbol,
            event_type: "forward_validation",
            status: forwardReports.every((report) => report.gatePassed) ? "success" : "warning",
            latency_ms: Date.now() - cycleStartedAt,
            details: {
              reports: forwardReports,
            },
          });
        }
      }

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - cycleStartedAt,
        crossVenueBasisBps: snapshot.microstructure?.crossVenueBasisBps ?? null,
        scalperStatus: scalper.status,
        archiveOrderbookInserted: archiveSummary?.orderbookInserted ?? null,
        archiveTradeTicksUpserted: archiveSummary?.tradeTicksUpserted ?? null,
      }, null, 2));

      if (once) {
        keepRunning = false;
        continue;
      }
      await sleep(intervalMs);
    }
  } finally {
    liquidationCollector.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
