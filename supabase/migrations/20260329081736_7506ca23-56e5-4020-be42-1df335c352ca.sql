create table if not exists public.orderbook_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  venue text not null,
  symbol text not null default 'BTCUSDT',
  depth_limit integer not null default 20,
  best_bid numeric,
  best_ask numeric,
  spread_bps numeric,
  imbalance numeric,
  bids jsonb not null default '[]'::jsonb,
  asks jsonb not null default '[]'::jsonb,
  exchange_timestamp timestamptz,
  latency_ms integer,
  raw_payload jsonb
);

create index if not exists orderbook_snapshots_symbol_created_at_idx
  on public.orderbook_snapshots (symbol, created_at desc);

create index if not exists orderbook_snapshots_venue_created_at_idx
  on public.orderbook_snapshots (venue, created_at desc);

alter table public.orderbook_snapshots enable row level security;

create policy "Authenticated users can read orderbook snapshots"
  on public.orderbook_snapshots
  for select
  to authenticated
  using (true);

create table if not exists public.trade_ticks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  venue text not null,
  symbol text not null default 'BTCUSDT',
  exchange_trade_id text,
  exchange_timestamp timestamptz,
  price numeric not null,
  size numeric not null,
  side text,
  notional_usd numeric,
  raw_payload jsonb,
  unique (venue, symbol, exchange_trade_id)
);

create index if not exists trade_ticks_symbol_created_at_idx
  on public.trade_ticks (symbol, created_at desc);

create index if not exists trade_ticks_venue_created_at_idx
  on public.trade_ticks (venue, created_at desc);

alter table public.trade_ticks enable row level security;

create policy "Authenticated users can read trade ticks"
  on public.trade_ticks
  for select
  to authenticated
  using (true);

create table if not exists public.forward_validation_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete cascade,
  symbol text not null default 'BTCUSDT',
  execution_mode text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  trade_count integer not null default 0,
  model_assisted_trade_count integer not null default 0,
  win_rate numeric not null default 0,
  expectancy_usd numeric not null default 0,
  profit_factor numeric not null default 0,
  total_net_pnl_usd numeric not null default 0,
  total_fees_usd numeric not null default 0,
  avg_net_edge_usd numeric not null default 0,
  avg_entry_slippage_bps numeric not null default 0,
  avg_exit_slippage_bps numeric not null default 0,
  avg_holding_minutes numeric not null default 0,
  max_drawdown_pct numeric not null default 0,
  gate_passed boolean not null default false,
  gate_reason text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists forward_validation_reports_user_mode_created_at_idx
  on public.forward_validation_reports (user_id, execution_mode, created_at desc);

create index if not exists forward_validation_reports_symbol_created_at_idx
  on public.forward_validation_reports (symbol, created_at desc);

alter table public.forward_validation_reports enable row level security;

create policy "Users can read own forward validation reports"
  on public.forward_validation_reports
  for select
  to authenticated
  using (user_id = auth.uid() or user_id is null);