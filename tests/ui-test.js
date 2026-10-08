'use strict';
// Optional developer test: loads the real pages in jsdom and connects them to the real SQL schema
// (in-memory Postgres) through a tiny stand-in for supabase-js. Run: npm test
const fs = require('fs'), path = require('path'), assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const { JSDOM } = require('jsdom');
const STAFF = '11111111-1111-1111-1111-111111111111', STUDENT = '22222222-2222-2222-2222-222222222222';
const PUB = path.join(__dirname, '../public');

(async () => {
  const db = new PGlite({ parsers: { 1082: v => v, 1184: v => v, 20: v => parseInt(v, 10) } });
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${STAFF}','staff@x.org'),('${STUDENT}','student@x.org');`);
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/seed.sql'), 'utf8'));
  await db.exec(`insert into public.staff values ('${STAFF}')`);

  // --- stand-in for supabase-js, executing real SQL under the right Postgres role ---
  const makeClient = () => {
    const st = { role: 'anon', uid: '' }; let lock = Promise.resolve();
    const exec = (sql, params) => (lock = lock.then(async () => {
      await db.exec(`set role ${st.role}; select set_config('request.jwt.claim.sub','${st.uid}',false);`);
      try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
    }, () => {}).then(x => x));
    const run = (sql, params) => { const p = lock.then(() => exec(sql, params)); return p; };
    const wrap = async fn => { try { return await fn(); } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; } };
    const qi = x => '"' + x.replace(/"/g, '') + '"';
    const from = table => {
      const s = { cols: '*', where: [], order: [], limit: null, op: 'select', row: null };
      const b = {
        select(c) { s.cols = c || '*'; return b; }, eq(c, v) { s.where.push([c, '=', v]); return b; }, gte(c, v) { s.where.push([c, '>=', v]); return b; },
        order(c, o) { s.order.push([c, o && o.ascending === false ? 'desc' : 'asc']); return b; }, limit(n) { s.limit = n; return b; },
        insert(r) { s.op = 'insert'; s.row = r; return b; }, update(r) { s.op = 'update'; s.row = r; return b; }, delete() { s.op = 'delete'; return b; },
        then(res, rej) {
          return wrap(async () => {
            const params = [], w = s.where.length ? ' where ' + s.where.map(([c, o, v]) => { params.push(v); return `${qi(c)} ${o} $${params.length}`; }).join(' and ') : '';
            let sql;
            if (s.op === 'select') sql = `select ${s.cols === '*' ? '*' : s.cols.split(',').map(c => qi(c.trim())).join(',')} from public.${qi(table)}${w}` +
              (s.order.length ? ' order by ' + s.order.map(([c, d]) => `${qi(c)} ${d}`).join(',') : '') + (s.limit ? ` limit ${s.limit}` : '');
            else if (s.op === 'insert') { const k = Object.keys(s.row); k.forEach(c => params.push(s.row[c])); sql = `insert into public.${qi(table)} (${k.map(qi)}) values (${k.map((_, i) => '$' + (i + 1))})`; }
            else if (s.op === 'update') { const k = Object.keys(s.row); k.forEach(c => params.push(s.row[c])); const set = k.map((c, i) => `${qi(c)} = $${i + 1}`).join(','); const w2 = s.where.map(([c, o, v]) => { params.push(v); return `${qi(c)} ${o} $${params.length}`; }).join(' and '); sql = `update public.${qi(table)} set ${set} where ${w2}`; }
            else sql = `delete from public.${qi(table)}${w}`;
            const rows = await run(sql, params); return { data: s.op === 'select' ? rows : null, error: null };
          }).then(res, rej);
        }
      };
      return b;
    };
    const rpc = (fn, args = {}) => wrap(async () => {
      const k = Object.keys(args), params = k.map(x => args[x]);
      const rows = await run(`select public.${fn}(${k.map((c, i) => `${c} => $${i + 1}`).join(',')}) as r`, params);
      return { data: rows[0] ? rows[0].r : null, error: null };
    });
    const users = { 'staff@x.org': [STAFF, 'pw'], 'student@x.org': [STUDENT, 'pw'] };
    const auth = {
      async signInWithPassword({ email, password }) { const u = users[email]; if (!u || u[1] !== password) return { data: null, error: { message: 'Invalid login credentials' } }; st.role = 'authenticated'; st.uid = u[0]; return { data: {}, error: null }; },
      async getSession() { return { data: { session: st.uid ? { user: {} } : null } }; },
      async signOut() { st.role = 'anon'; st.uid = ''; return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
    };
    return { from, rpc, auth };
  };

  const open = async file => {
    const html = fs.readFileSync(path.join(PUB, file), 'utf8').replace(/<link[^>]*>/g, '').replace(/<script src[^>]*><\/script>/g, '');
    const client = makeClient(), errs = [];
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' + file, pretendToBeVisual: true, beforeParse(w) {
      w.CAREDESK_CONFIG = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'key' }; w.supabase = { createClient: () => client };
      w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
      w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {}; w.confirm = () => true;
      w.addEventListener('error', e => errs.push(e.message)); } });
    await wait(900); return { w: dom.window, d: dom.window.document, errs };
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0; const ok = (c, m) => { if (!c) { console.log('  FAIL -', m); process.exitCode = 1; } else { n++; console.log('  ok -', m); } };
  const submit = (w, el) => el.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  const fld = (d, sel, v) => { d.querySelector(sel).value = v; };

  try {
    console.log('Public website');
    let { w, d, errs } = await open('index.html');
    ok(errs.length === 0 && !/Setup needed/.test(d.body.firstElementChild.textContent), 'loads without errors or setup banner ' + errs.join());
    ok(d.querySelectorAll('#docs .doc').length >= 4 && d.querySelectorAll('#depts .dept').length >= 4, 'doctors and departments come from the database');
    ok(d.querySelectorAll('#evlist .ev').length >= 3 && d.querySelectorAll('#slots button').length > 0, 'events and time slots come from the database');
    const dt = d.querySelector('#date'); for (let i = 2; i < 10; i++) { const x = new Date(); x.setDate(x.getDate() + i); if (x.getDay() !== 0) { dt.value = x.toLocaleDateString('en-CA'); break; } }
    dt.dispatchEvent(new w.Event('change')); await wait(500);
    d.querySelector('#slots button:not([disabled])').click();
    fld(d, '#pn', 'UI Tester'); fld(d, '#pp', '99999 12345'); submit(w, d.querySelector('#bf')); await wait(700);
    ok(/Request received/.test(d.querySelector('#bconf').textContent), 'appointment request is accepted');
    w.openReg(2); fld(d, '#dlg [name=name]', 'Stu Dent'); fld(d, '#dlg [name=email]', 'stu@college.edu'); submit(w, d.querySelector('#dlg form')); await wait(700);
    ok(/registered/.test(d.querySelector('#toast').textContent), 'event registration works');
    w.openReg(2); fld(d, '#dlg [name=name]', 'Stu Again'); fld(d, '#dlg [name=email]', 'STU@college.edu'); submit(w, d.querySelector('#dlg form')); await wait(700);
    ok(/already registered/.test(d.querySelector('#toast').textContent), 'duplicate registration shows a clear message');

    console.log('Staff portal');
    ({ w, d, errs } = await open('staff.html'));
    ok(errs.length === 0 && !!d.querySelector('.login'), 'shows sign-in first ' + errs.join());
    fld(d, '.login [name=email]', 'student@x.org'); fld(d, '.login [name=password]', 'pw'); submit(w, d.querySelector('.login form')); await wait(700);
    ok(/not set up as staff/.test(d.querySelector('#toast').textContent) && !!d.querySelector('.login'), 'a signed-in non-staff account is refused');
    fld(d, '.login [name=email]', 'staff@x.org'); fld(d, '.login [name=password]', 'bad'); submit(w, d.querySelector('.login form')); await wait(500);
    ok(/Invalid login/.test(d.querySelector('#toast').textContent), 'wrong password is refused');
    fld(d, '.login [name=password]', 'pw'); submit(w, d.querySelector('.login form')); await wait(1200);
    ok(!!d.querySelector('#tabs button') && /Appointment requests to confirm/.test(d.body.textContent), 'staff sign in and see the dashboard');
    w.go('appts'); const view = () => d.querySelector('#view').textContent;
    ok(/UI Tester/.test(view()) && /Requested/.test(view()), 'website booking appears as Requested');
    d.querySelector('#view .btn.sm[onclick^="confirmAppt"]').click(); await wait(900);
    ok(/Confirmed/.test(view()) && d.querySelectorAll('#view table .tag.warn').length === 0 && !d.querySelector('#view table .btn.sm[onclick^="confirmAppt"]'), 'staff can confirm it');
    w.go('events'); await w.openEvent(2); await wait(500);
    ok(/Stu Dent/.test(d.querySelector('#dlg').textContent), 'staff see the website registration');
    w.openEvent(1); await wait(600); const cancelBtn = d.querySelector('#dlg button[onclick^="cancelReg"]'); cancelBtn.click(); await wait(900);
    ok(/cancelled/.test(d.querySelector('#toast').textContent), 'staff can cancel a registration');
    fld(d, '#dlg [name=text]', 'Room changed to Hall B'); submit(w, d.querySelector('#dlg form[onsubmit^="notify"]')); await wait(900);
    ok(/Message sent/.test(d.querySelector('#toast').textContent), 'staff can message registrants');
    w.go('events');
    const mk = (title, date, s, e, venue) => { const f = d.querySelector('#view form[onsubmit^="addEvent"]'); fld(d, '#view [name=title]', title); fld(d, '#view [name=date]', date); fld(d, '#view [name=start]', s); fld(d, '#view [name=end]', e); fld(d, '#view [name=venue]', venue); submit(w, f); };
    const far = new Date(); far.setDate(far.getDate() + 30); const fd = far.toLocaleDateString('en-CA');
    mk('Clash Test A', fd, '10:00', '12:00', 'Skills Lab'); await wait(900); ok(/Event created/.test(d.querySelector('#toast').textContent), 'staff create an event');
    w.go('events'); mk('Clash Test B', fd, '11:00', '13:00', 'Skills Lab'); await wait(900);
    ok(/Clash: Skills Lab is booked/.test(d.querySelector('#toast').textContent), 'venue clash is refused with a clear message');
    w.go('msgs'); ok(/confirmed/.test(view()) && /Room changed to Hall B/.test(view()), 'messages page logs confirmations and announcements');
    w.go('patients'); ok(/Ravi Kumar/.test(view()) && /UI Tester/.test(view()), 'patients page lists patients incl. website bookings');

    console.log('Events page');
    ({ w, d, errs } = await open('events.html')); ok(errs.length === 0 && d.querySelectorAll('#list .ev').length >= 3, 'lists events from the database');
    console.log(`\n${n} UI tests passed`);
  } catch (e) { console.error('ERROR', e); process.exitCode = 1; }
  process.exit();
})();
