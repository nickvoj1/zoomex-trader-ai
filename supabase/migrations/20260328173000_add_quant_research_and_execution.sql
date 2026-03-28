create table if not exists public.market_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  venue text not null,
  symbol text not null default 'BTCUSDT',
  snapshot_type text not null,
  mid_price numeric,
  mark_price numeric,
  spread_bps numeric,
  imbalance numeric,
  funding_rate_pct_8h numeric,
  open_interest_usd numeric,
  open_interest_change_pct numeric,
  long_short_ratio numeric,
  taker_imbalance numeric,
  liquidation_bias numeric,
  liquidation_intensity numeric,
  cross_venue_basis_bps numeric,
  latency_ms integer,
  raw_payload jsonb
);

create index if not exists market_snapshots_symbol_created_at_idx
  on public.market_snapshots (symbol, created_at desc);

alter table public.market_snapshots enable row level security;

create policy if not exists "Authenticated users can read market snapshots"
  on public.market_snapshots
  for select
  to authenticated
  using (true);

create table if not exists public.execution_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  venue text not null,
  symbol text not null default 'BTCUSDT',
  event_type text not null,
  status text not null,
  latency_ms integer,
  details jsonb
);

create index if not exists execution_events_user_created_at_idx
  on public.execution_events (user_id, created_at desc);

alter table public.execution_events enable row level security;

create policy if not exists "Users can read own execution events"
  on public.execution_events
  for select
  to authenticated
  using (user_id = auth.uid() or user_id is null);

create table if not exists public.position_reconciliations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null default 'BTCUSDT',
  status text not null,
  open_trade_count integer not null default 0,
  exchange_position_count integer not null default 0,
  notes text,
  trade_snapshot jsonb,
  exchange_snapshot jsonb
);

create index if not exists position_reconciliations_user_created_at_idx
  on public.position_reconciliations (user_id, created_at desc);

alter table public.position_reconciliations enable row level security;

create policy if not exists "Users can read own reconciliations"
  on public.position_reconciliations
  for select
  to authenticated
  using (user_id = auth.uid());

create table if not exists public.trade_tca (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trade_id uuid not null references public.trades(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null default 'BTCUSDT',
  estimated_fees_usd numeric,
  entry_slippage_bps numeric,
  exit_slippage_bps numeric,
  gross_edge_usd numeric,
  net_edge_usd numeric,
  holding_minutes numeric,
  metadata jsonb,
  unique (trade_id)
);

create index if not exists trade_tca_user_created_at_idx
  on public.trade_tca (user_id, created_at desc);

alter table public.trade_tca enable row level security;

create policy if not exists "Users can read own trade TCA"
  on public.trade_tca
  for select
  to authenticated
  using (user_id = auth.uid());

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  run_type text not null,
  symbol text not null default 'BTCUSDT',
  objective text,
  config jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  artifact_path text
);

create index if not exists research_runs_created_at_idx
  on public.research_runs (created_at desc);

alter table public.research_runs enable row level security;

create policy if not exists "Users can read own research runs"
  on public.research_runs
  for select
  to authenticated
  using (user_id = auth.uid() or user_id is null);

create table if not exists public.model_artifacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  model_name text not null,
  symbol text not null default 'BTCUSDT',
  side text not null,
  horizon_bars integer not null,
  move_threshold_pct numeric not null,
  metrics jsonb not null default '{}'::jsonb,
  artifact jsonb not null default '{}'::jsonb,
  source_run_id uuid references public.research_runs(id) on delete set null
);

create index if not exists model_artifacts_created_at_idx
  on public.model_artifacts (created_at desc);

alter table public.model_artifacts enable row level security;

create policy if not exists "Users can read own model artifacts"
  on public.model_artifacts
  for select
  to authenticated
  using (user_id = auth.uid() or user_id is null);
