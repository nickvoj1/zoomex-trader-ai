import { TrendingUp, TrendingDown, Activity, Target, Wallet } from "lucide-react";

interface StatsCardsProps {
  accountLabel: string;
  accountValue: string;
  accountDetail: string;
  accountPositive: boolean;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  maxDrawdown: number;
}

export function StatsCards({
  accountLabel,
  accountValue,
  accountDetail,
  accountPositive,
  totalPnl,
  winRate,
  totalTrades,
  maxDrawdown,
}: StatsCardsProps) {
  const stats = [
    {
      label: accountLabel,
      value: accountValue,
      detail: accountDetail,
      icon: Wallet,
      positive: accountPositive,
    },
    {
      label: "Total P&L",
      value: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      detail: "Closed trades only",
      icon: totalPnl >= 0 ? TrendingUp : TrendingDown,
      positive: totalPnl >= 0,
    },
    {
      label: "Win Rate",
      value: `${winRate.toFixed(1)}%`,
      detail: "Closed trade accuracy",
      icon: Target,
      positive: winRate >= 50,
    },
    {
      label: "Total Trades",
      value: totalTrades.toString(),
      detail: "Open and closed",
      icon: Activity,
      positive: true,
    },
    {
      label: "Max Drawdown",
      value: `${maxDrawdown.toFixed(2)}%`,
      detail: "Peak-to-trough",
      icon: TrendingDown,
      positive: maxDrawdown < 5,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={`glass-card rounded-xl p-4 ${stat.positive ? "glow-green" : "glow-red"}`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              {stat.label}
            </span>
            <stat.icon className={`h-4 w-4 ${stat.positive ? "text-profit" : "text-loss"}`} />
          </div>
          <p className={`text-2xl font-bold font-mono ${stat.positive ? "text-profit" : "text-loss"}`}>
            {stat.value}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground">{stat.detail}</p>
        </div>
      ))}
    </div>
  );
}
