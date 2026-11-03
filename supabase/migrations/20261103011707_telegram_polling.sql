create table private.telegram_bots (
  bot_id bigint primary key,
  next_update_id bigint not null default 0,
  lease_owner uuid,
  lease_expires_at timestamptz
);
create table private.telegram_peers (
  bot_id bigint not null references private.telegram_bots(bot_id),
  user_id bigint not null,
  conversation_id uuid not null unique references public.conversations(id),
  created_at timestamptz not null default now(),
  primary key(bot_id,user_id)
);
create table private.telegram_outbox (
  id uuid primary key default gen_random_uuid(),
  bot_id bigint not null,
  user_id bigint not null,
  message_id uuid not null references public.messages(id),
  choices jsonb not null default '[]' check(jsonb_typeof(choices)='array'),
  status text not null default 'pending' check(status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  telegram_message_id bigint,
  last_error text,
  foreign key(bot_id,user_id) references private.telegram_peers(bot_id,user_id),
  unique(bot_id,message_id)
);
create index telegram_outbox_pending_idx on private.telegram_outbox(bot_id,next_attempt_at) where status in ('pending','sending');
create index telegram_outbox_message_idx on private.telegram_outbox(message_id);
do $$
declare relation_name text;
begin
  foreach relation_name in array array['telegram_bots','telegram_peers','telegram_outbox'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update,delete on private.%I to nexo_backend',relation_name);
    execute format('create policy backend_access on private.%I for all to nexo_backend using (true) with check (true)',relation_name);
  end loop;
end $$;
