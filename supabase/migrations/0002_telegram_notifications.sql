create type public.notification_status as enum ('PENDING', 'DELIVERED', 'FAILED');

create table public.telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  signal_id uuid references public.signals(id),
  chat_id text not null,
  status public.notification_status not null default 'PENDING',
  telegram_message_id bigint,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);

create index telegram_notifications_retry_idx
  on public.telegram_notifications(status, updated_at)
  where status = 'FAILED';

alter table public.telegram_notifications enable row level security;
