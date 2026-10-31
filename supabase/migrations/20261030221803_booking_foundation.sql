-- Single-clinic, synthetic-data prototype. All writes to bookings go through the backend.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.clinics (
  singleton boolean primary key default true check (singleton),
  name text not null,
  time_zone text not null
);
create table public.staff_members (
  user_id uuid primary key references auth.users(id),
  role text not null check (role in ('admin', 'reception', 'therapist'))
);
create table public.therapists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  specialty text not null,
  staff_user_id uuid unique references auth.users(id)
);
create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references public.therapists(id),
  weekday smallint not null check (weekday between 1 and 7),
  start_minute smallint not null check (start_minute >= 0),
  end_minute smallint not null check (end_minute <= 1440 and end_minute > start_minute),
  session_minutes smallint not null check (session_minutes between 5 and 240),
  buffer_minutes smallint not null default 0 check (buffer_minutes between 0 and 120),
  exclude using gist (therapist_id extensions.gist_uuid_ops with =, weekday extensions.gist_int2_ops with =,
    int4range(start_minute, end_minute, '[)') with &&)
);
create table public.availability_breaks (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.availability_rules(id) on delete cascade,
  start_minute smallint not null check (start_minute >= 0),
  end_minute smallint not null check (end_minute <= 1440 and end_minute > start_minute)
);
create index availability_breaks_rule_idx on public.availability_breaks(rule_id);
create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references public.therapists(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at)
);
create index time_off_therapist_idx on public.time_off(therapist_id);
create table public.slots (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references public.therapists(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  busy_ends_at timestamptz not null check (busy_ends_at >= ends_at),
  active boolean not null default true,
  unique (therapist_id, starts_at)
);
create table public.patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  synthetic boolean not null default true check (synthetic)
);
create table public.patient_identities (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id),
  channel text not null check (channel in ('telegram')),
  external_user_id text not null,
  unique (channel, external_user_id)
);
create index patient_identities_patient_idx on public.patient_identities(patient_id);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.patient_identities(id),
  status text not null default 'active' check (status in ('active', 'handed_off', 'human_led', 'closed')),
  pending_slot_id uuid references public.slots(id),
  pending_expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index conversations_identity_idx on public.conversations(identity_id);
create index conversations_pending_idx on public.conversations(pending_slot_id);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  patient_id uuid not null references public.patients(id),
  therapist_id uuid not null references public.therapists(id),
  slot_id uuid not null references public.slots(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  busy_ends_at timestamptz not null check (busy_ends_at >= ends_at),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  request_key text not null check (length(request_key) between 8 and 128),
  created_at timestamptz not null default now(),
  unique (conversation_id, request_key),
  exclude using gist (therapist_id extensions.gist_uuid_ops with =,
    tstzrange(starts_at, busy_ends_at, '[)') with &&) where (status = 'confirmed')
);
create unique index appointments_confirmed_slot_idx on public.appointments(slot_id) where status = 'confirmed';
create index appointments_patient_idx on public.appointments(patient_id);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  external_message_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  created_at timestamptz not null default now(),
  unique (conversation_id, external_message_id, direction)
  -- Intentionally no raw body: retention/redaction must be decided before external input.
);
create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  reason text not null check (reason in ('requested_human', 'not_understood', 'clinical', 'billing', 'exception', 'tool_failure')),
  assigned_to uuid references auth.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index handoffs_one_open_idx on public.handoffs(conversation_id) where resolved_at is null;
create index handoffs_assigned_idx on public.handoffs(assigned_to);
create table private.delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id),
  handoff_id uuid references public.handoffs(id),
  destination text not null check (destination in ('email', 'calendar', 'staff')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((appointment_id is not null and handoff_id is null and destination in ('email', 'calendar')) or
    (handoff_id is not null and appointment_id is null and destination = 'staff')),
  unique (appointment_id, destination),
  unique (handoff_id, destination)
);
create index delivery_jobs_pending_idx on private.delivery_jobs(available_at) where status = 'pending';
create table private.audit_events (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id),
  action text not null check (action in ('appointment_booked', 'handoff_opened')),
  entity_id uuid not null,
  created_at timestamptz not null default now()
);
create index audit_events_conversation_idx on private.audit_events(conversation_id);

-- Invoker functions: no SECURITY DEFINER and no arbitrary anonymous RPC access.
create function private.is_operator() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.staff_members
    where user_id = (select auth.uid()) and role in ('admin', 'reception'));
$$;
revoke all on function private.is_operator() from public, anon;
grant execute on function private.is_operator() to authenticated, service_role;

alter table public.clinics enable row level security;
alter table public.staff_members enable row level security;
alter table public.therapists enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_breaks enable row level security;
alter table public.time_off enable row level security;
alter table public.slots enable row level security;
alter table public.patients enable row level security;
alter table public.patient_identities enable row level security;
alter table public.conversations enable row level security;
alter table public.appointments enable row level security;
alter table public.messages enable row level security;
alter table public.handoffs enable row level security;
alter table private.delivery_jobs enable row level security;
alter table private.audit_events enable row level security;

-- Remove Supabase's default public table grants; opt in to each allowed operation.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.staff_members, public.clinics, public.therapists,
  public.availability_rules, public.availability_breaks, public.time_off,
  public.slots, public.appointments, public.patients, public.patient_identities,
  public.conversations, public.messages, public.handoffs to authenticated;
-- Rule writes will go through backend transactions that also regenerate slots.
grant all on all tables in schema public, private to service_role;
grant usage, select on all sequences in schema private to service_role;

