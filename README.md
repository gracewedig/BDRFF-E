# FF&E Tracker

A web app for FF&E (furniture, fixtures & equipment) requests, approvals, inventory and attic stock across resort **projects**, each with its own **sub-projects**:

- **Black Desert Resort**: The Terrace, The Cove, Resort Center, Pickleball, Waterpark
- **Cornerstone**, **Sweetens Cove**, **Marcella** (managers add their sub-projects in the app)

## What's in it

| Area | What it does |
|---|---|
| **Projects** | After signing in, everyone picks the project they're working on. Then they click into sub-projects (open requests, inventory, low stock) with **back arrows** and **‹ › arrows** to browse between them. Managers add projects and sub-projects right on these pages. |
| **Requests** | Detailed tickets: sub-project, building(s), room(s), what's needed, FF&E tag/spec, quantity, needed-by date, and photos marked *Concept image* or *Proof of damage*. Each gets a number like `REQ-0012`. If someone submits something that's already been requested, the app shows the matching ticket first. |
| **Notes on everything** | Requests, inventory items and emailed requests all have notes. **Hover the note icon to read them**, click to add or edit. |
| **Follow-ups** | Set a follow-up date and note on any ticket, including rejected or cancelled ones, or on a dismissed email; it can go straight onto your action items. Filters for “Rejected & cancelled” and “Has a follow-up”, plus a dashboard tile for follow-ups due this week. |
| **Email Requests** (separate tab) | Emails sent to an FF&E inbox become draft tickets automatically (photos included). Anything already submitted, or already emailed, is filed under **Auto-matched duplicates**, so managers review each request once. **Dismissed** emails stay visible with who dismissed them and why, so anyone can follow up, and managers can bring them back or create a ticket anyway. |
| **My Outlook Report** | **Anyone** can connect their own Outlook. The app reads their recent inbox (in their browser) and reports which FF&E requests are coming up: what's needed when, what's urgent, and whether each one is already a ticket. New ones can be sent to Email Requests with one click; the report can be copied or exported. |
| **Files & Assistant** | Upload spreadsheets and PDFs (punch lists, inspection reports, spec books) from any sub-project page or the Files page. Files are kept with the project so anyone can open them later. The assistant reads them and proposes requests, **each routed to the sub-project it belongs to**, skips anything already requested, and lets you **chat** about how to organize it before you confirm. Long files are read in sections; scanned PDFs up to 4 MB are supported. |
| **Approvals** (managers) | **Swipe review**: one card at a time, ✓ / drag right to approve, ✗ / drag left to reject, *Later* to skip, *Undo*. Or switch to the list view. Then *In Progress* → *Completed*; rejected or cancelled tickets can be reopened. |
| **Inventory & Attic Stock** | Per-sub-project views (attic stock vs. inventory, low-stock warnings against par levels). **Take out** stock and optionally record where it went; return/add stock; full movement log; Excel export with one tab per sub-project. |
| **Import Spreadsheet** (managers) | Excel/CSV for inventory or requests, sorted into sub-projects by column, tab name or row text, with a full preview first. |
| **My Action Items & Sheet Builder** | A private checklist, personal/combined Excel exports, and plain-English custom sheets you can pin to your dashboard. |
| **Team & Roles / Settings** (managers) | Invite people by email, change roles, remove people. Rename, reorder and archive projects and sub-projects; edit the option lists used in forms (categories, storage locations, units). |
| **How to Use** | A written guide for each part of the app and a **guided walkthrough** that steps through the real screens in order, offered automatically the first time someone signs in. |

**Roles:** *Managers* approve, review emails, manage inventory, import spreadsheets, and manage projects, settings and the team. *Owner Relations* see everything, submit requests, take stock out (logged under their name), add notes and follow-ups, and keep their own action items. The database enforces these rules, not just the screens.

## Try it first (Demo mode)

With `public/js/config.js` left blank, the app runs in **Demo mode** with sample data: tickets, inventory, three emails (one new, one auto-matched duplicate, one filtered-out newsletter) and a sample Outlook inbox for the report. Pick a Manager or Owner Relations user and click around. Demo data lives only in that browser.

Preview on your computer: `npx serve public` in this folder, then open the address it prints.

