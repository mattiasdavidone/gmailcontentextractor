# Gmail Contact Extractor

Gmail Contact Extractor scans inbox messages, filters obvious non-human senders, extracts contact details with OpenAI, and writes unique contacts to a linked Google Sheet.

The current processing model is deliberately database-first:

1. Gmail is the source of messages.
2. Supabase stores run state, durable email jobs, Sheets outbox jobs, and contact identity.
3. Google Sheets is the destination, not the source of truth for deduplication.
4. Gmail ingestion is paginated and resumable; processing is claim-based and restartable.
5. Contacts are persisted to Supabase before they are queued for Sheets.
6. Gmail messages and labels are never modified by the processing subsystem.

## Architecture

The app is a Next.js application using:

- **Next.js 16** with the App Router
- **Supabase Postgres** for app accounts, sessions, Gmail connections, run state, email processing state, and extracted contacts
- **Google OAuth** for Gmail and Google Sheets access
- **Google Gmail API** for inbox reads
- **Google Sheets API** for linking a destination and writing contacts
- **OpenAI** for sender classification and contact extraction

Authentication is implemented with a small application account/session layer in `lib/auth.ts`. Session cookies are HTTP-only and contain an opaque random token; only its SHA-256 hash is persisted in `user_sessions`.

## Processing flow

Each run is started through `/api/run/start`. A Vercel Cron tick advances ingestion, Gmail processing, and Sheets output through the durable worker endpoints; the browser only starts/cancels the run and polls `/api/run/status`.

The new processing subsystem:

1. Lists Gmail message IDs in pages of up to 500.
2. Enqueues message IDs into `run_email_jobs` with a unique `(run_id, message_id)` key.
3. Claims jobs with `FOR UPDATE SKIP LOCKED` and a worker lease.
4. Reads only the Gmail metadata needed for extraction.
5. Deterministically rejects obvious automated senders before using OpenAI.
6. Uses one structured OpenAI analysis call for human classification and contact extraction when needed.
7. Persists contacts to Supabase before any spreadsheet write.
8. Queues spreadsheet output in `run_sheet_jobs`.
9. Writes Sheets rows in bounded batches with durable retry state.
10. Marks the run complete only when ingestion is closed and all retryable email and Sheets jobs are resolved.

The processing subsystem never modifies Gmail messages or labels. The legacy one-email `/api/run/next` endpoint has been retired.

## Google Sheets behavior and quota protection

The app used to read every configured spreadsheet repeatedly while processing inbox mail. That design could exhaust the Google Sheets per-user read quota.

The current implementation avoids that steady-state pattern:

- linking a spreadsheet may read its structure and import existing contacts once;
- normal processing does not scan the spreadsheet for every email;
- a new contact is appended with one Sheets write;
- contact values are written as literal `RAW` data rather than interpreted as formulas;
- only recovery of a previously interrupted write may read the Message ID column;
- the Google client disables its own automatic Sheets retries;
- application code retries transient 503 responses with bounded backoff;
- 429 quota responses are surfaced at the email/run boundary so the client can wait before trying again.

Google's Sheets API documents a per-user rate limit and recommends exponential backoff for time-based quota errors. See the official documentation linked below.

## Google OAuth scopes

The app currently requests only:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/userinfo.email`

The Gmail processing path is intentionally read-only. It does not request or use `gmail.modify`, label-write scopes, or Gmail mutation endpoints. Google documents `gmail.readonly` as a restricted scope for viewing Gmail messages/settings, while `gmail.modify` grants broader mail access and mutation capabilities.

## Environment variables

Create a local `.env.local` containing:

```text
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OPENAI_API_KEY=...
CRON_SECRET=...
```

`CRON_SECRET` is a server-side random secret used to authenticate the Vercel Cron worker calls. Vercel recommends using a random value of at least 16 characters for this variable.

The service-role key and Google client secret are server-side secrets. Do not expose them to client-side code or commit them to Git.

## Local setup

Requirements:

- Node.js 22
- npm
- a Supabase project
- a Google Cloud OAuth client
- an OpenAI API key

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Google Cloud setup

Create a Google OAuth 2.0 Web application client and enable:

- Gmail API
- Google Sheets API

Add the callback URL that matches the app origin:

Local:

```text
http://localhost:3000/api/auth/callback/google
```

Production:

```text
https://gmailcontentextractor.vercel.app/api/auth/callback/google
```

The application constructs the callback URL from the request origin, so preview deployments use the corresponding preview host when OAuth is configured for them.

## Supabase migrations

Database changes live in:

```text
supabase/migrations/
```

The migration sequence establishes:

- application users and sessions;
- run and spreadsheet history;
- user-owned Gmail connections;
- processing and extracted-contact state;
- normalized contact email deduplication;
- atomic email claiming;
- atomic contact upsert;
- retryable reset state;
- a single active run per connection.

Apply the migrations to the configured Supabase project before using the application.

## Dependency and build checks

The repository has GitHub Actions for:

- building with Node 22;
- keeping `package-lock.json` synchronized;
- checking dependencies with `npm audit`;
- attempting safe lockfile-only vulnerability fixes before the audit is evaluated.

The dependency audit evaluates the post-fix vulnerability report and fails when high or critical vulnerabilities remain.

## Deployment

The project is configured for Vercel as a Next.js application.

Set all required environment variables in the Vercel project before deploying, including `CRON_SECRET`. The repository defines `/api/run/cron` as a once-per-minute scheduler. Vercel permits once-per-minute cron jobs on Pro and Enterprise; Hobby cron jobs are limited to once per day, so a Hobby deployment cannot provide continuous background advancement for a 1,000-message run. Make sure the Google OAuth callback URL matches the deployment hostname.

Vercel can apply deployment/build rate limits independently of GitHub Actions. A successful repository build does not guarantee that a new Vercel deployment can be started immediately.

## Useful files

`app/page.tsx` — dashboard; starts/cancels runs and polls durable status only.

`app/api/run/start/route.ts` — run creation.

`app/api/run/ingest/route.ts` — resumable Gmail ingestion.

`app/api/run/status/route.ts` — durable run progress.

`app/api/run/sheets/route.ts` — durable batched Sheets writer.

`lib/run-worker.ts` — worker lease, claim, retry, and completion helpers.

`lib/google-sheets.ts` — Sheets tab management, quota handling, and contact writes.

`lib/auth.ts` — application sessions and password verification.

`supabase/migrations/` — database architecture and processing RPCs.

`.github/workflows/build.yml` — build and lockfile maintenance.

`.github/workflows/dependency-audit.yml` — dependency audit.

## Official references

- Next.js: https://nextjs.org/docs
- Google Sheets API usage limits: https://developers.google.com/workspace/sheets/api/limits
- Google Sheets batch requests: https://developers.google.com/workspace/sheets/api/guides/batchupdate
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google OAuth for web server applications: https://developers.google.com/identity/protocols/oauth2/web-server
- Vercel deployment limits: https://vercel.com/docs/limits
