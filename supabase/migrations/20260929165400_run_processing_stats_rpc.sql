create or replace function public.record_run_processing_stats(
  p_run_id uuid,
  p_scanned integer default 0,
  p_filtered integer default 0,
  p_contacts integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tool_runs
  set
    emails_scanned = emails_scanned + greatest(coalesce(p_scanned, 0), 0),
    bots_filtered = bots_filtered + greatest(coalesce(p_filtered, 0), 0),
    contacts_extracted = contacts_extracted + greatest(coalesce(p_contacts, 0), 0),
    last_heartbeat_at = now()
  where id = p_run_id
    and status = 'running';

  return found;
end;
$$;

revoke execute on function public.record_run_processing_stats(uuid,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.record_run_processing_stats(uuid,integer,integer,integer)
  to service_role;
