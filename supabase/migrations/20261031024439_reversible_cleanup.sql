-- Reversible operator cleanup. Keep patients, appointments and message metadata.
alter table public.conversations
  add column archived_at timestamptz,
  add column status_before_archive text check (status_before_archive in ('active','handed_off','human_led','closed')),
  add constraint conversation_archive_pair check ((archived_at is null) = (status_before_archive is null)),
  add constraint archived_conversation_closed check (archived_at is null or status='closed');
alter table private.delivery_jobs drop constraint delivery_jobs_status_check;
alter table private.delivery_jobs add constraint delivery_jobs_status_check
  check (status in ('pending','processing','sent','failed','cancelled'));
alter table private.audit_events drop constraint audit_events_action_check;
alter table private.audit_events add constraint audit_events_action_check check (action in (
  'appointment_booked','handoff_opened','conversation_control_changed','staff_replied','patient_details_updated',
  'appointment_cancelled','appointment_restored','conversation_archived','conversation_restored'
));
-- Existing RLS and grants remain in force. Cleanup is exposed only by the local operator API.
