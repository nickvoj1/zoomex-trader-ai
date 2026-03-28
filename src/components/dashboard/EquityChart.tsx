import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface EquityChartProps {
  data: { time: string; equity: number }[];
}

export function EquityChart({ data }: EquityChartProps) {
  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Equity Curve
      </h3>
      <div className="h-[250px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(152, 100%, 45%)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(152, 100%, 45%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 15%)" />
            <XAxis dataKey="time" tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 11 }} />
            <YAxis tick={{ fill: "hsl(215, 15%, 55%)", fontSize: 11 }} />
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
              fill="url(#equityGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
