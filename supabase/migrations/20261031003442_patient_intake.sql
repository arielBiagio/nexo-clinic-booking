-- Contact intake is separate from a verified clinical record. Existing demo
-- placeholders remain incomplete until explicitly provided by a patient/operator.
alter table public.patients
  add column name_collected boolean not null default false,
  add column phone text check (phone ~ '^\+?[0-9]{7,15}$'),
  add column insurance text check (length(insurance) between 1 and 120),
  add column reported_reason text check (length(reported_reason) between 1 and 400),
  add column additional_info text check (length(additional_info) between 1 and 600),
  add column intake_summary text not null default '',
  add column details_updated_at timestamptz;
alter table public.patients add constraint collected_name_valid
  check (not name_collected or length(trim(name)) between 2 and 70);
alter table private.audit_events drop constraint audit_events_action_check;
alter table private.audit_events add constraint audit_events_action_check
  check (action in ('appointment_booked','handoff_opened','conversation_control_changed','staff_replied','patient_details_updated'));

-- Also protects direct service-role booking calls; the existing booking
-- transaction rolls back appointment, jobs and audit together when incomplete.
create function private.require_patient_contact() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_patient public.patients;
begin
  if new.status = 'confirmed' then
    select * into v_patient from public.patients where id = new.patient_id for share;
    if not found or not v_patient.name_collected or v_patient.phone is null then
      raise exception 'PATIENT_DETAILS_REQUIRED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.require_patient_contact() from public, anon, authenticated;
grant execute on function private.require_patient_contact() to service_role;
create trigger appointment_requires_patient_contact before insert or update of patient_id,status on public.appointments
for each row execute function private.require_patient_contact();
-- Existing operator-only RLS policies continue to protect all added columns.
