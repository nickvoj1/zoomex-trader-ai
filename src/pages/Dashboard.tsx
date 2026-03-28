import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { EquityChart } from "@/components/dashboard/EquityChart";
import { PriceChart } from "@/components/dashboard/PriceChart";
import { SignalsFeed } from "@/components/dashboard/SignalsFeed";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { QuickTrade } from "@/components/dashboard/QuickTrade";
import { TradeHistoryTable } from "@/components/dashboard/TradeHistoryTable";
import { toast } from "sonner";

const PAPER_STARTING_BALANCE = 10_000;
const MEXC_KLINE_URL = "https://api.mexc.com/api/v1/contract/kline/BTC_USDT?interval=Min1&limit=60";

type SignalRow = Tables<"signals">;
type TradeRow = Tables<"trades">;

interface CandlePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  rsi: number;
}

interface EquityPoint {
  time: string;
  equity: number;
}

function calculateRsiSeries(closes: number[], period = 14) {
  const values = Array.from({ length: closes.length }, () => 50);
  if (closes.length < period + 1) {
    return values;
  }

  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const diff = closes[index] - closes[index - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  values[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < closes.length; index += 1) {
    const diff = closes[index] - closes[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    values[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return values.map((value) => Number(value.toFixed(1)));
}

function createPlaceholderCandleData(): CandlePoint[] {
  const candles: CandlePoint[] = [];
  let price = 65_000;

  for (let index = 0; index < 60; index += 1) {
    const change = (Math.random() - 0.5) * 200;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 80;
    const low = Math.min(open, close) - Math.random() * 80;
    price = close;
    candles.push({
      time: `${index}m`,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      rsi: 50,
    });
  }

  const rsiValues = calculateRsiSeries(candles.map((candle) => candle.close));
  return candles.map((candle, index) => ({ ...candle, rsi: rsiValues[index] ?? 50 }));
}

function mapKlinesToChartData(payload: unknown): CandlePoint[] {
  const toChartRows = (rows: Array<{ open: number; high: number; low: number; close: number; time?: number }>) => {
    const rsiValues = calculateRsiSeries(rows.map((row) => row.close));
    return rows.map((row, index) => ({
      time: row.time
        ? new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : `${index}m`,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      rsi: rsiValues[index] ?? 50,
    }));
  };

  if (Array.isArray(payload)) {
    return toChartRows(payload.map((item) => ({
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      time: Number(item.time ?? item.t ?? 0),
    })));
  }

  if (payload && typeof payload === "object" && Array.isArray((payload as { close?: unknown[] }).close)) {
    const arrays = payload as {
      time?: unknown[];
      open?: unknown[];
      high?: unknown[];
      low?: unknown[];
      close: unknown[];
      vol?: unknown[];
    };

    return toChartRows(
      arrays.close.map((close, index) => ({
        open: Number(arrays.open?.[index]),
        high: Number(arrays.high?.[index]),
        low: Number(arrays.low?.[index]),
        close: Number(close),
        time: Number(arrays.time?.[index] ?? 0),
      })),
    );
  }

  throw new Error("Unsupported MEXC kline payload");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function applyTradeState(
  tradeRows: TradeRow[] | null,
  setOpenTrades: Dispatch<SetStateAction<TradeRow[]>>,
  setAllTrades: Dispatch<SetStateAction<TradeRow[]>>,
  setStats: Dispatch<SetStateAction<{ totalPnl: number; winRate: number; totalTrades: number; maxDrawdown: number }>>,
  setEquityData: Dispatch<SetStateAction<EquityPoint[]>>,
) {
  if (!tradeRows || tradeRows.length === 0) {
    setOpenTrades([]);
    setAllTrades([]);
    setStats({ totalPnl: 0, winRate: 0, totalTrades: 0, maxDrawdown: 0 });
    setEquityData([{ time: "Start", equity: PAPER_STARTING_BALANCE }]);
    return;
  }

  const ascendingTrades = [...tradeRows].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
  const closedTrades = ascendingTrades.filter((trade) => trade.status === "closed");
  const totalPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
  const wins = closedTrades.filter((trade) => Number(trade.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

  let equity = PAPER_STARTING_BALANCE;
  const nextEquityData = ascendingTrades.map((trade, index) => {
    if (trade.status === "closed" && trade.pnl !== null) {
      equity += Number(trade.pnl);
    }
    return { time: `Trade ${index + 1}`, equity: Number(equity.toFixed(2)) };
  });

  let peak = PAPER_STARTING_BALANCE;
  let maxDrawdown = 0;
  nextEquityData.forEach((point) => {
    peak = Math.max(peak, point.equity);
    const drawdown = peak === 0 ? 0 : ((peak - point.equity) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  });

  setOpenTrades(ascendingTrades.filter((trade) => trade.status === "open").reverse());
  setAllTrades([...ascendingTrades].reverse());
  setStats({
    totalPnl: Number(totalPnl.toFixed(2)),
    winRate: Number(winRate.toFixed(1)),
    totalTrades: ascendingTrades.length,
    maxDrawdown: Number(maxDrawdown.toFixed(1)),
  });
  setEquityData(nextEquityData.length > 0 ? nextEquityData : [{ time: "Start", equity: PAPER_STARTING_BALANCE }]);
}

export default function Dashboard() {
  const { user } = useAuth();
  const [candleData, setCandleData] = useState<CandlePoint[]>(createPlaceholderCandleData);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [openTrades, setOpenTrades] = useState<TradeRow[]>([]);
  const [allTrades, setAllTrades] = useState<TradeRow[]>([]);
  const [stats, setStats] = useState({ totalPnl: 0, winRate: 0, totalTrades: 0, maxDrawdown: 0 });
  const [equityData, setEquityData] = useState<EquityPoint[]>([{ time: "Start", equity: PAPER_STARTING_BALANCE }]);
  const [hasKeys, setHasKeys] = useState(false);

  useEffect(() => {
    let active = true;

    const loadMarketData = async () => {
      try {
        const response = await fetch(MEXC_KLINE_URL);
        const payload = await response.json() as { data?: unknown };
        if (active && payload.data) {
          setCandleData(mapKlinesToChartData(payload.data));
        }
      } catch {
        if (active) {
          setCandleData(createPlaceholderCandleData());
        }
      }
    };

    loadMarketData();
    const interval = window.setInterval(loadMarketData, 60_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      const { data: keyData } = await supabase
        .from("api_keys")
        .select("mexc_key")
        .eq("user_id", user.id)
        .maybeSingle();
      setHasKeys(Boolean(keyData?.mexc_key));

      const { data: signalRows } = await supabase
        .from("signals")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (signalRows) setSignals(signalRows);

      const { data: tradeRows } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "open")
        .order("created_at", { ascending: false });
      if (tradeRows) setOpenTrades(tradeRows);

      const { data: allTradeRows } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      applyTradeState(allTradeRows, setOpenTrades, setAllTrades, setStats, setEquityData);
    };

    void loadData();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const signalChannel = supabase
      .channel("signals-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const nextSignal = payload.new as SignalRow;
        if (nextSignal.user_id === user.id) {
          setSignals((previous) => [nextSignal, ...previous].slice(0, 20));
        }
      })
      .subscribe();

    const tradeChannel = supabase
      .channel("trades-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, (payload) => {
        const record = (payload.new || payload.old) as TradeRow;
        if (record?.user_id === user.id) {
          void supabase
            .from("trades")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .then(({ data }) => {
              applyTradeState(data ? [...data].reverse() : null, setOpenTrades, setAllTrades, setStats, setEquityData);
            });
        }
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(signalChannel);
      void supabase.removeChannel(tradeChannel);
    };
  }, [user]);

  const handleTrade = async (side: "buy" | "sell") => {
    const mappedSide = side === "buy" ? "long" : "short";

    try {
      const { data, error } = await supabase.functions.invoke("scalper", {
        body: { side: mappedSide },
      });
      if (error) throw error;

      toast.success(`${mappedSide.toUpperCase()} request submitted`, {
        description: data?.results?.[0]?.detail || "Strategy evaluation started.",
      });
    } catch (error) {
      toast.error("Trade failed", { description: getErrorMessage(error) });
    }
  };

  const handleClosePosition = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("scalper", {
        body: { side: "close" },
      });
      if (error) throw error;

      toast.success("Close request submitted", {
        description: data?.results?.[0]?.detail || "Open position close requested.",
      });
    } catch (error) {
      toast.error("Close failed", { description: getErrorMessage(error) });
    }
  };

  return (
    <div className="space-y-4 animate-slide-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">BTC_USDT perpetual on MEXC futures</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${hasKeys ? "bg-profit animate-pulse-green" : "bg-warning"}`} />
          <span className="text-xs text-muted-foreground">{hasKeys ? "Keys configured" : "No API keys"}</span>
        </div>
      </div>

      <StatsCards
        totalPnl={stats.totalPnl}
        winRate={stats.winRate}
        totalTrades={stats.totalTrades}
        maxDrawdown={stats.maxDrawdown}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <PriceChart data={candleData} />
          <EquityChart data={equityData} />
        </div>
        <div className="space-y-4">
          <QuickTrade onTrade={handleTrade} disabled={!hasKeys} />
          <SignalsFeed signals={signals} />
        </div>
      </div>

      <PositionsTable trades={openTrades} onClose={handleClosePosition} />
      <TradeHistoryTable trades={allTrades} />
    </div>
  );
}
