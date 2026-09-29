create or replace function public.upsert_extracted_contact(
  p_connection_id uuid,
  p_message_id text,
  p_run_id uuid,
  p_email text,
  p_normalized_email text,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_title text,
  p_address text
)
returns table(
  id uuid,
  email text,
  first_name text,
  last_name text,
  phone text,
  title text,
  address text,
  normalized_email text,
  sheet_written boolean,
  sheet_written_to text,
  message_id text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  loop
    if nullif(trim(coalesce(p_normalized_email, '')), '') is not null then
      return query
      select
        c.id,
        c.email,
        c.first_name,
        c.last_name,
        c.phone,
        c.title,
        c.address,
        c.normalized_email,
        c.sheet_written,
        c.sheet_written_to,
        c.message_id
      from public.extracted_contacts c
      where c.connection_id = p_connection_id
        and c.normalized_email = p_normalized_email
      limit 1;

      if found then
        return;
      end if;
    end if;

    return query
    select
      c.id,
      c.email,
      c.first_name,
      c.last_name,
      c.phone,
      c.title,
      c.address,
      c.normalized_email,
      c.sheet_written,
      c.sheet_written_to,
      c.message_id
    from public.extracted_contacts c
    where c.connection_id = p_connection_id
      and c.message_id = p_message_id
    limit 1;

    if found then
      return;
    end if;

    begin
      return query
      insert into public.extracted_contacts (
        connection_id,
        message_id,
        run_id,
        email,
        normalized_email,
        first_name,
        last_name,
        phone,
        title,
        address,
        sheet_written,
        sheet_written_to
      )
      values (
        p_connection_id,
        p_message_id,
        p_run_id,
        p_email,
        nullif(trim(coalesce(p_normalized_email, '')), ''),
        p_first_name,
        p_last_name,
        p_phone,
        p_title,
        p_address,
        false,
        null
      )
      returning
        extracted_contacts.id,
        extracted_contacts.email,
        extracted_contacts.first_name,
        extracted_contacts.last_name,
        extracted_contacts.phone,
        extracted_contacts.title,
        extracted_contacts.address,
        extracted_contacts.normalized_email,
        extracted_contacts.sheet_written,
        extracted_contacts.sheet_written_to,
        extracted_contacts.message_id;

      return;
    exception
      when unique_violation then
        -- Another worker won the insert. Loop and return that canonical row.
    end;
  end loop;
end;
$$;

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

grant execute on function public.upsert_extracted_contact(uuid, text, uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.claim_email_processing(uuid, text, uuid) to service_role;
