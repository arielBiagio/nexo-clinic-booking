-- Message bodies are retained for the staff inbox and the booking assistant's context.
-- Legacy metadata-only rows remain valid; no transcript can be reconstructed from them.
alter table public.messages
  add column body text,
  add column role text check (role in ('patient','assistant','staff')),
  add column sequence bigint generated always as identity,
  add constraint message_content_pair check ((body is null) = (role is null)),
  add constraint message_role_direction check (role is null or
    (role='patient' and direction='inbound') or (role in ('assistant','staff') and direction='outbound'));
create index messages_conversation_sequence_idx on public.messages(conversation_id,sequence);
grant usage,select on sequence public.messages_sequence_seq to nexo_backend;

-- Internal orchestration state and processed input IDs are never exposed via the Data API.
create table private.conversation_runtime (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state)='object'),
  updated_at timestamptz not null default now()
);
alter table private.conversation_runtime enable row level security;
revoke all on private.conversation_runtime from public,anon,authenticated;
grant select,insert,update,delete on private.conversation_runtime to nexo_backend;
create policy backend_access on private.conversation_runtime for all to nexo_backend using (true) with check (true);
