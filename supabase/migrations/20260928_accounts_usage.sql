create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists user_sessions_user_id_idx
  on public.user_sessions(user_id);

create index if not exists user_sessions_expires_at_idx
  on public.user_sessions(expires_at);

create table if not exists public.tool_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  connection_id uuid null references public.google_connections(id) on delete set null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  emails_scanned integer not null default 0,
  bots_filtered integer not null default 0,
  contacts_extracted integer not null default 0
);

create index if not exists tool_runs_user_id_idx
  on public.tool_runs(user_id);

create table if not exists public.linked_spreadsheets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  spreadsheet_id text not null,
  title text not null,
  spreadsheet_url text null,
  first_linked_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique(user_id, spreadsheet_id)
);

create index if not exists linked_spreadsheets_user_id_idx
  on public.linked_spreadsheets(user_id);

alter table public.google_connections
  add column if not exists user_id uuid references public.app_users(id) on delete cascade;

alter table public.extracted_contacts
  add column if not exists connection_id uuid references public.google_connections(id) on delete cascade,
  add column if not exists message_id text;

create unique index if not exists extracted_contacts_connection_message_key
  on public.extracted_contacts(connection_id, message_id);

alter table public.email_logs
  add column if not exists run_id uuid references public.tool_runs(id) on delete set null;

alter table public.extracted_contacts
  add column if not exists run_id uuid references public.tool_runs(id) on delete set null;

create index if not exists google_connections_user_id_idx
  on public.google_connections(user_id);

create index if not exists email_logs_run_id_idx
  on public.email_logs(run_id);

create index if not exists extracted_contacts_run_id_idx
  on public.extracted_contacts(run_id);

alter table public.google_connections
  drop constraint if exists google_connections_google_email_key;

create unique index if not exists google_connections_user_email_key
  on public.google_connections(user_id, google_email);


-- Existing google_connections tables may predate the app account migration.
-- Ensure user_id points at app_users rather than the legacy profiles table.
alter table public.google_connections
  drop constraint if exists google_connections_user_id_fkey;

alter table public.google_connections
  add constraint google_connections_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

-- Existing log/contact user_id columns are legacy profile references. The new
-- account-aware run model scopes these records through connection_id/run_id.


alter table public.extracted_contacts
  add column if not exists sheet_written boolean not null default false;
