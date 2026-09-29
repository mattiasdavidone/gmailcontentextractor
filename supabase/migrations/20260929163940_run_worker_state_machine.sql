alter table public.tool_runs
  add column if not exists ingestion_complete boolean not null default false,
  add column if not exists worker_lease_expires_at timestamptz;

drop function if exists public.finish_run_email_job(uuid, text, text, text);
drop function if exists public.acquire_run_worker(uuid, text, integer);
drop function if exists public.release_run_worker(uuid, text);
drop function if exists public.mark_run_ingestion_complete(uuid);

create or replace function public.acquire_run_worker(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'lease must be between 30 and 900 seconds';
  end if;
  update public.tool_runs
  set
    worker_id = p_worker_id,
    worker_started_at = now(),
    worker_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    last_heartbeat_at = now()
  where id = p_run_id
    and status = 'running'
    and (
      worker_id is null
      or worker_id = p_worker_id
      or worker_lease_expires_at is null
      or worker_lease_expires_at < now()
    );
  return found;
end;
$$;

revoke execute on function public.acquire_run_worker(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.acquire_run_worker(uuid, text, integer) to service_role;

create or replace function public.release_run_worker(
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
    worker_id = null,
    worker_started_at = null,
    worker_lease_expires_at = null
  where id = p_run_id
    and status = 'running'
    and worker_id = p_worker_id;
  return found;
end;
$$;

revoke execute on function public.release_run_worker(uuid, text) from public, anon, authenticated;
grant execute on function public.release_run_worker(uuid, text) to service_role;

create or replace function public.mark_run_ingestion_complete(
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tool_runs
  set ingestion_complete = true, last_heartbeat_at = now()
  where id = p_run_id and status = 'running';

  if found then
    update public.tool_runs r
    set
      status = 'completed',
      completed_at = coalesce(r.completed_at, now()),
      worker_id = null,
      worker_started_at = null,
      worker_lease_expires_at = null
    where r.id = p_run_id
      and r.status = 'running'
      and r.ingestion_complete = true
      and not exists (
        select 1 from public.run_email_jobs j
        where j.run_id = r.id
          and j.status in ('pending', 'processing')
      );
    return true;
  end if;
  return false;
end;
$$;

revoke execute on function public.mark_run_ingestion_complete(uuid) from public, anon, authenticated;
grant execute on function public.mark_run_ingestion_complete(uuid) to service_role;

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
    worker_lease_expires_at = now() + interval '2 minutes',
    worker_id = p_worker_id
  where id = p_run_id and status = 'running' and worker_id = p_worker_id;
  return found;
end;
$$;

revoke execute on function public.heartbeat_tool_run(uuid, text) from public, anon, authenticated;
grant execute on function public.heartbeat_tool_run(uuid, text) to service_role;

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
declare
  v_run_id uuid;
  v_failed_attempts integer;
begin
  if p_status not in ('completed', 'skipped', 'failed') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  select j.run_id, j.attempts
  into v_run_id, v_failed_attempts
  from public.run_email_jobs j
  where j.id = p_job_id
    and j.status = 'processing'
    and j.claimed_by = p_worker_id
  for update;

  if v_run_id is null then
    return false;
  end if;

  update public.run_email_jobs
  set
    status = p_status,
    completed_at = case when p_status in ('completed', 'skipped') then now() else null end,
    available_at = case
      when p_status = 'failed' then
        now() + make_interval(secs => least(300, greatest(5, power(2, greatest(v_failed_attempts, 1))::integer)))
      else available_at
    end,
    claimed_at = null,
    claimed_by = null,
    last_error = nullif(left(coalesce(p_error, ''), 4000), ''),
    updated_at = now()
  where id = p_job_id;

  update public.tool_runs r
  set
    queued_message_count = (select count(*) from public.run_email_jobs j where j.run_id = r.id),
    completed_message_count = (
      select count(*) from public.run_email_jobs j
      where j.run_id = r.id and j.status in ('completed', 'skipped')
    ),
    failed_message_count = (
      select count(*) from public.run_email_jobs j
      where j.run_id = r.id and j.status = 'failed'
    ),
    last_heartbeat_at = now()
  where r.id = v_run_id and r.status = 'running';

  update public.tool_runs r
  set
    status = 'completed',
    completed_at = coalesce(r.completed_at, now()),
    worker_id = null,
    worker_started_at = null,
    worker_lease_expires_at = null
  where r.id = v_run_id
    and r.status = 'running'
    and r.ingestion_complete = true
    and not exists (
      select 1 from public.run_email_jobs j
      where j.run_id = r.id and j.status in ('pending', 'processing')
    );

  return true;
end;
$$;

revoke execute on function public.finish_run_email_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_run_email_job(uuid, text, text, text) to service_role;
