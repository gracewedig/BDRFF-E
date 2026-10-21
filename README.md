# Black Desert Resort — FF&E Tracker

A web app for FF&E (furniture, fixtures & equipment) requests, approvals, inventory and attic stock across the resort's projects: **The Terrace, The Cove, Resort Center, Pickleball, and Waterpark**.

## What's in it

| Area | What it does |
|---|---|
| **Requests** | Detailed tickets: project, building(s), room(s), what's needed, FF&E tag/spec, quantity, needed-by date, and photos marked *Concept image* or *Proof of damage*. Each gets a number like `BDR-0012`. If someone submits something that's already been requested, the app shows the matching ticket first. |
| **Email Requests** (separate tab) | Emails sent to an FF&E inbox are read automatically into draft tickets (photos included). Anything already submitted in the app, or already emailed, is filed under **Auto-matched duplicates**, so managers review each request once. Managers turn the rest into tickets with one click. Anyone can also **paste an email**. |
| **Approvals** (managers) | Approve, or reject with a note, then move work to *In Progress* → *Completed*. The badge counts pending tickets plus emails waiting for review. |
| **Inventory & Attic Stock** | Clean per-project views (attic stock vs. inventory, low-stock warnings against par levels). **Take out** stock and optionally record where it went (project, building, room, ticket, note), or return/add stock. Every move goes into a movement log. Export to Excel with one tab per project plus the log. |
| **Import Spreadsheet** (managers) | Upload Excel/CSV for inventory or requests. Rows are sorted into projects by a Project column, the tab name (a tab called “Cove Attic” → The Cove, Attic Stock), or project names in the row. Columns are matched automatically. You preview everything first: new items, items that update existing counts, requests that are already open, and rows that need a project. |
| **My Action Items** | A private checklist (status, priority, due date, linked ticket, notes). Export your sheet, or a combined workbook with the overall sheet plus your tab. |
| **Sheet Builder** | Describe a spreadsheet in plain English and the AI assistant builds it. Pin it to your dashboard and export it any time. |
| **Team & Roles** (managers) | **Invite people by email**, change roles, re-send invites, and **remove people**. Removing someone keeps the requests they submitted on record. |

**Roles:** *Managers* approve, review emails, manage inventory, import spreadsheets and manage the team. *Owner Relations* see everything, submit requests, take stock out (logged under their name), and keep their own action items. The database enforces these rules, not just the screens.

## Try it first (Demo mode)

With `public/js/config.js` left blank, the app runs in **Demo mode** with sample data: tickets, inventory, and three emails (one new, one auto-matched duplicate, one newsletter that was filtered out). Pick a Manager or Owner Relations user and click around. Demo data lives only in that browser.

Preview on your computer: `npx serve public` in this folder, then open the address it prints.

## Going live (about 30 minutes)

You need **Supabase** (free tier: logins, database, photos) and **Netlify** (hosting and the server functions).

### 1. Database — Supabase
1. [supabase.com](https://supabase.com) → **New project**.
2. **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**. (It's safe to run again later.)
3. **Project Settings → API**: copy the **Project URL**, the **anon public** key, and the **service_role** key (keep the service_role key secret, it only goes into Netlify).
4. Put the URL and anon key into `public/js/config.js`.

### 2. Hosting — Netlify
1. Push this folder to GitHub, then in Netlify: **Add new site → Import an existing project** → pick the repo → **Deploy** (settings come from `netlify.toml`).
2. **Site configuration → Environment variables**, add:

| Key | Value | Used for |
|---|---|---|
| `SUPABASE_URL` | Project URL | all functions |
| `SUPABASE_ANON_KEY` | anon key | AI sheet assistant |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key | invites, removing users, email intake |
| `INBOUND_EMAIL_SECRET` | any long random password you make up | email intake |
| `ANTHROPIC_API_KEY` | from [console.anthropic.com](https://console.anthropic.com) | AI sheet assistant and smarter email reading (optional) |

3. **Deploys → Trigger deploy**.

(Dragging just the `public` folder onto Netlify Drop also works for a quick look, but invites, email intake and the AI features need the Git deploy.)

### 3. Logins & invites
1. In Supabase → **Authentication → URL Configuration**, set **Site URL** to your Netlify address (e.g. `https://bdr-ffe.netlify.app`) and add it under **Redirect URLs**. Invite and password-reset links send people here to choose a password.
2. Open your site, **Create account**, then make yourself a manager in the Supabase SQL Editor:
   ```sql
   update public.profiles set role = 'manager' where email = 'you@yourcompany.com';
   ```
3. Invite everyone else from **Team & Roles**.
4. Optional, recommended once everyone is invited: in Supabase → **Authentication → Providers/Sign In**, turn off “Allow new users to sign up”, and set `ALLOW_SIGNUP: false` in `config.js`, so only invited people can get in.

### 4. Hook up email
Email intake address (shown to managers on the Email Requests tab):
```
https://YOUR-SITE.netlify.app/.netlify/functions/email-inbound?key=YOUR_INBOUND_EMAIL_SECRET
```
Pick whichever fits your email:

- **Outlook / Microsoft 365 (Power Automate):** create a flow *When a new email arrives (V3)* on a shared mailbox like `ffe@…` (Include Attachments: Yes) → **HTTP** action, method POST, the URL above, header `Content-Type: application/json`, body:
  ```json
  {
    "from_email": "@{triggerOutputs()?['body/from']}",
    "subject": "@{triggerOutputs()?['body/subject']}",
    "html": "@{triggerOutputs()?['body/body']}",
    "message_id": "@{triggerOutputs()?['body/internetMessageId']}",
    "attachments": @{triggerOutputs()?['body/attachments']}
  }
  ```
- **Gmail / Google Workspace:** a Zapier or Make scenario *New email* → *Webhook POST* with the same JSON fields (`from_email`, `from_name`, `subject`, `text`, `message_id`, `attachments: [{name, content_type, content (base64)}]`).
- **A dedicated inbound address:** Postmark Inbound, SendGrid Inbound Parse or Mailgun Routes can post straight to the URL above; their formats are recognized automatically.

Each email is checked against open tickets and other waiting emails. Matches go to **Auto-matched duplicates** (with the reason, e.g. “same FF&E tag, same room”), and a manager can click **Not a duplicate** if the app got it wrong. Emails that aren't FF&E requests (newsletters etc.) go to **Dismissed**. The same email delivered twice is only stored once. When someone later submits the same request in the app, the waiting email is filed as its duplicate automatically.

## Folder layout
```
public/                       the website (what Netlify publishes)
  index.html, css/styles.css
  js/config.js                Supabase keys + settings
  js/app.js                   shell, dashboard, requests, approvals, action items, sheet builder
  js/inventory.js             inventory & attic stock
  js/intake.js                spreadsheet import
  js/email.js                 email requests
  js/team.js                  team, invites, roles
  js/dedupe.js                duplicate matching (also used by the email function)
  js/emailparse.js            built-in email reader
  js/store.js                 data access (Supabase or demo)
netlify/functions/
  ai-sheet.mjs                AI sheet assistant
  email-inbound.mjs           email intake
  manage-users.mjs            invites and removing users
supabase/schema.sql           database, security rules, photo storage
```

## Notes
- **AI:** uses Claude Opus 5.5 at low effort, a fraction of a cent per email or sheet. Without `ANTHROPIC_API_KEY`, the built-in rules handle emails and sheets instead.
- **Photos** are resized before upload and stored privately, with view links that expire after an hour.
- **Spreadsheet tips:** a *Project* column, or one tab per project, gives the cleanest import. Download the templates from the Import page.
