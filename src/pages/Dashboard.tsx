import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { EquityChart } from "@/components/dashboard/EquityChart";
import { PriceChart } from "@/components/dashboard/PriceChart";
import { SignalsFeed } from "@/components/dashboard/SignalsFeed";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { QuickTrade } from "@/components/dashboard/QuickTrade";
import { toast } from "sonner";

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

export default function Dashboard() {
  const { user } = useAuth();
  const [candleData] = useState(generateCandleData);
  const [signals, setSignals] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [stats, setStats] = useState({ totalPnl: 0, winRate: 0, totalTrades: 0, maxDrawdown: 0 });
  const [equityData, setEquityData] = useState<any[]>([]);
  const [hasKeys, setHasKeys] = useState(false);

  // Load real data from DB
  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      // Check if user has API keys
      const { data: keyData } = await supabase
        .from("api_keys")
        .select("mexc_key")
        .eq("user_id", user.id)
        .maybeSingle();
      setHasKeys(!!keyData?.mexc_key);

      // Load signals
      const { data: sigData } = await supabase
        .from("signals")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (sigData) setSignals(sigData);

      // Load open trades
      const { data: tradeData } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "open")
        .order("created_at", { ascending: false });
      if (tradeData) setTrades(tradeData);

      // Calculate stats from all trades
      const { data: allTrades } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (allTrades && allTrades.length > 0) {
        const closedTrades = allTrades.filter(t => t.status === "closed");
        const totalPnl = closedTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
        const wins = closedTrades.filter(t => (Number(t.pnl) || 0) > 0).length;
        const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

        // Calculate equity curve
        let equity = 10; // Starting balance
        const eqData = allTrades.map((t, i) => {
          if (t.status === "closed" && t.pnl) equity += Number(t.pnl);
          return { time: `Trade ${i + 1}`, equity: Math.round(equity * 100) / 100 };
        });

        // Max drawdown
        let peak = 10;
        let maxDd = 0;
        eqData.forEach(d => {
          if (d.equity > peak) peak = d.equity;
          const dd = ((peak - d.equity) / peak) * 100;
          if (dd > maxDd) maxDd = dd;
        });

        setStats({
          totalPnl: Math.round(totalPnl * 100) / 100,
          winRate: Math.round(winRate * 10) / 10,
          totalTrades: allTrades.length,
          maxDrawdown: Math.round(maxDd * 10) / 10,
        });
        setEquityData(eqData.length > 0 ? eqData : [{ time: "Start", equity: 10 }]);
      } else {
        setEquityData([{ time: "Start", equity: 10 }]);
      }
    };

    loadData();
  }, [user]);

  // Realtime subscriptions
  useEffect(() => {
    if (!user) return;

    const signalChannel = supabase
      .channel("signals-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "signals" }, (payload) => {
        const newSig = payload.new as any;
        if (newSig.user_id === user.id) {
          setSignals(prev => [newSig, ...prev].slice(0, 20));
        }
      })
      .subscribe();

    const tradeChannel = supabase
      .channel("trades-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, (payload) => {
        const record = (payload.new || payload.old) as any;
        if (record?.user_id === user.id) {
          // Reload trades on any change
          supabase
            .from("trades")
            .select("*")
            .eq("user_id", user.id)
            .eq("status", "open")
            .order("created_at", { ascending: false })
            .then(({ data }) => { if (data) setTrades(data); });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(signalChannel);
      supabase.removeChannel(tradeChannel);
    };
  }, [user]);

  const handleTrade = async (side: "buy" | "sell") => {
    if (!user) return;
    const mappedSide = side === "buy" ? "long" : "short";
    try {
      const { data, error } = await supabase.functions.invoke("scalper", {
        body: { user_id: user.id, side: mappedSide },
      });
      if (error) throw error;
      toast.success(`${mappedSide.toUpperCase()} order submitted`, {
        description: data?.results?.[0]?.detail || "Processing...",
      });
    } catch (err: any) {
      toast.error("Trade failed", { description: err.message });
    }
  };

  const handleClosePosition = async (id: string) => {
    if (!user) return;
    try {
      const { data, error } = await supabase.functions.invoke("scalper", {
        body: { user_id: user.id, side: "close" },
      });
      if (error) throw error;
      toast.success("Close order submitted");
    } catch (err: any) {
      toast.error("Close failed", { description: err.message });
    }
  };

  return (
    <div className="space-y-4 animate-slide-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">BTC_USDT Perpetual · Futures</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${hasKeys ? "bg-profit animate-pulse-green" : "bg-warning"}`} />
          <span className="text-xs text-muted-foreground">{hasKeys ? "Connected" : "No API Keys"}</span>
        </div>
      </div>

      <StatsCards totalPnl={stats.totalPnl} winRate={stats.winRate} totalTrades={stats.totalTrades} maxDrawdown={stats.maxDrawdown} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <PriceChart data={candleData} />
          <EquityChart data={equityData} />
        </div>
        <div className="space-y-4">
          <QuickTrade onTrade={handleTrade} disabled={!hasKeys} />
          <SignalsFeed signals={signals} />
        </div>
      </div>

      <PositionsTable trades={trades} onClose={handleClosePosition} />
    </div>
  );
}
