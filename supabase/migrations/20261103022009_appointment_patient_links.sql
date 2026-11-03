create table private.appointment_patient_links (
  appointment_id uuid not null references public.appointments(id),
  request_key text not null check(length(request_key) between 8 and 128),
  previous_patient_id uuid not null references public.patients(id),
  previous_conversation_id uuid not null references public.conversations(id),
  target_patient_id uuid not null references public.patients(id),
  target_conversation_id uuid not null references public.conversations(id),
  expected_version integer not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(appointment_id,request_key)
);
create index appointment_links_previous_patient_idx on private.appointment_patient_links(previous_patient_id);
create index appointment_links_previous_conversation_idx on private.appointment_patient_links(previous_conversation_id);
create index appointment_links_target_patient_idx on private.appointment_patient_links(target_patient_id);
create index appointment_links_target_conversation_idx on private.appointment_patient_links(target_conversation_id);
alter table private.appointment_patient_links enable row level security;
revoke all on private.appointment_patient_links from public,anon,authenticated;
grant select,insert,update,delete on private.appointment_patient_links to nexo_backend;
create policy backend_access on private.appointment_patient_links for all to nexo_backend using (true) with check (true);
alter table private.audit_events drop constraint audit_events_action_check;
alter table private.audit_events add constraint audit_events_action_check check(action in (
  'appointment_booked','handoff_opened','conversation_control_changed','staff_replied','patient_details_updated',
  'appointment_cancelled','appointment_restored','conversation_archived','conversation_restored','appointment_rescheduled','appointment_patient_linked'
));
