import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface CandleData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  rsi: number;
}

interface PriceChartProps {
  data: CandleData[];
}

export function PriceChart({ data }: PriceChartProps) {
  const chartData = data.map((d) => ({
    ...d,
    body: [Math.min(d.open, d.close), Math.max(d.open, d.close)],
    color: d.close >= d.open ? "hsl(28, 96%, 56%)" : "hsl(0, 84%, 60%)",
    change: d.close - d.open,
  }));

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          BTCUSDT · 1m
        </h3>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-accent" /> RSI(14)
          </span>
        </div>
      </div>
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 15%)" />
            <XAxis dataKey="time" tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 10 }} />
            <YAxis
              yAxisId="price"
              domain={["auto", "auto"]}
              tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 10 }}
            />
            <YAxis
              yAxisId="rsi"
              orientation="right"
              domain={[0, 100]}
              tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 10 }}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(220, 18%, 10%)",
                border: "1px solid hsl(220, 14%, 22%)",
                borderRadius: "8px",
                color: "hsl(210, 20%, 92%)",
                fontSize: 12,
              }}
            />
            <Bar yAxisId="price" dataKey="close" fill="hsl(28, 96%, 56%)" opacity={0.3} barSize={4} />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="close"
              stroke="hsl(210, 20%, 92%)"
              strokeWidth={1.5}
              dot={false}
            />
            <Line
              yAxisId="rsi"
              type="monotone"
              dataKey="rsi"
              stroke="hsl(199, 89%, 48%)"
              strokeWidth={1.5}
              dot={false}
              strokeDasharray="4 2"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
