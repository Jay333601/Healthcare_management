-- DANGER: deletes all CareDesk tables, data and functions. Then re-run schema.sql (and seed.sql).
-- Your Supabase logins (Authentication -> Users) are not touched.
drop view if exists public.public_events;
drop table if exists public.messages, public.registrations, public.events, public.appointments,
                     public.patients, public.doctors, public.staff cascade;
drop function if exists public.get_slots(bigint, date), public.register_for_event(bigint, text, text, text),
  public.request_appointment(bigint, date, text, text, text), public.cancel_registration(bigint),
  public.confirm_appointment(bigint), public.notify_event(bigint, text), public.check_event_clash(),
  public.is_staff(), public.clinic_slots(), public.hospital_today();
