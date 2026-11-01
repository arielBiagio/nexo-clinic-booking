-- Staff authentication state stays server-side; browser sessions contain only an opaque ID.
alter table public.staff_members add column display_name text not null default 'Personal';
alter table public.staff_members add column email text;
alter table public.staff_members add column active boolean not null default true;
alter table public.staff_members add column created_at timestamptz not null default now();

create table private.staff_sessions (
  id_hash text primary key check (length(id_hash)=64),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_tokens text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index staff_sessions_user_idx on private.staff_sessions(user_id);
create index staff_sessions_expiry_idx on private.staff_sessions(expires_at);
alter table private.staff_sessions enable row level security;
revoke all on private.staff_sessions from public, anon, authenticated;
grant all on private.staff_sessions to service_role;

create table private.staff_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  subject_id uuid not null references auth.users(id),
  action text not null check (action in ('admin_bootstrapped','staff_created','staff_updated')),
  created_at timestamptz not null default now()
);
alter table private.staff_audit enable row level security;
revoke all on private.staff_audit from public, anon, authenticated;
grant all on private.staff_audit to service_role;
grant usage, select on sequence private.staff_audit_id_seq to service_role;

create or replace function private.is_operator() returns boolean
language sql stable security invoker set search_path='' as $$
  select exists (select 1 from public.staff_members
    where user_id=(select auth.uid()) and active and role in ('admin','reception'));
$$;
create function private.is_staff() returns boolean
language sql stable security invoker set search_path='' as $$
  select exists (select 1 from public.staff_members where user_id=(select auth.uid()) and active);
$$;
revoke all on function private.is_staff() from public, anon;
grant execute on function private.is_staff() to authenticated, service_role;
alter policy staff_self on public.staff_members using (user_id=(select auth.uid()) and active);
do $$
declare relation_name text;
begin
  foreach relation_name in array array['clinics','therapists','availability_rules','availability_breaks',
    'time_off','slots','appointments','patients','patient_identities','conversations','messages','handoffs'] loop
    execute format('create policy active_staff_only on public.%I as restrictive for select to authenticated using ((select private.is_staff()))',relation_name);
  end loop;
end $$;

-- Dedicated server login: no superuser, role management or RLS bypass attribute.
-- Password is provisioned separately and is never included in a migration or client bundle.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='nexo_backend') then
    create role nexo_backend nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema public,private,extensions to nexo_backend;
grant select,insert,update,delete on all tables in schema public,private to nexo_backend;
grant usage,select on all sequences in schema private to nexo_backend;
grant execute on function private.book_slot(uuid,uuid,text,boolean),private.escalate(uuid,text) to nexo_backend;
-- Only the trusted backend login uses these policies; API roles cannot assume it.
do $$
declare relation record;
begin
  for relation in select schemaname,tablename from pg_tables where schemaname in ('public','private') loop
    execute format('create policy backend_access on %I.%I for all to nexo_backend using (true) with check (true)',relation.schemaname,relation.tablename);
  end loop;
end $$;
