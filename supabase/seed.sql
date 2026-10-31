-- Deterministic synthetic fixtures. No real contact details, no emails are sent.
insert into public.clinics(singleton, name, time_zone)
values (true, 'Clínica Demo', 'America/New_York');
insert into public.therapists(id, name, specialty) values
 ('10000000-0000-4000-8000-000000000001', 'Alex Demo', 'Terapia física'),
 ('10000000-0000-4000-8000-000000000002', 'Sam Demo', 'Rehabilitación');
insert into public.patients(id, name, email,name_collected,phone) values
 ('20000000-0000-4000-8000-000000000001', 'Paciente Demo A', 'patient-a@example.invalid',true,'2025550101'),
 ('20000000-0000-4000-8000-000000000002', 'Paciente Demo B', 'patient-b@example.invalid',true,'2025550102');
insert into public.patient_identities(id, patient_id, channel, external_user_id) values
 ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'telegram', 'synthetic-a'),
 ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'telegram', 'synthetic-b');
insert into public.conversations(id, identity_id) values
 ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
 ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002');
insert into public.availability_rules(therapist_id, weekday, start_minute, end_minute, session_minutes, buffer_minutes)
select id, day, 540, 1020, 45, 15 from public.therapists cross join generate_series(1, 5) day;
insert into public.availability_breaks(rule_id, start_minute, end_minute)
select id, 720, 780 from public.availability_rules;
