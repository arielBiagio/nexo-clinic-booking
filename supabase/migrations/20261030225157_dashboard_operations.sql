-- Structured audit only. Conversation bodies stay out of the database in the local demo.
alter table private.audit_events drop constraint audit_events_action_check;
alter table private.audit_events add constraint audit_events_action_check
  check (action in ('appointment_booked','handoff_opened','conversation_control_changed','staff_replied'));
