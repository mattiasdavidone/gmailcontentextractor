# Gmail Contact Extractor

Gmail Contact Extractor scans inbox messages, filters obvious non-human senders, extracts contact details with OpenAI, and writes unique contacts to a linked Google Sheet.

The current processing model is deliberately database-first:

1. Gmail is the source of messages.
2. Supabase stores processing state and contact identity.
3. Google Sheets is the destination, not the source of truth for deduplication.
4. A contact is written to Sheets only when it is new for the connected Gmail account or needs recovery after a previous write interrupted.
5. Gmail labels are not written by the current processor.

## Architecture

The app is a Next.js application using:

- **Next.js 16** with the App Router
- **Supabase Postgres** for app accounts, sessions, Gmail connections, run state, email processing state, and extracted contacts
- **Google OAuth** for Gmail and Google Sheets access
- **Google Gmail API** for inbox reads
- **Google Sheets API** for linking a destination and writing contacts
- **OpenAI** for sender classification and contact extraction

Authentication is implemented with a small application account/session layer in `lib/auth.ts`. Session cookies are HTTP-only, signed by an opaque random token, and persisted as SHA-256 token hashes in `user_sessions`.

## Processing flow

Each run is started through `/api/run/start`. The client then advances one email at a time through `/api/run/next`.

For each candidate message, the processor:

1. Lists inbox messages from Gmail.
2. Uses Supabase `email_logs` to find work that is new, failed, or explicitly reset.
3. Atomically claims the message with the `claim_email_processing` RPC.
4. Reads only the Gmail message metadata needed for processing.
5. Checks Supabase for an existing contact.
6. Classifies the sender with OpenAI.
7. Skips non-human senders without making a Google Sheets request.
8. Extracts contact data for human senders.
9. Deduplicates again through the database.
10. Writes the contact to the configured Contacts tab when necessary.
11. Records the final processing status and increments run totals atomically.

The database functions `claim_email_processing` and `upsert_extracted_contact` are the concurrency controls for this flow.

## Google Sheets behavior and quota protection

The app used to read every configured spreadsheet repeatedly while processing inbox mail. That design could exhaust the Google Sheets per-user read quota.

The current implementation avoids that steady-state pattern:

- linking a spreadsheet may read its structure and import existing contacts once;
- normal processing does not scan the spreadsheet for every email;
- a new contact is appended with one Sheets write;
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

The current processor does not modify Gmail messages or labels, so it does not require `gmail.modify`.

## Environment variables

Create a local `.env.local` containing:

```text
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OPENAI_API_KEY=...
```

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

Set all required environment variables in the Vercel project before deploying. Make sure the Google OAuth callback URL matches the deployment hostname.

Vercel can apply deployment/build rate limits independently of GitHub Actions. A successful repository build does not guarantee that a new Vercel deployment can be started immediately.

## Useful files

`app/page.tsx` — dashboard and client-side run loop.

`app/api/run/next/route.js` — authoritative email processing path.

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
