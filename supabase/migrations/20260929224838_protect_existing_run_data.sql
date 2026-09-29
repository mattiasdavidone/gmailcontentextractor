create or replace function public.enqueue_run_email_jobs(
  p_run_id uuid,
  p_connection_id uuid,
  p_message_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_message_ids is null or coalesce(array_length(p_message_ids, 1), 0) = 0 then
    return 0;
  end if;

  insert into public.run_email_jobs (run_id, connection_id, message_id)
  select p_run_id, p_connection_id, m.message_id
  from unnest(p_message_ids) as m(message_id)
  join public.tool_runs r
    on r.id = p_run_id
   and r.connection_id = p_connection_id
   and r.status = 'running'
  where nullif(btrim(m.message_id), '') is not null
  on conflict (run_id, message_id) do nothing;

  get diagnostics v_count = row_count;

  update public.tool_runs
  set
    queued_message_count = (
      select count(*) from public.run_email_jobs where run_id = p_run_id
    ),
    discovered_message_count = greatest(
      discovered_message_count,
      (
        select count(*) from public.run_email_jobs where run_id = p_run_id
      )
    )
  where id = p_run_id;

  return v_count;
end;
$$;

revoke execute on function public.enqueue_run_email_jobs(uuid,uuid,text[]) from public, anon, authenticated;
grant execute on function public.enqueue_run_email_jobs(uuid,uuid,text[]) to service_role;
