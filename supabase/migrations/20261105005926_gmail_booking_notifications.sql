alter table private.google_calendar_connections
  add column gmail_send_enabled boolean not null default false,
  add column gmail_error_code text,
  add column gmail_last_sent_at timestamptz;

create table private.gmail_booking_notifications (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references private.google_calendar_connections(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id),
  booking_version integer not null,
  status text not null default 'pending' check(status in ('pending','processing','sending','sent','failed','unknown','cancelled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  error_code text,
  remote_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(connection_id,appointment_id,booking_version)
);
create index gmail_booking_notifications_available on private.gmail_booking_notifications(available_at) where status='pending';
alter table private.gmail_booking_notifications enable row level security;
revoke all on private.gmail_booking_notifications from public,anon,authenticated;
grant select,insert,update,delete on private.gmail_booking_notifications to nexo_backend,service_role;
create policy backend_access on private.gmail_booking_notifications for all to nexo_backend using(true) with check(true);

-- Only real booking transitions create mail. Calendar reconciliation and patient edits do not.
create function private.gmail_booking_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
declare new_booking boolean;
begin
  if TG_OP='INSERT' then
    new_booking=new.status='confirmed';
  else
    new_booking=new.status='confirmed' and (old.status<>'confirmed' or old.therapist_id is distinct from new.therapist_id);
    if new.status<>'confirmed' or old.therapist_id is distinct from new.therapist_id then
      update private.gmail_booking_notifications n set status='cancelled',lease_id=null,lease_until=null
      from private.google_calendar_connections c where n.connection_id=c.id and n.appointment_id=new.id
        and n.status in ('pending','processing') and (new.status<>'confirmed' or c.therapist_id<>new.therapist_id);
    end if;
  end if;
  if new_booking and new.starts_at>now() then
    insert into private.gmail_booking_notifications(connection_id,appointment_id,booking_version)
    select c.id,new.id,new.version from private.google_calendar_connections c
    join public.therapists t on t.id=c.therapist_id and t.staff_user_id=c.staff_user_id
    join public.staff_members s on s.user_id=c.staff_user_id and s.active and s.role='therapist'
    where c.therapist_id=new.therapist_id and c.status<>'disconnected'
    on conflict(connection_id,appointment_id,booking_version) do nothing;
  end if;
  return new;
end $$;
create trigger gmail_booking_changed after insert or update of status,therapist_id on public.appointments
for each row execute function private.gmail_booking_changed();
revoke all on function private.gmail_booking_changed() from public,anon,authenticated;
grant execute on function private.gmail_booking_changed() to nexo_backend,service_role;
