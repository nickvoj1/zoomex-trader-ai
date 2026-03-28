ALTER TABLE public.signals
ADD COLUMN confidence NUMERIC,
ADD COLUMN decision_source TEXT,
ADD COLUMN signal_context JSONB;