create policy staff_self on public.staff_members for select to authenticated using (user_id = (select auth.uid()));
create policy clinic_staff on public.clinics for select to authenticated
  using (exists (select 1 from public.staff_members where user_id = (select auth.uid())));
create policy therapists_visible on public.therapists for select to authenticated
  using ((select private.is_operator()) or staff_user_id = (select auth.uid()));
create policy rules_visible on public.availability_rules for select to authenticated
  using ((select private.is_operator()) or therapist_id in
    (select id from public.therapists where staff_user_id = (select auth.uid())));
create policy breaks_visible on public.availability_breaks for select to authenticated
  using (rule_id in (select id from public.availability_rules));
create policy time_off_visible on public.time_off for select to authenticated
  using ((select private.is_operator()) or therapist_id in
    (select id from public.therapists where staff_user_id = (select auth.uid())));
create policy slots_visible on public.slots for select to authenticated
  using ((select private.is_operator()) or therapist_id in
    (select id from public.therapists where staff_user_id = (select auth.uid())));
create policy appointments_visible on public.appointments for select to authenticated
  using ((select private.is_operator()) or therapist_id in
    (select id from public.therapists where staff_user_id = (select auth.uid())));
create policy patients_operator on public.patients for select to authenticated using ((select private.is_operator()));
create policy identities_operator on public.patient_identities for select to authenticated using ((select private.is_operator()));
create policy conversations_operator on public.conversations for select to authenticated using ((select private.is_operator()));
create policy messages_operator on public.messages for select to authenticated using ((select private.is_operator()));
create policy handoffs_operator on public.handoffs for select to authenticated using ((select private.is_operator()));

create function private.book_slot(p_conversation uuid, p_slot uuid, p_key text, p_confirmed boolean)
returns public.appointments language plpgsql security invoker set search_path = '' as $$
declare
  v_conversation public.conversations;
  v_slot public.slots;
  v_previous public.appointments;
  v_patient uuid;
begin
  if length(p_key) not between 8 and 128 or p_key is null then
    raise exception 'INVALID_REQUEST_KEY' using errcode = 'P0001';
  end if;
  select * into v_conversation from public.conversations where id = p_conversation for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into v_previous from public.appointments where conversation_id = p_conversation and request_key = p_key;
  if found then
    if v_previous.slot_id <> p_slot then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return v_previous;
  end if;
  if v_conversation.status <> 'active' then raise exception 'AGENT_PAUSED' using errcode = 'P0001'; end if;
  if p_confirmed is distinct from true or v_conversation.pending_slot_id is distinct from p_slot or
      v_conversation.pending_expires_at is null or v_conversation.pending_expires_at <= now() then
    raise exception 'CONFIRMATION_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_slot from public.slots where id = p_slot;
  if not found then raise exception 'SLOT_NOT_FOUND' using errcode = 'P0001'; end if;
  -- Regeneration and booking serialize by therapist. No external I/O under this lock.
  perform 1 from public.therapists where id = v_slot.therapist_id for update;
  select * into v_slot from public.slots where id = p_slot for update;
  if not v_slot.active or v_slot.starts_at <= now() or exists (
    select 1 from public.appointments where therapist_id = v_slot.therapist_id and status = 'confirmed'
      and tstzrange(starts_at, busy_ends_at, '[)') && tstzrange(v_slot.starts_at, v_slot.busy_ends_at, '[)')
  ) then raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001'; end if;
  select patient_id into v_patient from public.patient_identities where id = v_conversation.identity_id;
  insert into public.appointments(conversation_id, patient_id, therapist_id, slot_id, starts_at, ends_at, busy_ends_at, request_key)
    values (p_conversation, v_patient, v_slot.therapist_id, p_slot, v_slot.starts_at, v_slot.ends_at, v_slot.busy_ends_at, p_key)
    returning * into v_previous;
  insert into private.delivery_jobs(appointment_id, destination) values (v_previous.id, 'email'), (v_previous.id, 'calendar');
  insert into private.audit_events(conversation_id, action, entity_id) values (p_conversation, 'appointment_booked', v_previous.id);
  update public.conversations set pending_slot_id = null, pending_expires_at = null where id = p_conversation;
  return v_previous;
end;
$$;
revoke all on function private.book_slot(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function private.book_slot(uuid, uuid, text, boolean) to service_role;

create function private.escalate(p_conversation uuid, p_reason text)
returns public.handoffs language plpgsql security invoker set search_path = '' as $$
declare v_state text; v_handoff public.handoffs;
begin
  select status into v_state from public.conversations where id = p_conversation for update;
  if not found then raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into v_handoff from public.handoffs where conversation_id = p_conversation and resolved_at is null;
  if found then return v_handoff; end if;
  if v_state <> 'active' then raise exception 'AGENT_PAUSED' using errcode = 'P0001'; end if;
  insert into public.handoffs(conversation_id, reason) values (p_conversation, p_reason) returning * into v_handoff;
  update public.conversations set status = 'handed_off', pending_slot_id = null, pending_expires_at = null where id = p_conversation;
  insert into private.delivery_jobs(handoff_id, destination) values (v_handoff.id, 'staff');
  insert into private.audit_events(conversation_id, action, entity_id) values (p_conversation, 'handoff_opened', v_handoff.id);
  return v_handoff;
end;
$$;
revoke all on function private.escalate(uuid, text) from public, anon, authenticated;
grant execute on function private.escalate(uuid, text) to service_role;
