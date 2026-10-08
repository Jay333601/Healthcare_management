-- Optional sample data. Run in the SQL Editor after schema.sql. Skip it for a blank system.
insert into public.doctors(name, dept) values
  ('Dr. Meera Rao', 'Cardiology'), ('Dr. Arjun Nair', 'Orthopaedics'), ('Dr. Sana Iyer', 'Paediatrics'),
  ('Dr. Kabir Shah', 'General Medicine'), ('Dr. Isha Menon', 'Cardiology');

insert into public.patients(name, age, phone, ward, status, doctor_id) values
  ('Ravi Kumar', 54, '98450 11122', 'Ward B-12', 'Admitted', 1),
  ('Anita Desai', 31, '98860 33445', 'Outpatient', 'Outpatient', 4),
  ('Lakshmi N.', 7, '99000 55667', 'Paeds 3', 'Admitted', 3);

insert into public.appointments(patient_id, doctor_id, date, time, status) values
  (2, 4, public.hospital_today(), '10:00', 'Confirmed'),
  (1, 1, public.hospital_today(), '11:30', 'Confirmed');

insert into public.events(title, date, start_time, end_time, venue, capacity, description) values
  ('Basic Life Support Workshop', public.hospital_today() + 3, '10:00', '13:00', 'Seminar Hall A', 3, 'Hands-on CPR training for students and staff.'),
  ('Free Health Check-up Camp',   public.hospital_today() + 6, '09:00', '16:00', 'Main Lobby', 50, 'Open to students and local residents.'),
  ('Medical Ethics Guest Lecture', public.hospital_today() + 10, '14:00', '15:30', 'Auditorium', 120, 'Guest speaker session with Q&A.');

insert into public.registrations(event_id, name, email, dept) values
  (1, 'Priya S.', 'priya@college.edu', 'Nursing'), (1, 'Rohit M.', 'rohit@college.edu', 'MBBS'),
  (3, 'Dev P.', 'dev@college.edu', 'MBBS');

insert into public.messages(audience, body) values ('All staff', 'Welcome to CareDesk. Event updates will appear here.');
