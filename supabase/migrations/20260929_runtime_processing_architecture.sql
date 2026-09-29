alter table public.extracted_contacts
  add column if not exists normalized_email text;

update public.extracted_contacts
set normalized_email = lower(trim(email))
where normalized_email is null
  and coalesce(trim(email), '') <> '';

create unique index if not exists extracted_contacts_connection_normalized_email_key
  on public.extracted_contacts(connection_id, normalized_email)
  where normalized_email is not null and normalized_email <> '';

create index if not exists extracted_contacts_connection_email_idx
  on public.extracted_contacts(connection_id, normalized_email);

create unique index if not exists tool_runs_one_active_per_connection_key
  on public.tool_runs(connection_id)
  where status = 'running';

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
    );

    return query select true, 'processing'::text;
    return;
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
    and (run_id = p_run_id or p_status = 'failed');

  return found;
end;
$$;

create or replace function public.increment_tool_run_stats(
  p_run_id uuid,
  p_user_id uuid,
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
    contacts_extracted = contacts_extracted + greatest(coalesce(p_contacts, 0), 0)
  where id = p_run_id
    and user_id = p_user_id;

  return found;
end;
$$;

grant execute on function public.claim_email_processing(uuid, text, uuid) to service_role;
grant execute on function public.set_email_processing_status(uuid, text, uuid, text) to service_role;
grant execute on function public.increment_tool_run_stats(uuid, uuid, integer, integer, integer) to service_role;
