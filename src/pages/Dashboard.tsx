import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { EquityChart } from "@/components/dashboard/EquityChart";
import { PriceChart } from "@/components/dashboard/PriceChart";
import { SignalsFeed } from "@/components/dashboard/SignalsFeed";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { QuickTrade } from "@/components/dashboard/QuickTrade";

// Mock data generators
function generateEquityData() {
  const data = [];
  let equity = 10000;
  for (let i = 0; i < 30; i++) {
    equity += (Math.random() - 0.45) * 200;
    data.push({
      time: `Day ${i + 1}`,
      equity: Math.round(equity * 100) / 100,
    });
  }
  return data;
}

function generateCandleData() {
  const data = [];
  let price = 65000;
  for (let i = 0; i < 60; i++) {
    const change = (Math.random() - 0.5) * 200;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 100;
    const low = Math.min(open, close) - Math.random() * 100;
    const rsi = 30 + Math.random() * 40;
    price = close;
    data.push({
      time: `${i}m`,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      rsi: Math.round(rsi * 10) / 10,
    });
  }
  return data;
}

const mockSignals = [
  { id: "1", rsi: 28.3, price: 64850, signal: "buy" as const, ai_reasoning: "RSI oversold at 28.3, price near support at $64.8k. Momentum divergence suggests reversal. Entry recommended.", created_at: new Date(Date.now() - 60000).toISOString() },
  { id: "2", rsi: 45.1, price: 65120, signal: "hold" as const, ai_reasoning: "Neutral zone. Waiting for clearer signal.", created_at: new Date(Date.now() - 120000).toISOString() },
  { id: "3", rsi: 72.5, price: 65430, signal: "sell" as const, ai_reasoning: "RSI overbought. Consider taking profit on longs.", created_at: new Date(Date.now() - 180000).toISOString() },
];

const mockTrades = [
  { id: "1", symbol: "BTCUSDT", side: "buy", size: 0.001, entry_price: 64850, tp: 65044, sl: 64753, pnl: 0.12, leverage: 50, status: "open" },
  { id: "2", symbol: "BTCUSDT", side: "sell", size: 0.002, entry_price: 65430, tp: 65234, sl: 65528, pnl: -0.05, leverage: 25, status: "open" },
];

export default function Dashboard() {
  const { user } = useAuth();
  const [equityData] = useState(generateEquityData);
  const [candleData] = useState(generateCandleData);
  const [signals, setSignals] = useState(mockSignals);
  const [trades, setTrades] = useState(mockTrades);

  // Subscribe to realtime signals
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("signals-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const newSig = payload.new as any;
        setSignals((prev) => [newSig, ...prev].slice(0, 20));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const handleTrade = (side: "buy" | "sell") => {
    // In production, this calls the MEXC edge function
    console.log(`Quick trade: ${side} 0.001 BTC`);
  };

  const handleClosePosition = (id: string) => {
    setTrades((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="space-y-4 animate-slide-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">BTCUSDT Perpetual · Live</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-profit animate-pulse-green" />
          <span className="text-xs text-muted-foreground">Connected</span>
        </div>
      </div>

      <StatsCards totalPnl={1247.32} winRate={64.2} totalTrades={156} maxDrawdown={3.8} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <PriceChart data={candleData} />
          <EquityChart data={equityData} />
        </div>
        <div className="space-y-4">
          <QuickTrade onTrade={handleTrade} />
          <SignalsFeed signals={signals} />
        </div>
      </div>

      <PositionsTable trades={trades} onClose={handleClosePosition} />
    </div>
  );
}
