create or replace function public.fail_run_email_job_permanently(
  p_job_id uuid,
  p_worker_id text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_run_id uuid;
begin
  update public.run_email_jobs
  set
    status = 'failed',
    attempts = max_attempts,
    claimed_at = null,
    claimed_by = null,
    last_error = nullif(left(coalesce(p_error, 'Permanent processing failure.'), 4000), ''),
    updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and claimed_by = p_worker_id
  returning run_id into v_run_id;

  if v_run_id is null then return false; end if;

  update public.tool_runs r
  set
    queued_message_count = (select count(*) from public.run_email_jobs j where j.run_id = r.id),
    completed_message_count = (
      select count(*) from public.run_email_jobs j
      where j.run_id = r.id and j.status in ('completed','skipped')
    ),
    failed_message_count = (
      select count(*) from public.run_email_jobs j
      where j.run_id = r.id and j.status = 'failed'
    ),
    last_heartbeat_at = now()
  where r.id = v_run_id and r.status = 'running';

  return true;
end;
$$;

revoke execute on function public.fail_run_email_job_permanently(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fail_run_email_job_permanently(uuid,text,text) to service_role;

create or replace function public.fail_run_sheet_job_permanently(
  p_job_id uuid,
  p_worker_id text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_run_id uuid;
begin
  update public.run_sheet_jobs
  set
    status = 'failed',
    attempts = max_attempts,
    claimed_at = null,
    claimed_by = null,
    last_error = nullif(left(coalesce(p_error, 'Permanent spreadsheet failure.'), 4000), ''),
    updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and claimed_by = p_worker_id
  returning run_id into v_run_id;

  if v_run_id is null then return false; end if;

  update public.tool_runs r
  set
    sheet_queued_count = (select count(*) from public.run_sheet_jobs j where j.run_id = r.id),
    sheet_completed_count = (
      select count(*) from public.run_sheet_jobs j
      where j.run_id = r.id and j.status in ('completed','skipped')
    ),
    sheet_failed_count = (
      select count(*) from public.run_sheet_jobs j
      where j.run_id = r.id and j.status = 'failed'
    )
  where r.id = v_run_id;

  return true;
end;
$$;

revoke execute on function public.fail_run_sheet_job_permanently(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fail_run_sheet_job_permanently(uuid,text,text) to service_role;
