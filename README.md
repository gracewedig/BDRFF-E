# Black Desert Resort — FF&E Tracker

A web app for submitting, approving and tracking FF&E (furniture, fixtures & equipment) requests across the resort's projects: **The Terrace, The Cove, Resort Center, Pickleball, and Waterpark**.

## What's in it

| Who | What they can do |
|---|---|
| **Managers** | See every request · approve or reject (a note is required to reject) · move approved work to *In Progress* and *Completed* · approval queue with a pending count · change people's roles |
| **Owner Relations** | See every request · submit requests · keep a private **action-item checklist** (status, priority, due date, linked ticket, category, notes) · export their own sheet or a **combined workbook** (overall sheet + their own tab) |
| **Everyone** | **Sheet Builder with an AI assistant**: describe the spreadsheet you want ("open Cove requests due this month grouped by building"), adjust columns/filters/sorting, save it, **pin it to the dashboard** so it's always visible, and export it to Excel or CSV |

**Request tickets** require: project · building(s) · room number(s) · what's needed · FF&E tag (plus optional specification) · quantity · needed-by date · at least one photo, each marked as **Concept image** or **Proof of damage**. Priority and extra details are optional. Each ticket gets a number like `BDR-0012`.

Changes show up for everyone immediately (live updates), and it works on phones — the photo button opens the camera.

## Folder layout

```
public/                 ← the website (this is what Netlify publishes)
  index.html
  css/styles.css
  js/config.js          ← paste your Supabase keys here
  js/app.js, store.js, fields.js, views.js, export.js
netlify/functions/ai-sheet.mjs   ← AI assistant (runs on Netlify, keeps the API key secret)
supabase/schema.sql     ← database setup, run once
netlify.toml, package.json
```

## Try it right away (Demo mode)

With `public/js/config.js` left blank, the app runs in **Demo mode**: pick a sample Manager or Owner Relations user and click around. Demo data lives only in that browser, so it is **not** shared between people. Use it to try things out, then do the setup below for real multi-user use.

To preview on your computer: open a terminal in this folder and run `npx serve public`, then visit the address it prints. (Opening `index.html` by double-clicking won't work, because browsers block the app's scripts from `file://`.)

## Going live for the whole team (about 20 minutes)

Several people using it at once needs a shared database. This uses **Supabase** (free tier is fine) for logins, data and photos, and **Netlify** to host the site.

### 1. Create the database (Supabase)
1. Sign up at [supabase.com](https://supabase.com) → **New project**. Pick a name and password, and choose a US region.
2. Open **SQL Editor** → **New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
4. Paste both into `public/js/config.js`:
   ```js
   SUPABASE_URL: "https://xxxx.supabase.co",
   SUPABASE_ANON_KEY: "eyJhbGciOi...",
   ```
   The anon key is meant to be public; the database's security rules protect the data.
5. Optional: under **Authentication → Providers → Email**, turn off "Confirm email" if you don't want people to have to confirm their address before signing in.

### 2. Put the site on Netlify
**Recommended: connect a GitHub repo** (this is needed for the AI assistant):
1. Push this folder to GitHub.
2. In Netlify: **Add new site → Import an existing project** → choose the repo. The build settings come from `netlify.toml`, so you don't need to change anything. Click **Deploy**.

**Quick alternative: drag and drop.** Drag the **`public`** folder onto [app.netlify.com/drop](https://app.netlify.com/drop). Everything works except the AI assistant, which falls back to a built-in offline builder (it understands projects, statuses, "overdue", "next 14 days", "my requests", "group by building", and so on).

### 3. Turn on the AI assistant
In Netlify: **Site configuration → Environment variables**, add:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | an API key from [console.anthropic.com](https://console.anthropic.com) |
| `SUPABASE_URL` | same Project URL as above |
| `SUPABASE_ANON_KEY` | same anon key as above |

Then redeploy (**Deploys → Trigger deploy**). Only signed-in staff can use the assistant (it checks their Supabase login). It uses Claude Opus 5.5 at low effort, so each sheet costs a fraction of a cent. If it's ever unreachable, the app automatically uses the offline builder instead.

### 4. Make yourself a manager
1. Open your new Netlify site and **Create account**.
2. In Supabase **SQL Editor**, run (with your email):
   ```sql
   update public.profiles set role = 'manager' where email = 'you@yourcompany.com';
   ```
3. Sign out and back in. From now on, use **Team & Roles** in the app to promote other managers. Everyone who signs up starts as Owner Relations.

## Notes
- **Security:** Owner Relations can't approve anything. The database itself enforces this, not only the screen. Action items and saved sheets are private to each person; managers can read action items. Photos are stored privately and shown through links that expire after an hour.
- **Exports:** Excel files have one tab per sheet, with auto-filters and sized columns. The **Combined workbook** (My Action Items page) contains *Overall Requests*, *your action items*, and each of your saved sheets as separate tabs.
- **Photos** are resized automatically before upload, so they load quickly and stay small.
