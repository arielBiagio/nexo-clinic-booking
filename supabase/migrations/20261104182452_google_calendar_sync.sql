create table private.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null references public.therapists(id),
  staff_user_id uuid not null references auth.users(id) on delete cascade,
  google_sub text not null,
  email text not null,
  calendar_id text,
  encrypted_tokens text,
  status text not null check(status in ('connected','reauth_required','disconnected')),
  generation uuid not null default gen_random_uuid(),
  last_synced_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique(therapist_id,google_sub)
);
create unique index google_calendar_one_active_therapist on private.google_calendar_connections(therapist_id) where status<>'disconnected';
create unique index google_calendar_one_active_account on private.google_calendar_connections(google_sub) where status<>'disconnected';
create table private.google_calendar_oauth (
  state_hash text primary key,
  browser_hash text not null,
  session_hash text not null references private.staff_sessions(id_hash) on delete cascade,
  staff_user_id uuid not null references auth.users(id) on delete cascade,
  therapist_id uuid not null references public.therapists(id),
  encrypted_verifier text not null,
  expires_at timestamptz not null default now()+interval '10 minutes'
);
create index google_calendar_oauth_expiry on private.google_calendar_oauth(expires_at);
create table private.google_calendar_jobs (
  connection_id uuid not null references private.google_calendar_connections(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id),
  revision bigint not null default 1,
  synced_revision bigint not null default 0,
  epoch integer not null default 0,
  remote_event_id text,
  status text not null default 'pending' check(status in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  error_code text,
  primary key(connection_id,appointment_id)
);
create index google_calendar_jobs_available on private.google_calendar_jobs(available_at) where status in ('pending','processing');
do $$ declare relation_name text; begin
  foreach relation_name in array array['google_calendar_connections','google_calendar_oauth','google_calendar_jobs'] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update,delete on private.%I to nexo_backend,service_role',relation_name);
    execute format('create policy backend_access on private.%I for all to nexo_backend using (true) with check (true)',relation_name);
  end loop;
end $$;

-- Independent of legacy delivery_jobs: calendar delays never lock patient actions.
create function private.enqueue_google_calendar(p_appointment uuid,p_old_therapist uuid,p_restored boolean)
returns void language sql security invoker set search_path='' as $$
  insert into private.google_calendar_jobs(connection_id,appointment_id)
  select c.id,a.id from public.appointments a
  join private.google_calendar_connections c on c.status<>'disconnected' and
    (c.therapist_id=a.therapist_id or c.therapist_id=p_old_therapist or
      exists(select 1 from private.google_calendar_jobs j where j.connection_id=c.id and j.appointment_id=a.id))
  where a.id=p_appointment
  on conflict(connection_id,appointment_id) do update set
    revision=private.google_calendar_jobs.revision+1,
    epoch=private.google_calendar_jobs.epoch+case when p_restored then 1 else 0 end,
    status=case when private.google_calendar_jobs.lease_until>clock_timestamp() then 'processing' else 'pending' end,
    attempts=0,available_at=clock_timestamp(),error_code=null;
$$;
create function private.google_calendar_appointment_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='INSERT' then
    perform private.enqueue_google_calendar(new.id,null,false);
  else
    perform private.enqueue_google_calendar(new.id,old.therapist_id,old.status='cancelled' and new.status='confirmed');
  end if;
  return new;
end $$;
create trigger google_calendar_appointment_changed after insert or update of status,starts_at,ends_at,therapist_id,patient_id
on public.appointments for each row execute function private.google_calendar_appointment_changed();
create function private.google_calendar_patient_changed() returns trigger
language plpgsql security invoker set search_path='' as $$
declare appointment record;
begin
  if old.name is distinct from new.name then
    for appointment in select id from public.appointments where patient_id=new.id and status='confirmed' and starts_at>now() loop
      perform private.enqueue_google_calendar(appointment.id,null,false);
    end loop;
  end if;
  return new;
end $$;
create trigger google_calendar_patient_changed after update of name on public.patients
for each row execute function private.google_calendar_patient_changed();
revoke all on function private.enqueue_google_calendar(uuid,uuid,boolean),private.google_calendar_appointment_changed(),private.google_calendar_patient_changed() from public,anon,authenticated;
grant execute on function private.enqueue_google_calendar(uuid,uuid,boolean),private.google_calendar_appointment_changed(),private.google_calendar_patient_changed() to nexo_backend,service_role;
