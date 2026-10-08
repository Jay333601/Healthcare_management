# CareDesk on Supabase

Hospital management + college event registration. **Supabase is the backend** (database, login, security
rules). There is no server to run: the website is plain HTML files that talk to Supabase directly.

## Folder
- supabase/schema.sql   all tables, security rules and business rules (run once)
- supabase/seed.sql     optional sample data
- supabase/reset.sql    wipes CareDesk data so you can start over
- public/index.html     public website (patients + students, no login)
- public/staff.html     staff portal (email + password login)
- public/events.html    events-only page for students
- public/config.js      <- you paste your Supabase URL and key here
- tests/                optional developer tests (see bottom)

## Setup (about 10 minutes)
1. Go to https://supabase.com, sign in, click **New project**. Choose a name, a database password
   (save it) and the region closest to you. Wait for it to finish creating.
2. In the left menu open **SQL Editor** -> **New query**. Paste all of `supabase/schema.sql` -> **Run**.
   You should see "Success". Optionally do the same with `supabase/seed.sql` for sample data.
3. Open **Project Settings -> API** (or the **Connect** button). Copy the **Project URL** and the
   **anon public key** (the newer "Publishable key" starting `sb_publishable_` works too).
   Never use the `service_role` / secret key in these files.
4. Open `public/config.js` and paste both values between the quotes.
5. Create your staff login: **Authentication -> Users -> Add user -> Create new user**, enter an email and
   password and tick **Auto Confirm User**. Then in the SQL Editor run (use your email):
   ```sql
   insert into public.staff (user_id) select id from auth.users where email = 'you@example.com';
   ```
   Only accounts in the `staff` table can see patient data. Add more staff the same way.
6. Recommended: **Authentication -> Sign In / Providers** -> turn off **Allow new users to sign up**,
   so only people you add can have accounts.
7. Open the site. In VS Code install the **Live Server** extension, then right-click `public/index.html`
   -> **Open with Live Server**. (Alternative: run `npx serve public` in a terminal.)
   - http://127.0.0.1:5500/            public website
   - http://127.0.0.1:5500/staff.html  staff portal

## Put it online
The `public` folder is a static site. Drag it onto https://app.netlify.com/drop, or use Vercel,
Cloudflare Pages or GitHub Pages. No other settings are needed.

## How it works / what is enforced (in the database, not the browser)
- Visitors can only: read doctors and event seat counts, see free time slots, register for an event,
  and request an appointment. They cannot read patients, appointments, registrations or messages.
- Staff (signed in + in the `staff` table) can read and manage everything.
- Venue clashes are rejected (same date, venue and overlapping time).
- Event capacity is enforced with a lock (no overbooking); full events use a waitlist and cancelling a
  seat promotes the next person automatically.
- A doctor cannot be booked twice for the same time. Clinic slots are 09:00-16:30, closed 13:00-14:00
  and Sundays. Website requests arrive as "Requested"; staff confirm them.
- Every confirmation and announcement is stored in the messages table.

## Known limits / before real patients
- Messages are stored, not emailed or texted. Add a Supabase Edge Function with an email/SMS provider
  to actually send them.
- Public forms have only Supabase's default rate limits. For a busy public site, turn on CAPTCHA in
  Authentication settings or add Cloudflare Turnstile in front of the forms.
- The hospital time zone is set to Asia/Kolkata in `hospital_today()` inside schema.sql; change it if needed.
- Supabase's security advisor may mention the `public_events` view: it is intentional (it exposes only
  seat counts, no personal data).
- Patient data is sensitive. Check your local health-data rules, enable backups (Supabase paid plans),
  and consider staff roles beyond a single "staff" level.

## Start over
SQL Editor -> run `supabase/reset.sql`, then `schema.sql` (and `seed.sql`) again.

## Developer tests (optional)
`cd tests && npm install && npm test` runs the SQL in a local in-memory Postgres (17 checks incl. security)
and loads the real pages against it (20 checks). Nothing needs a Supabase account.
