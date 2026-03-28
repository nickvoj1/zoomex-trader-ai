import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Upload, Play, Loader2 } from "lucide-react";

interface BacktestResult {
  equity: { time: string; equity: number }[];
  sharpe: number;
  mdd: number;
  totalPnl: number;
  trades: number;
  winRate: number;
}

function runBacktest(): BacktestResult {
  const equity: { time: string; equity: number }[] = [];
  let bal = 10000;
  let maxBal = bal;
  let maxDD = 0;
  let wins = 0;
  let totalTrades = 0;

  for (let i = 0; i < 365; i++) {
    const rsi = 20 + Math.random() * 60;
    if (rsi < 30) {
      const pnl = (Math.random() - 0.4) * 100;
      bal += pnl;
      totalTrades++;
      if (pnl > 0) wins++;
    } else if (rsi > 70) {
      const pnl = (Math.random() - 0.45) * 80;
      bal += pnl;
      totalTrades++;
      if (pnl > 0) wins++;
    }
    maxBal = Math.max(maxBal, bal);
    const dd = ((maxBal - bal) / maxBal) * 100;
    maxDD = Math.max(maxDD, dd);
    equity.push({ time: `D${i + 1}`, equity: Math.round(bal * 100) / 100 });
  }

  return {
    equity,
    sharpe: 1.2 + Math.random() * 0.8,
    mdd: maxDD,
    totalPnl: bal - 10000,
    trades: totalTrades,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
  };
}

export default function BacktestPage() {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRun = () => {
    setLoading(true);
    setTimeout(() => {
      setResult(runBacktest());
      setLoading(false);
    }, 1500);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Backtest</h1>
        <p className="text-sm text-muted-foreground">Simulate RSI strategy on historical data</p>
      </div>

      <Card className="glass-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">Strategy Parameters</CardTitle>
          <CardDescription>RSI(14) mean-reversion scalping</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">RSI Buy Threshold</Label>
              <Input type="number" defaultValue={30} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">RSI Sell Threshold</Label>
              <Input type="number" defaultValue={70} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Take Profit %</Label>
              <Input type="number" defaultValue={0.3} step={0.1} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Stop Loss %</Label>
              <Input type="number" defaultValue={0.15} step={0.05} className="font-mono" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1">
              <Upload className="h-4 w-4 mr-2" />
              Upload CSV
            </Button>
            <Button onClick={handleRun} disabled={loading} className="flex-1">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
              Run Backtest
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Total P&L", value: `$${result.totalPnl.toFixed(2)}`, positive: result.totalPnl >= 0 },
              { label: "Sharpe Ratio", value: result.sharpe.toFixed(2), positive: result.sharpe > 1 },
              { label: "Max Drawdown", value: `${result.mdd.toFixed(2)}%`, positive: result.mdd < 10 },
              { label: "Win Rate", value: `${result.winRate.toFixed(1)}%`, positive: result.winRate >= 50 },
            ].map((s) => (
              <div key={s.label} className="glass-card rounded-xl p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{s.label}</p>
                <p className={`text-xl font-bold font-mono ${s.positive ? "text-profit" : "text-loss"}`}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>

          <Card className="glass-card border-border">
            <CardContent className="pt-6">
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={result.equity}>
                    <defs>
                      <linearGradient id="btGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(152, 100%, 45%)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="hsl(152, 100%, 45%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 15%)" />
                    <XAxis dataKey="time" tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 10 }} />
                    <YAxis tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(220, 18%, 10%)",
                        border: "1px solid hsl(220, 14%, 22%)",
                        borderRadius: "8px",
                        color: "hsl(210, 20%, 92%)",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="equity"
                      stroke="hsl(152, 100%, 45%)"
                      fill="url(#btGrad)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
