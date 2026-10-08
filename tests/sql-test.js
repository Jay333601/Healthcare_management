'use strict';
// Optional developer test: runs supabase/schema.sql + seed.sql in an in-memory Postgres (PGlite)
// with Supabase-style roles, then checks business rules and security. Run: cd tests && npm install && npm test
const fs = require('fs'), path = require('path'), assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');

const STAFF = '11111111-1111-1111-1111-111111111111', OTHER = '22222222-2222-2222-2222-222222222222';
(async () => {
  const db = new PGlite();
  // minimal stand-in for Supabase's auth schema and roles
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${STAFF}', 'staff@x.org'), ('${OTHER}', 'student@x.org');`);
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/seed.sql'), 'utf8'));
  await db.exec(`insert into public.staff values ('${STAFF}')`);

  const as = async (role, uid, sql, params) => {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid || ''}', false);`);
    try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
  };
  const anon = (sql, p) => as('anon', '', sql, p), staff = (sql, p) => as('authenticated', STAFF, sql, p), user = (sql, p) => as('authenticated', OTHER, sql, p);
  const fails = async (promise, re, msg) => { try { await promise; } catch (e) { assert.match(e.message, re, msg + ' (wrong error: ' + e.message + ')'); return; } assert.fail(msg + ' (should have failed)'); };
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const weekday = () => { for (let i = 2; i < 12; i++) if (new Date(d(i) + 'T00:00:00Z').getUTCDay() !== 0) return d(i); };
  const sunday = () => { for (let i = 2; i < 12; i++) if (new Date(d(i) + 'T00:00:00Z').getUTCDay() === 0) return d(i); };
  const reg = (ev, n, e) => anon('select public.register_for_event($1,$2,$3,$4) r', [ev, n, e, 'MBBS']);

  let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok -', name); };
  try {
    console.log('Visitor (anon) permissions');
    await t('can read doctors and the public events view', async () => {
      assert.ok((await anon('select * from public.doctors')).rows.length >= 4);
      const ev = (await anon('select * from public.public_events order by id')).rows; assert.equal(ev[0].confirmed, 2);
    });
    await t('cannot read patients, appointments, registrations or messages', async () => {
      for (const tb of ['patients', 'appointments', 'registrations', 'messages', 'staff']) await fails(anon(`select * from public.${tb}`), /permission denied/, 'anon read ' + tb);
    });
    await t('cannot write events or doctors directly', async () => {
      await fails(anon("insert into public.events(title,date,start_time,end_time,venue,capacity) values ('x',current_date+5,'10:00','11:00','Auditorium',5)"), /permission denied/, 'anon insert event');
      await fails(anon("delete from public.doctors"), /permission denied/, 'anon delete doctors');
    });
    await t('cannot call staff-only functions', async () => {
      await fails(anon('select public.cancel_registration(1)'), /permission denied/, 'anon cancel');
      await fails(anon('select public.confirm_appointment(1)'), /permission denied/, 'anon confirm');
    });

    console.log('Event registration (public)');
    await t('registers, blocks duplicate email in any case, rejects bad input', async () => {
      assert.equal((await reg(2, 'Stu', 'stu@x.edu')).rows[0].r.waitlisted, false);
      await fails(reg(2, 'Stu again', 'STU@X.EDU'), /already registered/, 'duplicate');
      await fails(reg(2, 'Bad', 'nope'), /valid email/, 'bad email');
      await fails(reg(2, '', 'a@b.co'), /Enter your name/, 'empty name');
      await fails(reg(999, 'X', 'a@b.co'), /Event not found/, 'unknown event');
    });
    await t('waitlists when full, and staff cancel promotes the next person', async () => {
      assert.equal((await reg(1, 'Third', 'third@x.edu')).rows[0].r.waitlisted, false);   // event 1: capacity 3, had 2
      assert.equal((await reg(1, 'Fourth', 'fourth@x.edu')).rows[0].r.waitlisted, true);
      const first = (await staff("select id from public.registrations where event_id=1 order by id limit 1")).rows[0].id;
      await staff('select public.cancel_registration($1)', [first]);
      const after = (await staff("select waitlisted from public.registrations where email='fourth@x.edu'")).rows[0];
      assert.equal(after.waitlisted, false);
      assert.equal((await staff("select count(*)::int c from public.messages where audience='fourth@x.edu' and body like '%now confirmed%'")).rows[0].c, 1);
    });

    console.log('Signed-in user who is NOT staff');
    await t('sees no private rows and cannot write', async () => {
      assert.equal((await user('select * from public.patients')).rows.length, 0);
      assert.equal((await user('select * from public.messages')).rows.length, 0);
      await fails(user("insert into public.doctors(name,dept) values ('Fake','Fake')"), /row-level security/, 'non-staff insert');
      await fails(user('select public.cancel_registration(1)'), /Staff only/, 'non-staff cancel');
    });

    console.log('Staff');
    await t('sees patients and messages', async () => {
      assert.ok((await staff('select * from public.patients')).rows.length >= 3);
      assert.ok((await staff('select * from public.messages')).rows.length >= 3);
    });
    const wd = weekday(), ins = (title, date, s, e, venue) => staff('insert into public.events(title,date,start_time,end_time,venue,capacity) values ($1,$2,$3,$4,$5,5)', [title, date, s, e, venue]);
    await t('creates events, blocks venue clashes, allows other venues', async () => {
      await ins('A', d(20), '10:00', '12:00', 'Skills Lab');
      await fails(ins('B', d(20), '11:00', '13:00', 'Skills Lab'), /Clash: Skills Lab is booked for "A"/, 'clash');
      await ins('C', d(20), '12:00', '13:00', 'Skills Lab');                              // touching edges is fine
      await ins('D', d(20), '11:00', '13:00', 'Auditorium');
    });
    await t('rejects end before start and dates in the past', async () => {
      await fails(ins('E', d(21), '12:00', '10:00', 'Auditorium'), /check/, 'end before start');
      await fails(ins('F', d(-2), '10:00', '11:00', 'Auditorium'), /in the past/, 'past');
    });
    await t('blocks doctor double-booking', async () => {
      const q = "insert into public.appointments(patient_id,doctor_id,date,time) values (1,2,$1,'09:30')";
      await staff(q, [wd]); await fails(staff(q, [wd]), /duplicate key|unique/, 'double booking');
    });
    await t('notify_event logs a message and refuses an empty audience', async () => {
      await staff("select public.notify_event(1, 'Venue unchanged.')");
      await fails(staff("select public.notify_event(2, 'hi')").then(async () => staff("select public.notify_event(999,'x')")), /Event not found/, 'unknown');
    });

    console.log('Appointment requests (public)');
    await t('slots: open on weekdays, closed on Sundays', async () => {
      const a = (await anon('select public.get_slots(1,$1) r', [wd])).rows[0].r; assert.equal(a.closed, false); assert.ok(a.slots.includes('09:00')); assert.ok(!a.slots.includes('13:00'));
      assert.equal((await anon('select public.get_slots(1,$1) r', [sunday()])).rows[0].r.closed, true);
    });
    const ask = (doc, date, time, name, phone) => anon('select public.request_appointment($1,$2,$3,$4,$5) r', [doc, date, time, name, phone]);
    await t('request creates patient + Requested appointment; slot then shows as taken', async () => {
      assert.equal((await ask(1, wd, '10:00', 'Walk In', '98450 00000')).rows[0].r, 'Dr. Meera Rao');
      assert.ok((await anon('select public.get_slots(1,$1) r', [wd])).rows[0].r.taken.includes('10:00'));
      const a = (await staff("select a.status, p.name from public.appointments a join public.patients p on p.id=a.patient_id where a.date=$1 and a.time='10:00' and a.doctor_id=1", [wd])).rows[0];
      assert.deepEqual([a.status, a.name], ['Requested', 'Walk In']);
    });
    await t('same slot is refused, same person reuses their patient record', async () => {
      await fails(ask(1, wd, '10:00', 'Other', '98450 11111'), /just taken/, 'taken');
      await ask(1, wd, '10:30', 'walk in', '98450 00000');
      assert.equal((await staff("select count(*)::int c from public.patients where phone='98450 00000'")).rows[0].c, 1);
    });
    await t('rejects bad phone, lunch slot, Sunday and past dates', async () => {
      await fails(ask(1, wd, '11:00', 'X', 'abc'), /valid phone/, 'phone');
      await fails(ask(1, wd, '13:00', 'X', '98450 00000'), /valid time slot/, 'lunch');
      await fails(ask(1, sunday(), '11:00', 'X', '98450 00000'), /closed on Sundays/, 'sunday');
      await fails(ask(1, d(-1), '11:00', 'X', '98450 00000'), /future date/, 'past');
      await fails(ask(99, wd, '11:00', 'X', '98450 00000'), /Doctor not found/, 'doctor');
    });
    await t('staff confirms the request and a message is logged', async () => {
      const id = (await staff("select id from public.appointments where status='Requested' and time='10:00'")).rows[0].id;
      await staff('select public.confirm_appointment($1)', [id]);
      assert.equal((await staff('select status from public.appointments where id=$1', [id])).rows[0].status, 'Confirmed');
      assert.equal((await staff("select count(*)::int c from public.messages where body like '%is confirmed%'")).rows[0].c, 1);
    });
    console.log(`\n${n} SQL tests passed`);
  } catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
})();
