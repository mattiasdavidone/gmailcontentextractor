create or replace function public.claim_email_processing(
  p_connection_id uuid,
  p_message_id text,
  p_run_id uuid
)
returns table(claimed boolean, current_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_processed_at timestamptz;
begin
  select status, processed_at
    into v_status, v_processed_at
  from public.email_logs
  where connection_id = p_connection_id
    and message_id = p_message_id
  for update;

  if not found then
    insert into public.email_logs (
      connection_id,
      message_id,
      run_id,
      status,
      processed_at
    )
    values (
      p_connection_id,
      p_message_id,
      p_run_id,
      'processing',
      now()
    )
    on conflict (connection_id, message_id) do nothing;

    if found then
      return query select true, 'processing'::text;
      return;
    end if;

    select status, processed_at
      into v_status, v_processed_at
    from public.email_logs
    where connection_id = p_connection_id
      and message_id = p_message_id
    for update;
  end if;

  if v_status in (
    'bot_filtered',
    'contact_already_in_sheet',
    'contact_extracted'
  ) then
    return query select false, v_status;
    return;
  end if;

  if v_status = 'processing'
     and v_processed_at is not null
     and v_processed_at > now() - interval '10 minutes' then
    return query select false, v_status;
    return;
  end if;

  update public.email_logs
  set
    run_id = p_run_id,
    status = 'processing',
    processed_at = now()
  where connection_id = p_connection_id
    and message_id = p_message_id;

  return query select true, 'processing'::text;
end;
$$;

create or replace function public.set_email_processing_status(
  p_connection_id uuid,
  p_message_id text,
  p_run_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_logs
  set
    run_id = p_run_id,
    status = p_status,
    processed_at = now()
  where connection_id = p_connection_id
    and message_id = p_message_id
    and run_id = p_run_id;

  return found;
end;
$$;

grant execute on function public.claim_email_processing(uuid, text, uuid) to service_role;
grant execute on function public.set_email_processing_status(uuid, text, uuid, text) to service_role;
