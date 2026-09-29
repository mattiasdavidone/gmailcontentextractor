alter table public.tool_runs
  add column if not exists sheet_queued_count integer not null default 0,
  add column if not exists sheet_completed_count integer not null default 0,
  add column if not exists sheet_failed_count integer not null default 0,
  add column if not exists sheet_worker_id text,
  add column if not exists sheet_worker_started_at timestamptz,
  add column if not exists sheet_worker_lease_expires_at timestamptz;

create table if not exists public.run_sheet_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tool_runs(id) on delete cascade,
  connection_id uuid not null references public.google_connections(id) on delete cascade,
  contact_id uuid not null references public.extracted_contacts(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint run_sheet_jobs_status_check check (status in ('pending','processing','completed','skipped','failed')),
  constraint run_sheet_jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 20)
);

alter table public.run_sheet_jobs enable row level security;

create unique index if not exists run_sheet_jobs_run_contact_key on public.run_sheet_jobs(run_id, contact_id);
create index if not exists run_sheet_jobs_claim_idx on public.run_sheet_jobs(run_id, status, available_at, created_at);
create index if not exists run_sheet_jobs_processing_idx on public.run_sheet_jobs(run_id, claimed_at) where status = 'processing';

create or replace function public.enqueue_run_sheet_job(p_run_id uuid,p_connection_id uuid,p_contact_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.run_sheet_jobs(run_id,connection_id,contact_id)
  select p_run_id,p_connection_id,c.id
  from public.extracted_contacts c
  where c.id=p_contact_id and c.connection_id=p_connection_id
  on conflict (run_id,contact_id) do nothing;

  update public.tool_runs r
  set sheet_queued_count=(select count(*) from public.run_sheet_jobs j where j.run_id=r.id)
  where r.id=p_run_id;

  return found;
end; $$;

revoke execute on function public.enqueue_run_sheet_job(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.enqueue_run_sheet_job(uuid,uuid,uuid) to service_role;

create or replace function public.acquire_run_sheet_worker(p_run_id uuid,p_worker_id text,p_lease_seconds integer default 120)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'sheet worker_id is required'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then raise exception 'sheet lease must be between 30 and 900 seconds'; end if;

  update public.tool_runs
  set sheet_worker_id=p_worker_id,
      sheet_worker_started_at=now(),
      sheet_worker_lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
  where id=p_run_id and status='running'
    and (sheet_worker_id is null or sheet_worker_id=p_worker_id or sheet_worker_lease_expires_at is null or sheet_worker_lease_expires_at < now());
  return found;
end; $$;

revoke execute on function public.acquire_run_sheet_worker(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.acquire_run_sheet_worker(uuid,text,integer) to service_role;

create or replace function public.release_run_sheet_worker(p_run_id uuid,p_worker_id text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.tool_runs
  set sheet_worker_id=null,sheet_worker_started_at=null,sheet_worker_lease_expires_at=null
  where id=p_run_id and status='running' and sheet_worker_id=p_worker_id;
  return found;
end; $$;

revoke execute on function public.release_run_sheet_worker(uuid,text) from public, anon, authenticated;
grant execute on function public.release_run_sheet_worker(uuid,text) to service_role;

create or replace function public.claim_run_sheet_jobs(p_run_id uuid,p_worker_id text,p_limit integer default 25)
returns table(id uuid,connection_id uuid,contact_id uuid,attempts integer,max_attempts integer)
language plpgsql security definer set search_path = public as $$
begin
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'sheet worker_id is required'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'sheet claim limit must be between 1 and 50'; end if;

  return query
  with claimed as (
    select j.id
    from public.run_sheet_jobs j
    join public.tool_runs r on r.id=j.run_id
    where j.run_id=p_run_id and r.status='running'
      and j.status in ('pending','failed') and j.available_at <= now() and j.attempts < j.max_attempts
    order by j.created_at,j.id
    for update of j skip locked
    limit p_limit
  )
  update public.run_sheet_jobs j
  set status='processing',attempts=j.attempts+1,claimed_at=now(),claimed_by=p_worker_id,updated_at=now(),last_error=null
  from claimed c
  where j.id=c.id
  returning j.id,j.connection_id,j.contact_id,j.attempts,j.max_attempts;
end; $$;

revoke execute on function public.claim_run_sheet_jobs(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.claim_run_sheet_jobs(uuid,text,integer) to service_role;

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
    and not exists (select 1 from public.run_email_jobs j where j.run_id=r.id and j.status in ('pending','processing'))
    and not exists (select 1 from public.run_sheet_jobs j where j.run_id=r.id and j.status in ('pending','processing'));
  return true;
end; $$;

revoke execute on function public.finish_run_sheet_job(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_run_sheet_job(uuid,text,text,text) to service_role;

create or replace function public.requeue_stale_run_sheet_jobs(p_run_id uuid,p_stale_after_seconds integer default 900)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if p_stale_after_seconds < 60 or p_stale_after_seconds > 86400 then raise exception 'sheet stale timeout must be between 60 and 86400 seconds'; end if;
  update public.run_sheet_jobs
  set status=case when attempts < max_attempts then 'pending' else 'failed' end,
      available_at=now(),claimed_at=null,claimed_by=null,
      last_error=coalesce(last_error,'Spreadsheet write lease expired.'),updated_at=now()
  where run_id=p_run_id and status='processing' and claimed_at is not null
    and claimed_at < now()-make_interval(secs=>p_stale_after_seconds);
  get diagnostics v_count=row_count;
  return v_count;
end; $$;

revoke execute on function public.requeue_stale_run_sheet_jobs(uuid,integer) from public, anon, authenticated;
grant execute on function public.requeue_stale_run_sheet_jobs(uuid,integer) to service_role;

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
      and not exists (select 1 from public.run_email_jobs j where j.run_id=r.id and j.status in ('pending','processing'))
      and not exists (select 1 from public.run_sheet_jobs j where j.run_id=r.id and j.status in ('pending','processing'));
    return true;
  end if;
  return false;
end; $$;

revoke execute on function public.mark_run_ingestion_complete(uuid) from public, anon, authenticated;
grant execute on function public.mark_run_ingestion_complete(uuid) to service_role;

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
    and not exists (select 1 from public.run_email_jobs j where j.run_id=r.id and j.status in ('pending','processing'))
    and not exists (select 1 from public.run_sheet_jobs j where j.run_id=r.id and j.status in ('pending','processing'));
  return true;
end; $$;

revoke execute on function public.finish_run_email_job(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_run_email_job(uuid,text,text,text) to service_role;
