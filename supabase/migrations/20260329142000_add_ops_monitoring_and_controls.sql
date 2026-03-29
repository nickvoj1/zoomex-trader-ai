create table if not exists public.ops_controls (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'global',
  symbol text not null default 'BTCUSDT',
  kill_switch boolean not null default false,
  pause_new_entries boolean not null default false,
  disable_live_entries_until timestamptz,
  max_market_snapshot_age_seconds integer not null default 180,
  max_archive_sample_age_seconds integer not null default 120,
  max_heartbeat_age_seconds integer not null default 180,
  max_cycle_latency_ms integer not null default 20000,
  notes text,
  updated_at timestamptz not null default now(),
  unique (scope, symbol)
);

insert into public.ops_controls (
  scope,
  symbol,
  kill_switch,
  pause_new_entries,
  max_market_snapshot_age_seconds,
  max_archive_sample_age_seconds,
  max_heartbeat_age_seconds,
  max_cycle_latency_ms,
  notes
)
values (
  'global',
  'BTCUSDT',
  false,
  false,
  180,
  120,
  180,
  20000,
  'Default ops controls for the BTCUSDT trading stack'
)
on conflict (scope, symbol) do nothing;

alter table public.ops_controls enable row level security;

create policy if not exists "Authenticated users can read ops controls"
  on public.ops_controls
  for select
  to authenticated
  using (true);

create table if not exists public.ops_heartbeats (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  service_name text not null,
  symbol text not null default 'BTCUSDT',
  status text not null,
  source_host text,
  process_id text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists ops_heartbeats_service_symbol_created_at_idx
  on public.ops_heartbeats (service_name, symbol, created_at desc);

alter table public.ops_heartbeats enable row level security;

create policy if not exists "Authenticated users can read ops heartbeats"
  on public.ops_heartbeats
  for select
  to authenticated
  using (true);

create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  service_name text not null,
  symbol text not null default 'BTCUSDT',
  severity text not null,
  alert_type text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  resolved boolean not null default false
);

create index if not exists ops_alerts_service_symbol_created_at_idx
  on public.ops_alerts (service_name, symbol, created_at desc);

create index if not exists ops_alerts_resolved_created_at_idx
  on public.ops_alerts (resolved, created_at desc);

alter table public.ops_alerts enable row level security;

create policy if not exists "Authenticated users can read ops alerts"
  on public.ops_alerts
  for select
  to authenticated
  using (true);
