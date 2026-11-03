alter table public.appointments add column version integer not null default 0;
create table private.appointment_changes (
  appointment_id uuid not null references public.appointments(id),
  request_key text not null check(length(request_key) between 8 and 128),
  expected_version integer not null,
  target_slot_id uuid not null references public.slots(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(appointment_id,request_key)
);
create index appointment_changes_target_idx on private.appointment_changes(target_slot_id);
create table private.conversation_reads (
  reader_id text not null check(length(reader_id) between 1 and 80),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  last_sequence bigint not null,
  primary key(reader_id,conversation_id)
);
create index conversation_reads_conversation_idx on private.conversation_reads(conversation_id);
do $$ declare relation_name text; begin
  foreach relation_name in array array['appointment_changes','conversation_reads'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update,delete on private.%I to nexo_backend',relation_name);
    execute format('create policy backend_access on private.%I for all to nexo_backend using (true) with check (true)',relation_name);
  end loop;
end $$;
alter table private.audit_events drop constraint audit_events_action_check;
alter table private.audit_events add constraint audit_events_action_check check(action in (
  'appointment_booked','handoff_opened','conversation_control_changed','staff_replied','patient_details_updated',
  'appointment_cancelled','appointment_restored','conversation_archived','conversation_restored','appointment_rescheduled'
));
