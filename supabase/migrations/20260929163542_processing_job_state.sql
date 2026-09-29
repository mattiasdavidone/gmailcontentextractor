alter table public.tool_runs
  add column if not exists target_email_count integer not null default 1000,
  add column if not exists discovered_message_count integer not null default 0,
  add column if not exists queued_message_count integer not null default 0,
  add column if not exists completed_message_count integer not null default 0,
  add column if not exists failed_message_count integer not null default 0,
  add column if not exists gmail_query text not null default 'in:inbox',
  add column if not exists gmail_page_token text,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists worker_id text,
  add column if not exists worker_started_at timestamptz;

alter table public.tool_runs
  drop constraint if exists tool_runs_target_email_count_check;

alter table public.tool_runs
  add constraint tool_runs_target_email_count_check
  check (target_email_count between 1 and 100000);

create table if not exists public.run_email_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tool_runs(id) on delete cascade,
  connection_id uuid not null references public.google_connections(id) on delete cascade,
  message_id text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint run_email_jobs_status_check
    check (status in ('pending', 'processing', 'completed', 'skipped', 'failed')),
  constraint run_email_jobs_attempts_check
    check (attempts >= 0 and max_attempts between 1 and 20)
);

alter table public.run_email_jobs
  enable row level security;

create unique index if not exists run_email_jobs_run_message_key
  on public.run_email_jobs(run_id, message_id);

create index if not exists run_email_jobs_claim_idx
  on public.run_email_jobs(run_id, status, available_at, created_at);

create index if not exists run_email_jobs_connection_message_idx
  on public.run_email_jobs(connection_id, message_id);

create index if not exists run_email_jobs_processing_idx
  on public.run_email_jobs(run_id, claimed_at)
  where status = 'processing';

create or replace function public.enqueue_run_email_job(
  p_run_id uuid,
  p_connection_id uuid,
  p_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.run_email_jobs (
    run_id,
    connection_id,
    message_id
  )
  values (
    p_run_id,
    p_connection_id,
    p_message_id
  )
  on conflict (run_id, message_id) do nothing;

  return found;
end;
$$;

revoke execute on function public.enqueue_run_email_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.enqueue_run_email_job(uuid, uuid, text) to service_role;

create or replace function public.claim_run_email_jobs(
  p_run_id uuid,
  p_worker_id text,
  p_limit integer default 50
)
returns table(
  id uuid,
  connection_id uuid,
  message_id text,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  if p_limit < 1 or p_limit > 100 then
    raise exception 'claim limit must be between 1 and 100';
  end if;

  return query
  with claimed as (
    select j.id
    from public.run_email_jobs j
    join public.tool_runs r on r.id = j.run_id
    where j.run_id = p_run_id
      and r.status = 'running'
      and j.status in ('pending', 'failed')
      and j.available_at <= now()
      and j.attempts < j.max_attempts
    order by j.created_at, j.id
    for update of j skip locked
    limit p_limit
  )
  update public.run_email_jobs j
  set
    status = 'processing',
    attempts = j.attempts + 1,
    claimed_at = now(),
    claimed_by = p_worker_id,
    updated_at = now(),
    last_error = null
  from claimed c
  where j.id = c.id
  returning j.id, j.connection_id, j.message_id, j.attempts, j.max_attempts;
end;
$$;

revoke execute on function public.claim_run_email_jobs(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_run_email_jobs(uuid, text, integer) to service_role;

create or replace function public.finish_run_email_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('completed', 'skipped', 'failed') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  update public.run_email_jobs
  set
    status = p_status,
    completed_at = case
      when p_status in ('completed', 'skipped') then now()
      else null
    end,
    claimed_at = null,
    claimed_by = null,
    last_error = nullif(left(coalesce(p_error, ''), 4000), ''),
    updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and claimed_by = p_worker_id;

  return found;
end;
$$;

revoke execute on function public.finish_run_email_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_run_email_job(uuid, text, text, text) to service_role;

create or replace function public.requeue_stale_run_email_jobs(
  p_run_id uuid,
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_stale_after_seconds < 60 or p_stale_after_seconds > 86400 then
    raise exception 'stale timeout must be between 60 and 86400 seconds';
  end if;

  update public.run_email_jobs
  set
    status = case
      when attempts < max_attempts then 'pending'
      else 'failed'
    end,
    available_at = now(),
    claimed_at = null,
    claimed_by = null,
    last_error = coalesce(last_error, 'Processing lease expired.'),
    updated_at = now()
  where run_id = p_run_id
    and status = 'processing'
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_stale_after_seconds);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.requeue_stale_run_email_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.requeue_stale_run_email_jobs(uuid, integer) to service_role;

create or replace function public.heartbeat_tool_run(
  p_run_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tool_runs
  set
    last_heartbeat_at = now(),
    worker_id = p_worker_id
  where id = p_run_id
    and status = 'running';

  return found;
end;
$$;

revoke execute on function public.heartbeat_tool_run(uuid, text) from public, anon, authenticated;
grant execute on function public.heartbeat_tool_run(uuid, text) to service_role;

create or replace function public.recount_tool_run_queue(
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tool_runs r
  set
    queued_message_count = (
      select count(*) from public.run_email_jobs j where j.run_id = r.id
    ),
    completed_message_count = (
      select count(*)
      from public.run_email_jobs j
      where j.run_id = r.id
        and j.status in ('completed', 'skipped')
    ),
    failed_message_count = (
      select count(*)
      from public.run_email_jobs j
      where j.run_id = r.id
        and j.status = 'failed'
    )
  where r.id = p_run_id;

  return found;
end;
$$;

revoke execute on function public.recount_tool_run_queue(uuid) from public, anon, authenticated;
grant execute on function public.recount_tool_run_queue(uuid) to service_role;
