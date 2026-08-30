create extension if not exists pgcrypto;

create type public.signal_type as enum ('BUY', 'SELL', 'HOLD', 'WATCH', 'TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'SYSTEM');
create type public.signal_status as enum ('ACTIVE', 'HOLD', 'WATCH', 'TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'CLOSED', 'CANCELLED');
create type public.source_type as enum ('MANUAL_RESEARCH', 'ONCHAIN_RPC');
create type public.risk_level as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

create table public.tokens (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  address text not null,
  symbol text,
  name text,
  decimals integer,
  first_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (chain, address)
);

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  address text not null,
  label text,
  labels jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (chain, address)
);

create table public.research_snapshots (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  source public.source_type not null default 'MANUAL_RESEARCH',
  observed_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (token_id, observed_at)
);

create table public.manual_observations (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.research_snapshots(id),
  observed_at timestamptz not null,
  metric_name text not null,
  metric_value numeric,
  source public.source_type not null default 'MANUAL_RESEARCH',
  metadata jsonb not null default '{}'::jsonb
);

create table public.provider_requests (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  chain text not null,
  endpoint text not null,
  requested_at timestamptz not null default now(),
  status integer not null,
  source public.source_type not null default 'ONCHAIN_RPC',
  request_body jsonb not null default '{}'::jsonb,
  response_body jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create table public.onchain_observations (
  id uuid primary key default gen_random_uuid(),
  token_id uuid references public.tokens(id),
  chain text not null,
  provider text not null,
  source public.source_type not null default 'ONCHAIN_RPC',
  observed_at timestamptz not null,
  metric_name text not null,
  metric_value numeric,
  metadata jsonb not null default '{}'::jsonb
);

create table public.features (
  id uuid primary key default gen_random_uuid(),
  token_id uuid references public.tokens(id),
  wallet_id uuid references public.wallets(id),
  observed_at timestamptz not null,
  feature_name text not null,
  feature_value numeric,
  source public.source_type not null,
  definition text not null,
  version text not null,
  metadata jsonb not null default '{}'::jsonb,
  check (token_id is not null or wallet_id is not null)
);

create table public.accumulation_events (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  observed_at timestamptz not null,
  score numeric not null check (score between 0 and 100),
  evidence jsonb not null default '{}'::jsonb,
  feature_version text not null
);

create table public.distribution_events (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  observed_at timestamptz not null,
  score numeric not null check (score between 0 and 100),
  evidence jsonb not null default '{}'::jsonb,
  feature_version text not null
);

create table public.risk_assessments (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  observed_at timestamptz not null,
  score numeric not null check (score between 0 and 100),
  level public.risk_level not null,
  hard_reject boolean not null default false,
  factors jsonb not null default '[]'::jsonb,
  profile_version text not null
);

create table public.scoring_profiles (
  version text primary key,
  weights jsonb not null,
  thresholds jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.risk_profiles (
  version text primary key,
  thresholds jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  observed_at timestamptz not null,
  opportunity_score numeric not null check (opportunity_score between 0 and 100),
  wallet_quality_score numeric check (wallet_quality_score between 0 and 100),
  accumulation_score numeric check (accumulation_score between 0 and 100),
  distribution_score numeric check (distribution_score between 0 and 100),
  risk_score numeric check (risk_score between 0 and 100),
  market_structure_score numeric check (market_structure_score between 0 and 100),
  scoring_profile_version text not null references public.scoring_profiles(version),
  feature_version text not null,
  evidence jsonb not null default '{}'::jsonb,
  unique (token_id, observed_at)
);

create table public.signals (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id),
  opportunity_id uuid not null references public.opportunities(id),
  parent_signal_id uuid references public.signals(id),
  type public.signal_type not null,
  status public.signal_status not null default 'ACTIVE',
  generated_at timestamptz not null default now(),
  score numeric not null check (score between 0 and 100),
  reason text not null,
  configuration_versions jsonb not null,
  evidence jsonb not null default '{}'::jsonb
);

create table public.signal_lifecycle (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id),
  observed_at timestamptz not null,
  state text not null,
  opportunity_score numeric,
  accumulation_score numeric,
  distribution_score numeric,
  risk_score numeric,
  evidence jsonb not null default '{}'::jsonb
);

create table public.signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null unique references public.signals(id),
  measured_at timestamptz not null default now(),
  return_1h numeric,
  return_6h numeric,
  return_24h numeric,
  return_3d numeric,
  return_7d numeric,
  max_favorable_excursion numeric,
  max_adverse_excursion numeric,
  net_return_after_costs numeric,
  assumptions jsonb not null default '{}'::jsonb
);

create table public.feature_versions (
  version text primary key,
  definitions jsonb not null,
  created_at timestamptz not null default now()
);

create table public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  scoring_profile_version text not null references public.scoring_profiles(version),
  feature_version text not null,
  cost_assumptions jsonb not null,
  status text not null default 'PENDING'
);

create table public.backtest_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id),
  token_id uuid references public.tokens(id),
  signal_id uuid references public.signals(id),
  score_bucket text,
  metrics jsonb not null,
  created_at timestamptz not null default now()
);

create table public.system_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'RUNNING',
  records_processed integer not null default 0,
  error jsonb
);

create index research_snapshots_token_observed_idx on public.research_snapshots(token_id, observed_at desc);
create index onchain_observations_token_observed_idx on public.onchain_observations(token_id, observed_at desc);
create index features_token_observed_idx on public.features(token_id, observed_at desc);
create index signals_token_status_idx on public.signals(token_id, status);
create index provider_requests_chain_requested_idx on public.provider_requests(chain, requested_at desc);

alter table public.tokens enable row level security;
alter table public.wallets enable row level security;
alter table public.research_snapshots enable row level security;
alter table public.manual_observations enable row level security;
alter table public.provider_requests enable row level security;
alter table public.onchain_observations enable row level security;
alter table public.features enable row level security;
alter table public.accumulation_events enable row level security;
alter table public.distribution_events enable row level security;
alter table public.risk_assessments enable row level security;
alter table public.scoring_profiles enable row level security;
alter table public.risk_profiles enable row level security;
alter table public.opportunities enable row level security;
alter table public.signals enable row level security;
alter table public.signal_lifecycle enable row level security;
alter table public.signal_outcomes enable row level security;
alter table public.feature_versions enable row level security;
alter table public.backtest_runs enable row level security;
alter table public.backtest_results enable row level security;
alter table public.system_runs enable row level security;
