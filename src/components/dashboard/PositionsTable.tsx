import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Tables } from "@/integrations/supabase/types";

type Trade = Tables<"trades">;

interface PositionsTableProps {
  trades: Trade[];
  onClose?: (id: string) => void;
}

export function PositionsTable({ trades, onClose }: PositionsTableProps) {
  const openTrades = trades.filter((t) => t.status === "open");

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Active Positions
        </h3>
        <Badge variant="outline" className="text-xs">
          {openTrades.length} open
        </Badge>
      </div>
      <ScrollArea className="h-[240px]">
        {openTrades.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No open positions</p>
        ) : (
          <div className="space-y-2">
            {openTrades.map((trade) => {
              const hasRealizedPnl = trade.pnl !== null;
              const pnl = trade.pnl ?? 0;
              return (
                <div
                  key={trade.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-secondary/50"
                >
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={trade.side === "buy" ? "default" : "destructive"}
                      className="text-[10px] uppercase font-bold"
                    >
                      {trade.side}
                    </Badge>
                    <div>
                      <p className="text-sm font-mono font-medium">{trade.symbol}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {trade.size} BTC · {trade.leverage}x
                      </p>
                      {trade.setup_type && (
                        <p className="text-[10px] uppercase text-muted-foreground">
                          {trade.setup_type.replace("_", " ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground font-mono">
                        Entry: ${trade.entry_price?.toLocaleString()}
                      </p>
                      <p
                        className={`text-sm font-mono font-bold ${
                          !hasRealizedPnl ? "text-muted-foreground" : pnl >= 0 ? "text-profit" : "text-loss"
                        }`}
                      >
                        {!hasRealizedPnl ? "Open" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                      </p>
                    </div>
                    {onClose && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => onClose(trade.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
