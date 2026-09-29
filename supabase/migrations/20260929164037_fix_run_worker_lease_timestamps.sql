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
