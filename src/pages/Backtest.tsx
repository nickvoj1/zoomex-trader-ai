import { useRef, useState } from "react";
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
import { Loader2, Play, Upload } from "lucide-react";
import {
  BacktestResult,
  MarketCandle,
  parseCsvCandles,
  simulateStrategy,
  StrategySettings,
} from "@/lib/strategy-core";

function generateSampleCandles(length = 3000): MarketCandle[] {
  const candles: MarketCandle[] = [];
  let price = 65000;
  const start = Date.UTC(2026, 0, 1);

  for (let index = 0; index < length; index += 1) {
    const regimeShift = index < length / 3 ? 18 : index < (length * 2) / 3 ? -10 : 4;
    const noise = (Math.random() - 0.5) * 90;
    const drift = regimeShift + noise;
    const open = price;
    const close = Math.max(5000, price + drift);
    const high = Math.max(open, close) + Math.random() * 40;
    const low = Math.min(open, close) - Math.random() * 40;
    const volume = 50 + Math.random() * 80 + Math.abs(drift) * 0.4;
    candles.push({
      timestamp: start + index * 60_000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }

  return candles;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export default function BacktestPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [dataLabel, setDataLabel] = useState("No dataset loaded");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<StrategySettings>({
    riskPct: 0.5,
    leverage: 10,
    minConfidence: 78,
    dailyLossLimitPct: 3,
    maxConsecutiveLosses: 3,
    allowTrendTrades: true,
    allowMeanReversionTrades: true,
    feeBps: 4,
    slippageBps: 3,
    maxBarsInTrade: 90,
    partialTakeProfitRR: 1.2,
    allowSessionFilter: true,
    sessionStartHourUtc: 6,
    sessionEndHourUtc: 22,
  });

  const handleFileUpload = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseCsvCandles(text);
      if (parsed.length < 1200) {
        throw new Error("Need at least 1200 one-minute candles for the multi-timeframe backtest.");
      }

      setCandles(parsed);
      setDataLabel(`${file.name} · ${parsed.length} candles`);
      setResult(null);
      setError(null);
    } catch (uploadError) {
      setError(getErrorMessage(uploadError));
      setCandles([]);
    }
  };

  const handleRun = () => {
    setLoading(true);
    setError(null);

    window.setTimeout(() => {
      try {
        const dataset = candles.length > 0 ? candles : generateSampleCandles();
        const backtest = simulateStrategy(dataset, settings, 10_000);
        setResult(backtest);
        setDataLabel(candles.length > 0 ? dataLabel : `Synthetic sample · ${dataset.length} candles`);
      } catch (runError) {
        setError(getErrorMessage(runError));
      } finally {
        setLoading(false);
      }
    }, 20);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 animate-slide-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Backtest</h1>
        <p className="text-sm text-muted-foreground">
          Runs the same advanced strategy engine on uploaded 1-minute OHLCV CSV data.
        </p>
      </div>

      <Card className="glass-card border-border">
        <CardHeader>
          <CardTitle className="text-lg">Research Parameters</CardTitle>
          <CardDescription>{dataLabel}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFileUpload(file);
            }}
          />

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Risk %</Label>
              <Input
                type="number"
                value={settings.riskPct}
                step={0.1}
                min={0.1}
                max={2}
                onChange={(event) => setSettings({ ...settings, riskPct: Number(event.target.value) || 0.5 })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Leverage</Label>
              <Input
                type="number"
                value={settings.leverage}
                min={1}
                max={50}
                onChange={(event) => setSettings({ ...settings, leverage: Number(event.target.value) || 10 })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Min Confidence</Label>
              <Input
                type="number"
                value={settings.minConfidence}
                min={60}
                max={95}
                onChange={(event) => setSettings({ ...settings, minConfidence: Number(event.target.value) || 78 })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Daily Loss Limit %</Label>
              <Input
                type="number"
                value={settings.dailyLossLimitPct}
                min={0.5}
                max={10}
                step={0.5}
                onChange={(event) =>
                  setSettings({ ...settings, dailyLossLimitPct: Number(event.target.value) || 3 })
                }
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Max Consecutive Losses</Label>
              <Input
                type="number"
                value={settings.maxConsecutiveLosses}
                min={1}
                max={8}
                onChange={(event) =>
                  setSettings({ ...settings, maxConsecutiveLosses: Number(event.target.value) || 3 })
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Fee (bps)</Label>
              <Input
                type="number"
                value={settings.feeBps}
                min={0}
                max={20}
                step={0.5}
                onChange={(event) => setSettings({ ...settings, feeBps: Number(event.target.value) || 0 })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Slippage (bps)</Label>
              <Input
                type="number"
                value={settings.slippageBps}
                min={0}
                max={20}
                step={0.5}
                onChange={(event) => setSettings({ ...settings, slippageBps: Number(event.target.value) || 0 })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max Bars in Trade</Label>
              <Input
                type="number"
                value={settings.maxBarsInTrade}
                min={5}
                max={300}
                step={1}
                onChange={(event) => setSettings({ ...settings, maxBarsInTrade: Number(event.target.value) || 90 })}
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Partial TP (R)</Label>
              <Input
                type="number"
                value={settings.partialTakeProfitRR}
                min={0.5}
                max={3}
                step={0.1}
                onChange={(event) =>
                  setSettings({ ...settings, partialTakeProfitRR: Number(event.target.value) || 1.2 })
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Session Filter</Label>
              <Button
                variant={settings.allowSessionFilter ? "default" : "outline"}
                onClick={() => setSettings({ ...settings, allowSessionFilter: !settings.allowSessionFilter })}
                className="w-full"
              >
                {settings.allowSessionFilter ? "Enabled" : "Disabled"}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Session Start UTC</Label>
              <Input
                type="number"
                value={settings.sessionStartHourUtc}
                min={0}
                max={23}
                step={1}
                onChange={(event) =>
                  setSettings({ ...settings, sessionStartHourUtc: Math.min(23, Math.max(0, Number(event.target.value) || 0)) })
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Session End UTC</Label>
              <Input
                type="number"
                value={settings.sessionEndHourUtc}
                min={0}
                max={23}
                step={1}
                onChange={(event) =>
                  setSettings({ ...settings, sessionEndHourUtc: Math.min(23, Math.max(0, Number(event.target.value) || 0)) })
                }
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Trend Trades</Label>
              <Button
                variant={settings.allowTrendTrades ? "default" : "outline"}
                onClick={() => setSettings({ ...settings, allowTrendTrades: !settings.allowTrendTrades })}
                className="w-full"
              >
                {settings.allowTrendTrades ? "Enabled" : "Disabled"}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Mean Reversion</Label>
              <Button
                variant={settings.allowMeanReversionTrades ? "default" : "outline"}
                onClick={() =>
                  setSettings({ ...settings, allowMeanReversionTrades: !settings.allowMeanReversionTrades })
                }
                className="w-full"
              >
                {settings.allowMeanReversionTrades ? "Enabled" : "Disabled"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="flex-1" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />
              Upload CSV
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => {
              setCandles(generateSampleCandles());
              setDataLabel("Synthetic sample · 3000 candles");
              setResult(null);
              setError(null);
            }}>
              Load Synthetic Sample
            </Button>
            <Button onClick={handleRun} disabled={loading} className="flex-1">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run Backtest
            </Button>
          </div>

          {error && <p className="text-sm text-loss">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: "Total P&L", value: `$${result.totalPnl.toFixed(2)}`, positive: result.totalPnl >= 0 },
              { label: "Trades", value: String(result.trades), positive: result.trades > 0 },
              { label: "Win Rate", value: `${result.winRate.toFixed(1)}%`, positive: result.winRate >= 45 },
              { label: "Max Drawdown", value: `${result.maxDrawdown.toFixed(2)}%`, positive: result.maxDrawdown < 15 },
              { label: "Sharpe", value: result.sharpe.toFixed(2), positive: result.sharpe > 0.8 },
            ].map((stat) => (
              <div key={stat.label} className="glass-card rounded-xl p-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                <p className={`text-xl font-bold font-mono ${stat.positive ? "text-profit" : "text-loss"}`}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {[
              { label: "Sortino", value: result.sortino.toFixed(2), positive: result.sortino > 1 },
              { label: "Calmar", value: result.calmar.toFixed(2), positive: result.calmar > 0.5 },
              { label: "Profit Factor", value: result.profitFactor.toFixed(2), positive: result.profitFactor > 1.2 },
              { label: "Expectancy", value: `$${result.expectancy.toFixed(2)}`, positive: result.expectancy > 0 },
              { label: "Payoff Ratio", value: result.payoffRatio.toFixed(2), positive: result.payoffRatio > 1 },
              { label: "Fees Paid", value: `$${result.feesPaid.toFixed(2)}`, positive: result.totalPnl > result.feesPaid * -1 },
            ].map((stat) => (
              <div key={stat.label} className="glass-card rounded-xl p-4">
                <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{stat.label}</p>
                <p className={`text-xl font-bold font-mono ${stat.positive ? "text-profit" : "text-loss"}`}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          <Card className="glass-card border-border">
            <CardContent className="pt-6">
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={result.equity}>
                    <defs>
                      <linearGradient id="btGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(28, 96%, 56%)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="hsl(28, 96%, 56%)" stopOpacity={0} />
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
                    <Area type="monotone" dataKey="equity" stroke="hsl(28, 96%, 56%)" fill="url(#btGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-card border-border">
            <CardHeader>
              <CardTitle className="text-lg">Recent Simulated Trades</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.tradesLog.slice(-12).reverse().map((trade, index) => (
                <div key={`${trade.entryTime}-${index}`} className="rounded-lg bg-secondary/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-mono font-medium">
                        {trade.side.toUpperCase()} · {trade.setupType.replace("_", " ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Entry ${trade.entryPrice.toFixed(2)} · Exit ${trade.exitPrice.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {trade.exitReason.replace("_", " ")} · {trade.barsHeld} bars · MFE ${trade.maxFavorableExcursion.toFixed(2)} ·
                        MAE ${trade.maxAdverseExcursion.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-mono font-bold ${trade.pnl >= 0 ? "text-profit" : "text-loss"}`}>
                        {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">Confidence {trade.confidence.toFixed(0)}%</p>
                      <p className="text-xs text-muted-foreground">
                        Gross ${trade.grossPnl.toFixed(2)} · Fees ${trade.feesPaid.toFixed(2)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
              {result.tradesLog.length === 0 && (
                <p className="text-sm text-muted-foreground">No trades were triggered for this dataset and parameter set.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
