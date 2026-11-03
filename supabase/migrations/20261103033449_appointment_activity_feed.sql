create table private.appointment_activity (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id),
  patient_id uuid not null references public.patients(id),
  kind text not null check(kind in ('booked','rescheduled','cancelled','restored')),
  occurred_at timestamptz not null default clock_timestamp(),
  starts_at timestamptz,
  therapist_id uuid references public.therapists(id),
  previous_starts_at timestamptz,
  previous_therapist_id uuid references public.therapists(id),
  source_audit_id bigint unique references private.audit_events(id)
);
create index appointment_activity_appointment_idx on private.appointment_activity(appointment_id);
create index appointment_activity_patient_idx on private.appointment_activity(patient_id);
create index appointment_activity_therapist_idx on private.appointment_activity(therapist_id);
create index appointment_activity_previous_therapist_idx on private.appointment_activity(previous_therapist_id);
create table private.appointment_activity_reads (
  reader_id text not null,
  activity_id bigint not null references private.appointment_activity(id) on delete cascade,
  primary key(reader_id,activity_id)
);
create index appointment_activity_reads_activity_idx on private.appointment_activity_reads(activity_id);
do $$ declare relation_name text; begin
  foreach relation_name in array array['appointment_activity','appointment_activity_reads'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update,delete on private.%I to nexo_backend,service_role',relation_name);
    execute format('create policy backend_access on private.%I for all to nexo_backend using (true) with check (true)',relation_name);
  end loop;
end $$;
grant usage,select on sequence private.appointment_activity_id_seq to nexo_backend,service_role;

-- Historical audit records have no old slot snapshot: retain their event time, never invent details.
insert into private.appointment_activity(appointment_id,patient_id,kind,occurred_at,source_audit_id)
  select a.id,a.patient_id,case e.action when 'appointment_booked' then 'booked' when 'appointment_rescheduled' then 'rescheduled'
    when 'appointment_cancelled' then 'cancelled' else 'restored' end,e.created_at,e.id
  from (select * from private.audit_events where action in ('appointment_booked','appointment_rescheduled','appointment_cancelled','appointment_restored') order by id desc limit 30) e
  join public.appointments a on a.id=e.entity_id order by e.id;
-- Existing staff can see history without receiving a badge for old events on first deployment.
insert into private.appointment_activity_reads(reader_id,activity_id)
  select readers.reader_id,e.id from (select user_id::text as reader_id from public.staff_members union select 'local') readers
  cross join private.appointment_activity e;

create function private.record_appointment_activity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare event_kind text; old_start timestamptz; old_therapist uuid;
begin
  if TG_OP='INSERT' then
    if new.status<>'confirmed' then return new; end if;
    event_kind='booked';
  elsif old.status='confirmed' and new.status='cancelled' then event_kind='cancelled';
  elsif old.status='cancelled' and new.status='confirmed' then event_kind='restored';
  elsif old.status='confirmed' and new.status='confirmed' and
    (old.starts_at,old.ends_at,old.therapist_id) is distinct from (new.starts_at,new.ends_at,new.therapist_id) then
    event_kind='rescheduled';old_start=old.starts_at;old_therapist=old.therapist_id;
  else return new;
  end if;
  insert into private.appointment_activity(appointment_id,patient_id,kind,starts_at,therapist_id,previous_starts_at,previous_therapist_id)
    values (new.id,new.patient_id,event_kind,new.starts_at,new.therapist_id,old_start,old_therapist);
  return new;
end $$;
revoke all on function private.record_appointment_activity() from public,anon,authenticated;
grant execute on function private.record_appointment_activity() to nexo_backend,service_role;
create trigger record_appointment_activity after insert or update of status,starts_at,ends_at,therapist_id on public.appointments
  for each row execute function private.record_appointment_activity();
