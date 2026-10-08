-- =====================================================================
-- CareDesk – Supabase schema
-- Run this whole file once in: Supabase dashboard -> SQL Editor -> New query
-- Safe to re-run on an empty project. To start over, see "RESET" in the README.
-- =====================================================================

-- ---------- tables ----------
create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table public.doctors (
  id   bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 100),
  dept text not null check (char_length(dept) between 1 and 80)
);

create table public.patients (
  id        bigint generated always as identity primary key,
  name      text not null check (char_length(name) between 1 and 100),
  age       int  not null default 0 check (age between 0 and 120),   -- 0 = unknown (self-booked)
  phone     text not null check (char_length(phone) between 1 and 30),
  ward      text not null default 'Outpatient',
  status    text not null default 'Outpatient' check (status in ('Admitted', 'Outpatient')),
  doctor_id bigint references public.doctors(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.appointments (
  id         bigint generated always as identity primary key,
  patient_id bigint not null references public.patients(id) on delete cascade,
  doctor_id  bigint not null references public.doctors(id) on delete cascade,
  date       date not null,
  time       text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status     text not null default 'Confirmed' check (status in ('Requested', 'Confirmed')),
  created_at timestamptz not null default now(),
  unique (doctor_id, date, time)                                       -- no double-booking
);

create table public.events (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 150),
  date        date not null,
  start_time  text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time    text not null check (end_time   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  venue       text not null check (char_length(venue) between 1 and 100),
  capacity    int  not null check (capacity between 1 and 100000),
  description text not null default '' check (char_length(description) <= 500),
  check (end_time > start_time)
);

create table public.registrations (
  id         bigint generated always as identity primary key,
  event_id   bigint not null references public.events(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  email      text not null check (char_length(email) <= 120),
  dept       text not null check (char_length(dept) between 1 and 60),
  waitlisted boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index registrations_one_per_email on public.registrations (event_id, lower(email));

create table public.messages (
  id       bigint generated always as identity primary key,
  sent_at  timestamptz not null default now(),
  audience text not null check (char_length(audience) <= 150),
  body     text not null check (char_length(body) between 1 and 1000)
);

-- ---------- small helpers ----------
-- "today" in the hospital's timezone (change if you are not in India)
create function public.hospital_today() returns date
language sql stable set search_path = public as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- bookable clinic slots: 09:00-16:30 every 30 min, lunch break 13:00-14:00
create function public.clinic_slots() returns text[]
language sql immutable set search_path = public as $$
  select array(
    select to_char(t, 'HH24:MI')
    from generate_series(timestamp '2000-01-01 09:00', timestamp '2000-01-01 16:30', interval '30 minutes') t
    where to_char(t, 'HH24:MI') not in ('13:00', '13:30')
    order by t)
$$;

-- is the signed-in user a staff member?
create function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid())
$$;

-- ---------- event venue clash check ----------
create function public.check_event_clash() returns trigger
language plpgsql set search_path = public as $$
declare c public.events;
begin
  perform pg_advisory_xact_lock(hashtext(new.venue || new.date::text));   -- stops two clashing inserts racing
  select * into c from public.events
   where date = new.date and venue = new.venue and id is distinct from new.id
     and new.start_time < end_time and new.end_time > start_time
   limit 1;
  if found then
    raise exception 'Clash: % is booked for "%" (%–%).', c.venue, c.title, c.start_time, c.end_time;
  end if;
  if tg_op = 'INSERT' and new.date < public.hospital_today() then
    raise exception 'Event date cannot be in the past.';
  end if;
  return new;
end $$;
create trigger events_clash before insert or update on public.events
  for each row execute function public.check_event_clash();

-- ---------- public view: events with seat counts (no personal data) ----------
create view public.public_events with (security_invoker = false) as
select e.*,
  (select count(*) from public.registrations r where r.event_id = e.id and not r.waitlisted)::int as confirmed,
  (select count(*) from public.registrations r where r.event_id = e.id and r.waitlisted)::int     as waitlist
from public.events e;

-- ---------- public functions (anyone can call; they validate everything) ----------
create function public.get_slots(p_doctor bigint, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare closed boolean := extract(dow from p_date) = 0 or p_date < public.hospital_today();
begin
  return jsonb_build_object(
    'closed', closed,
    'slots',  case when closed then '[]'::jsonb else to_jsonb(public.clinic_slots()) end,
    'taken',  case when closed then '[]'::jsonb else
                coalesce((select jsonb_agg(time) from public.appointments where doctor_id = p_doctor and date = p_date), '[]'::jsonb) end);
end $$;

create function public.register_for_event(p_event bigint, p_name text, p_email text, p_dept text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev public.events; confirmed int; w boolean;
  nm text := trim(coalesce(p_name, '')); em text := trim(coalesce(p_email, '')); dp text := trim(coalesce(p_dept, ''));
begin
  select * into ev from public.events where id = p_event for update;      -- lock: no overbooking
  if not found then raise exception 'Event not found.'; end if;
  if ev.date < public.hospital_today() then raise exception 'This event has already taken place.'; end if;
  if nm = '' or char_length(nm) > 100 then raise exception 'Enter your name.'; end if;
  if em !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(em) > 120 then raise exception 'Enter a valid email address.'; end if;
  if dp = '' or char_length(dp) > 60 then raise exception 'Choose a department.'; end if;
  if exists (select 1 from public.registrations where event_id = p_event and lower(email) = lower(em)) then
    raise exception 'This email is already registered for the event.';
  end if;
  select count(*) into confirmed from public.registrations where event_id = p_event and not waitlisted;
  w := confirmed >= ev.capacity;
  insert into public.registrations(event_id, name, email, dept, waitlisted) values (p_event, nm, em, dp, w);
  insert into public.messages(audience, body) values (em,
    case when w then format('You are on the waitlist for "%s". We will confirm you if a seat opens.', ev.title)
         else format('Registration confirmed for "%s" on %s at %s, %s.', ev.title, ev.date, ev.start_time, ev.venue) end);
  return jsonb_build_object('waitlisted', w);
end $$;

create function public.request_appointment(p_doctor bigint, p_date date, p_time text, p_name text, p_phone text) returns text
language plpgsql security definer set search_path = public as $$
declare
  d public.doctors; pid bigint;
  nm text := trim(coalesce(p_name, '')); ph text := trim(coalesce(p_phone, ''));
begin
  if nm = '' or char_length(nm) > 80 then raise exception 'Enter your name.'; end if;
  if ph !~ '^[0-9+() -]{7,20}$' then raise exception 'Enter a valid phone number.'; end if;
  if p_date is null or p_date < public.hospital_today() then raise exception 'Pick a valid future date.'; end if;
  if extract(dow from p_date) = 0 then raise exception 'Clinics are closed on Sundays.'; end if;
  if p_time is null or not (p_time = any (public.clinic_slots())) then raise exception 'Pick a valid time slot.'; end if;
  select * into d from public.doctors where id = p_doctor;
  if not found then raise exception 'Doctor not found.'; end if;

  select id into pid from public.patients where lower(name) = lower(nm) and phone = ph limit 1;
  if pid is null then
    insert into public.patients(name, age, phone, ward, status, doctor_id) values (nm, 0, ph, 'Outpatient', 'Outpatient', p_doctor)
    returning id into pid;
  end if;
  begin
    insert into public.appointments(patient_id, doctor_id, date, time, status) values (pid, p_doctor, p_date, p_time, 'Requested');
  exception when unique_violation then
    raise exception 'That slot was just taken. Please pick another time.';
  end;
  insert into public.messages(audience, body) values (ph,
    format('Appointment requested with %s on %s at %s. The hospital will confirm shortly.', d.name, p_date, p_time));
  return d.name;
end $$;

-- ---------- staff-only functions ----------
create function public.cancel_registration(p_reg bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r public.registrations; nx public.registrations; ev public.events;
begin
  if not public.is_staff() then raise exception 'Staff only.'; end if;
  select * into r from public.registrations where id = p_reg;
  if not found then raise exception 'Registration not found.'; end if;
  select * into ev from public.events where id = r.event_id for update;
  delete from public.registrations where id = p_reg;
  if not r.waitlisted then                                              -- a seat opened: promote the next person
    select * into nx from public.registrations where event_id = r.event_id and waitlisted order by id limit 1;
    if found then
      update public.registrations set waitlisted = false where id = nx.id;
      insert into public.messages(audience, body) values (nx.email, format('A seat opened up. You are now confirmed for "%s".', ev.title));
    end if;
  end if;
end $$;

create function public.confirm_appointment(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  if not public.is_staff() then raise exception 'Staff only.'; end if;
  select ap.date, ap.time, d.name as doctor, p.phone into a
    from public.appointments ap join public.doctors d on d.id = ap.doctor_id join public.patients p on p.id = ap.patient_id
   where ap.id = p_id;
  if not found then raise exception 'Appointment not found.'; end if;
  update public.appointments set status = 'Confirmed' where id = p_id;
  insert into public.messages(audience, body) values (a.phone, format('Your appointment with %s on %s at %s is confirmed.', a.doctor, a.date, a.time));
end $$;

create function public.notify_event(p_event bigint, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare ev public.events; n int;
begin
  if not public.is_staff() then raise exception 'Staff only.'; end if;
  select * into ev from public.events where id = p_event;
  if not found then raise exception 'Event not found.'; end if;
  select count(*) into n from public.registrations where event_id = p_event;
  if n = 0 then raise exception 'No registrants to message yet.'; end if;
  if trim(coalesce(p_text, '')) = '' or char_length(p_text) > 1000 then raise exception 'Write a message (max 1000 characters).'; end if;
  insert into public.messages(audience, body) values (format('%s (%s people)', ev.title, n), trim(p_text));
end $$;

-- ---------- row level security ----------
alter table public.staff         enable row level security;
alter table public.doctors       enable row level security;
alter table public.patients      enable row level security;
alter table public.appointments  enable row level security;
alter table public.events        enable row level security;
alter table public.registrations enable row level security;
alter table public.messages      enable row level security;

create policy staff_self      on public.staff         for select to authenticated using (user_id = auth.uid());
create policy doctors_read    on public.doctors       for select to anon, authenticated using (true);
create policy doctors_staff   on public.doctors       for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy events_read     on public.events        for select to anon, authenticated using (true);
create policy events_staff    on public.events        for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy patients_staff  on public.patients      for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy appts_staff     on public.appointments  for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy regs_staff      on public.registrations for all    to authenticated using (public.is_staff()) with check (public.is_staff());
create policy messages_staff  on public.messages      for all    to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------- privileges ----------
grant usage on schema public to anon, authenticated;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on public.doctors, public.events, public.public_events to anon, authenticated;
grant select, insert, update, delete on public.doctors, public.patients, public.appointments,
      public.events, public.registrations, public.messages to authenticated;
grant select on public.staff to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant execute on function public.hospital_today(), public.clinic_slots(), public.is_staff() to anon, authenticated;
grant execute on function public.get_slots(bigint, date),
                          public.register_for_event(bigint, text, text, text),
                          public.request_appointment(bigint, date, text, text, text) to anon, authenticated;
grant execute on function public.cancel_registration(bigint),
                          public.confirm_appointment(bigint),
                          public.notify_event(bigint, text) to authenticated;
