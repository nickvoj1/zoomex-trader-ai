import { ArrowUpCircle, ArrowDownCircle, MinusCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Tables } from "@/integrations/supabase/types";

type Signal = Tables<"signals">;

interface SignalsFeedProps {
  signals: Signal[];
}

const signalConfig = {
  buy: { icon: ArrowUpCircle, colorClass: "text-profit", bgClass: "bg-profit/10", label: "BUY" },
  sell: { icon: ArrowDownCircle, colorClass: "text-loss", bgClass: "bg-loss/10", label: "SELL" },
  hold: { icon: MinusCircle, colorClass: "text-warning", bgClass: "bg-warning/10", label: "HOLD" },
};

export function SignalsFeed({ signals }: SignalsFeedProps) {
  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Live Signals
      </h3>
      <ScrollArea className="h-[320px]">
        <div className="space-y-3">
          {signals.map((sig) => {
            const config = signalConfig[sig.signal];
            const Icon = config.icon;
            return (
              <div
                key={sig.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50 animate-slide-in"
              >
                <div className={`p-1.5 rounded-lg ${config.bgClass}`}>
                  <Icon className={`h-4 w-4 ${config.colorClass}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-bold ${config.colorClass}`}>{config.label}</span>
                    <span className="text-xs text-muted-foreground font-mono">
                      RSI: {sig.rsi?.toFixed(1)}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      ${sig.price?.toLocaleString()}
                    </span>
                    {sig.confidence !== null && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {Number(sig.confidence).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  {sig.ai_reasoning && (
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                      {sig.ai_reasoning}
                    </p>
                  )}
                  {sig.decision_source && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mt-1 block">
                      {sig.decision_source}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60 mt-1 block">
                    {new Date(sig.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            );
          })}
          {signals.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No signals yet. Configure your API keys to start.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
