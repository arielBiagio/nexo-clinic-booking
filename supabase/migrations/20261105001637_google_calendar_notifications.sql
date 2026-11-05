-- Keep the therapist's copy current when contact or patient-provided details change.
-- Existing permissions and SECURITY INVOKER are preserved; no patient data is backfilled here.
create or replace function private.google_calendar_patient_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
declare appointment record;
begin
  if row(old.name,old.phone,old.insurance,old.reported_reason,old.additional_info)
     is distinct from row(new.name,new.phone,new.insurance,new.reported_reason,new.additional_info) then
    for appointment in select id from public.appointments where patient_id=new.id and status='confirmed' and starts_at>now() loop
      perform private.enqueue_google_calendar(appointment.id,null,false);
    end loop;
  end if;
  return new;
end $$;

create or replace trigger google_calendar_patient_changed after update of name,phone,insurance,reported_reason,additional_info on public.patients
for each row execute function private.google_calendar_patient_changed();