## Going live (about 30 minutes)

You need **Supabase** (free tier: logins, database, photos) and **Netlify** (hosting and the server functions).

### 1. Database — Supabase
1. [supabase.com](https://supabase.com) → **New project**.
2. **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**. (It's safe to run again later.)
3. Copy the **Project URL** (the **Connect** button at the top) and from **Project Settings → API Keys** the **publishable** key (`sb_publishable_…`, or the legacy *anon* key) and the **secret** key (`sb_secret_…`, or the legacy *service_role* key). Keep the secret key private: it only goes into Netlify.
4. Put the URL and publishable key into `public/js/config.js`.

### 2. Hosting — Netlify
1. Push this folder to GitHub, then in Netlify: **Add new site → Import an existing project** → pick the repo → **Deploy** (settings come from `netlify.toml`).
2. **Site configuration → Environment variables**, add:

| Key | Value | Used for |
|---|---|---|
| `SUPABASE_URL` | Project URL | all functions |
| `SUPABASE_PUBLISHABLE_KEY` | publishable key (`sb_publishable_…`) | AI features: checks the person is signed in |
| `SUPABASE_SECRET_KEY` | secret key (`sb_secret_…`) | invites, removing users, email intake |

(The older names `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` also work.)
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

**Verification codes:** new accounts confirm their email by typing a code. In Supabase → **Authentication → Emails → Templates → Confirm signup**, add this line to the message so the code is included (the link keeps working too):
```html
<p>Your verification code: <strong>{{ .Token }}</strong></p>
```
For reliable delivery to your team, set up your own sender under **Authentication → Emails → SMTP Settings** (e.g. your Microsoft 365 mailbox or Resend); Supabase's built-in sender is only for testing.

**Updating the database:** when a new version adds features (like Files), re-run all of `supabase/schema.sql` in the SQL Editor. It's safe to run again and keeps your data.

### 4. Hook up the shared FF&E inbox
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

### 5. Let people connect their Outlook (My Outlook Report)
An IT admin does this once in Microsoft Entra ID (Azure AD), about 10 minutes:
1. [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New registration**. Name it “FF&E Tracker”, accounts in *this organizational directory only*.
2. Under **Redirect URI**, choose **Single-page application (SPA)** and enter `https://YOUR-SITE.netlify.app/auth-redirect.html`.
3. **API permissions → Add → Microsoft Graph → Delegated → Mail.Read**. Click **Grant admin consent** (or leave it so each person approves for themselves).
4. Copy the **Application (client) ID** and **Directory (tenant) ID** into `public/js/config.js` as `MS_CLIENT_ID` and `MS_TENANT_ID`, then redeploy.

Each person then clicks **Connect Outlook** on *My Outlook Report*. Mail is read directly from Microsoft into their browser. Only emails that look like FF&E requests (up to 60) are sent to the AI assistant to be read, and nothing is stored unless the person sends an email to Email Requests. Without `ANTHROPIC_API_KEY`, the built-in reader is used instead.

## Folder layout
```
public/                       the website (what Netlify publishes)
  index.html, css/styles.css, auth-redirect.html (Outlook sign-in return page)
  js/config.js                Supabase keys + settings
  js/app.js                   shell, dashboard, requests, approvals, action items, sheet builder
  js/projects.js              projects → sub-projects pages, back arrows
  js/notes.js                 notes (hover to read) and follow-ups
  js/settings.js              projects, sub-projects and option lists
  js/outlook.js               My Outlook Report
  js/help.js                  How to Use guide and walkthrough
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
  email-report.mjs            reads a person's Outlook emails for their report
supabase/schema.sql           database, security rules, photo storage
```

## Notes
- **AI:** uses Claude Opus 5.5 at low effort, a fraction of a cent per email or sheet. Without `ANTHROPIC_API_KEY`, the built-in rules handle emails and sheets instead.
- **Photos** are resized before upload and stored privately, with view links that expire after an hour.
- **Spreadsheet tips:** a *Sub-project* column, or one tab per sub-project, gives the cleanest import. Download the templates from the Import page.
- **Colors** are light pink and light gray, with a matching dark mode that follows each person's device setting.
