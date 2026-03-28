import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { Tables } from "@/integrations/supabase/types";

type Trade = Tables<"trades">;

interface TradeHistoryTableProps {
  trades: Trade[];
}

export function TradeHistoryTable({ trades }: TradeHistoryTableProps) {
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Trade History
        </h3>
        <Badge variant="outline" className="text-xs">
          {trades.length} total
        </Badge>
      </div>

      <ScrollArea className="h-[320px]">
        {trades.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No trades recorded yet</p>
        ) : (
          <div className="space-y-2">
            {trades.map((trade) => {
              const pnl = Number(trade.pnl ?? 0);
              const isClosed = trade.status === "closed";

              return (
                <div key={trade.id} className="rounded-lg bg-secondary/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={trade.side === "buy" ? "default" : "destructive"}
                          className="text-[10px] font-bold uppercase"
                        >
                          {trade.side}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {trade.status}
                        </Badge>
                        {trade.setup_type && (
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {trade.setup_type.replace("_", " ")}
                          </Badge>
                        )}
                        <span className="text-xs font-mono text-muted-foreground">{trade.symbol}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Opened {new Date(trade.created_at).toLocaleString()}
                      </p>
                      {trade.closed_at && (
                        <p className="text-xs text-muted-foreground">
                          Closed {new Date(trade.closed_at).toLocaleString()}
                        </p>
                      )}
                    </div>

                    <div className="text-right">
                      <p className="text-xs font-mono text-muted-foreground">
                        {trade.size.toFixed(4)} BTC · {trade.leverage}x
                      </p>
                      <p className="text-xs font-mono text-muted-foreground">
                        Entry ${Number(trade.entry_price).toLocaleString()}
                      </p>
                      <p className="text-xs font-mono text-muted-foreground">
                        Exit {trade.exit_price !== null ? `$${Number(trade.exit_price).toLocaleString()}` : "Open"}
                      </p>
                      {trade.entry_confidence !== null && (
                        <p className="text-xs font-mono text-muted-foreground">
                          Confidence {Number(trade.entry_confidence).toFixed(0)}%
                        </p>
                      )}
                      <p
                        className={`text-sm font-mono font-bold ${
                          !isClosed ? "text-muted-foreground" : pnl >= 0 ? "text-profit" : "text-loss"
                        }`}
                      >
                        {!isClosed ? "Pending" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                      </p>
                    </div>
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
