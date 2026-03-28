import { Button } from "@/components/ui/button";
import { ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";

interface QuickTradeProps {
  onTrade: (side: "buy" | "sell") => void;
  disabled?: boolean;
}

export function QuickTrade({ onTrade, disabled }: QuickTradeProps) {
  const handleTrade = (side: "buy" | "sell") => {
    onTrade(side);
    toast.success(`Market ${side.toUpperCase()} 0.001 BTC submitted`, {
      description: `TP +0.3% / SL -0.15%`,
    });
  };

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Quick Trade
      </h3>
      <div className="space-y-3">
        <div className="text-center">
          <p className="text-xs text-muted-foreground mb-1">Market Order</p>
          <p className="text-lg font-mono font-bold">0.001 BTC</p>
          <p className="text-[10px] text-muted-foreground">TP: +0.3% · SL: -0.15%</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => handleTrade("buy")}
            disabled={disabled}
            className="bg-profit hover:bg-profit/90 text-primary-foreground font-bold"
          >
            <ArrowUp className="h-4 w-4 mr-1" />
            Long
          </Button>
          <Button
            onClick={() => handleTrade("sell")}
            disabled={disabled}
            variant="destructive"
            className="font-bold"
          >
            <ArrowDown className="h-4 w-4 mr-1" />
            Short
          </Button>
        </div>
        {disabled && (
          <p className="text-[10px] text-warning text-center">
            Configure API keys in Settings first
          </p>
        )}
      </div>
    </div>
  );
}
