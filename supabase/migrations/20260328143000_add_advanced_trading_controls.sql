ALTER TABLE public.profiles
ADD COLUMN min_confidence NUMERIC NOT NULL DEFAULT 78,
ADD COLUMN daily_loss_limit_pct NUMERIC NOT NULL DEFAULT 3,
ADD COLUMN max_consecutive_losses INTEGER NOT NULL DEFAULT 3,
ADD COLUMN allow_trend_trades BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN allow_mean_reversion_trades BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.trades
ADD COLUMN setup_type TEXT,
ADD COLUMN entry_confidence NUMERIC,
ADD COLUMN trade_metadata JSONB;
