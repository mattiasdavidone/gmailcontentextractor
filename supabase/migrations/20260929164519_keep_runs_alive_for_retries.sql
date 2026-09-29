create or replace function public.mark_run_ingestion_complete(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.tool_runs set ingestion_complete=true,last_heartbeat_at=now()
  where id=p_run_id and status='running';

  if found then
    update public.tool_runs r
    set status='completed',completed_at=coalesce(r.completed_at,now()),
        worker_id=null,worker_started_at=null,worker_lease_expires_at=null,
        sheet_worker_id=null,sheet_worker_started_at=null,sheet_worker_lease_expires_at=null
    where r.id=p_run_id and r.status='running' and r.ingestion_complete=true
      and not exists (
        select 1 from public.run_email_jobs j
        where j.run_id=r.id
          and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
      )
      and not exists (
        select 1 from public.run_sheet_jobs j
        where j.run_id=r.id
          and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
      );
    return true;
  end if;
  return false;
end; $$;

create or replace function public.finish_run_email_job(p_job_id uuid,p_worker_id text,p_status text,p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run_id uuid; v_attempts integer;
begin
  if p_status not in ('completed','skipped','failed') then raise exception 'invalid terminal status: %',p_status; end if;

  select j.run_id,j.attempts into v_run_id,v_attempts
  from public.run_email_jobs j
  where j.id=p_job_id and j.status='processing' and j.claimed_by=p_worker_id
  for update;

  if v_run_id is null then return false; end if;

  update public.run_email_jobs
  set status=p_status,
      completed_at=case when p_status in ('completed','skipped') then now() else null end,
      available_at=case when p_status='failed'
        then now()+make_interval(secs=>least(300,greatest(5,power(2,greatest(v_attempts,1))::integer)))
        else available_at end,
      claimed_at=null,claimed_by=null,last_error=nullif(left(coalesce(p_error,''),4000),''),updated_at=now()
  where id=p_job_id;

  update public.tool_runs r
  set queued_message_count=(select count(*) from public.run_email_jobs j where j.run_id=r.id),
      completed_message_count=(select count(*) from public.run_email_jobs j where j.run_id=r.id and j.status in ('completed','skipped')),
      failed_message_count=(select count(*) from public.run_email_jobs j where j.run_id=r.id and j.status='failed'),
      last_heartbeat_at=now()
  where r.id=v_run_id and r.status='running';

  update public.tool_runs r
  set status='completed',completed_at=coalesce(r.completed_at,now()),
      worker_id=null,worker_started_at=null,worker_lease_expires_at=null,
      sheet_worker_id=null,sheet_worker_started_at=null,sheet_worker_lease_expires_at=null
  where r.id=v_run_id and r.status='running' and r.ingestion_complete=true
    and not exists (
      select 1 from public.run_email_jobs j
      where j.run_id=r.id
        and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
    )
    and not exists (
      select 1 from public.run_sheet_jobs j
      where j.run_id=r.id
        and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
    );
  return true;
end; $$;

create or replace function public.finish_run_sheet_job(p_job_id uuid,p_worker_id text,p_status text,p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run_id uuid; v_attempts integer;
begin
  if p_status not in ('completed','skipped','failed') then raise exception 'invalid sheet terminal status: %',p_status; end if;

  select j.run_id,j.attempts into v_run_id,v_attempts
  from public.run_sheet_jobs j
  where j.id=p_job_id and j.status='processing' and j.claimed_by=p_worker_id
  for update;

  if v_run_id is null then return false; end if;

  update public.run_sheet_jobs
  set status=p_status,
      completed_at=case when p_status in ('completed','skipped') then now() else null end,
      available_at=case when p_status='failed'
        then now()+make_interval(secs=>least(600,greatest(10,power(2,greatest(v_attempts,1))::integer)))
        else available_at end,
      claimed_at=null,claimed_by=null,last_error=nullif(left(coalesce(p_error,''),4000),''),updated_at=now()
  where id=p_job_id;

  update public.tool_runs r
  set sheet_queued_count=(select count(*) from public.run_sheet_jobs j where j.run_id=r.id),
      sheet_completed_count=(select count(*) from public.run_sheet_jobs j where j.run_id=r.id and j.status in ('completed','skipped')),
      sheet_failed_count=(select count(*) from public.run_sheet_jobs j where j.run_id=r.id and j.status='failed')
  where r.id=v_run_id;

  update public.tool_runs r
  set status='completed',completed_at=coalesce(r.completed_at,now()),
      worker_id=null,worker_started_at=null,worker_lease_expires_at=null,
      sheet_worker_id=null,sheet_worker_started_at=null,sheet_worker_lease_expires_at=null
  where r.id=v_run_id and r.status='running' and r.ingestion_complete=true
    and not exists (
      select 1 from public.run_email_jobs j
      where j.run_id=r.id
        and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
    )
    and not exists (
      select 1 from public.run_sheet_jobs j
      where j.run_id=r.id
        and (j.status in ('pending','processing') or (j.status='failed' and j.attempts < j.max_attempts))
    );
  return true;
end; $$;
