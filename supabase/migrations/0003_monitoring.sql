-- 0003_monitoring.sql
-- Monitoring phase: persistent watchlists, immutable market snapshots,
-- signal events, and triple-barrier episode outcomes.
-- Self-contained: does not reference tables from earlier migrations.

create table public.watchlist_tokens (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  token_address text not null,
  smart_money_wallets jsonb not null default '[]'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED')),
  current_state text not null default 'NEW',
  entry_price numeric,
  entry_at timestamptz,
  entry_snapshot_id uuid,
  last_observed_at timestamptz,
  last_score numeric check (last_score is null or (last_score between 0 and 100)),
  formula_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, token_address)
);

create table public.market_snapshots (
  id uuid primary key default gen_random_uuid(),
  watchlist_token_id uuid not null references public.watchlist_tokens(id) on delete cascade,
  chain text not null,
  token_address text not null,
  observed_at timestamptz not null,
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  features jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  formula_version text,
  formula_params jsonb,
  score numeric check (score is null or (score between 0 and 100)),
  evaluation_status text not null check (evaluation_status in ('SCORED', 'INCOMPLETE')),
  missing_inputs jsonb not null default '[]'::jsonb,
  gate_results jsonb not null default '[]'::jsonb,
  gate_version text,
  signal text not null,
  signal_changed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (watchlist_token_id, observed_at)
);

create table public.signal_events (
  id uuid primary key default gen_random_uuid(),
  watchlist_token_id uuid not null references public.watchlist_tokens(id) on delete cascade,
  snapshot_id uuid references public.market_snapshots(id) on delete set null,
  from_state text,
  to_state text not null,
  generated_at timestamptz not null default now(),
  score numeric,
  formula_version text,
  evidence jsonb not null default '{}'::jsonb
);

create table public.episode_outcomes (
  id uuid primary key default gen_random_uuid(),
  watchlist_token_id uuid not null references public.watchlist_tokens(id) on delete cascade,
  entry_snapshot_id uuid not null references public.market_snapshots(id) on delete cascade,
  params_version text not null,
  target_pct numeric not null,
  stop_pct numeric not null,
  horizon_hours numeric not null,
  entry_price numeric not null,
  entry_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'TARGET_HIT', 'STOP_HIT', 'TIMEOUT')),
  outcome_snapshot_id uuid references public.market_snapshots(id) on delete set null,
  resolved_at timestamptz,
  time_to_outcome_minutes numeric,
  mfe_pct numeric,
  mae_pct numeric,
  return_pct numeric,
  regime_at_signal jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Historical snapshots must never be overwritten (AGENTS.md Snapshot Model).
create or replace function public.prevent_market_snapshot_update()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception 'market_snapshots are immutable: historical snapshots must never be overwritten';
end;
$$;

create trigger market_snapshots_immutable
  before update on public.market_snapshots
  for each row execute function public.prevent_market_snapshot_update();

-- Entry reference links back to the snapshot that produced the BUY candidate.
alter table public.watchlist_tokens
  add constraint watchlist_tokens_entry_snapshot_fk
  foreign key (entry_snapshot_id) references public.market_snapshots(id) on delete set null;

create index market_snapshots_token_observed_idx on public.market_snapshots(watchlist_token_id, observed_at desc);
create index signal_events_token_generated_idx on public.signal_events(watchlist_token_id, generated_at desc);
create index episode_outcomes_token_status_idx on public.episode_outcomes(watchlist_token_id, status);
create index watchlist_tokens_status_idx on public.watchlist_tokens(status);

alter table public.watchlist_tokens enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.signal_events enable row level security;
alter table public.episode_outcomes enable row level security;
