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
declare
  v_contact public.extracted_contacts%rowtype;
begin
  loop
    if nullif(trim(coalesce(p_normalized_email, '')), '') is not null then
      select c.*
        into v_contact
      from public.extracted_contacts as c
      where c.connection_id = p_connection_id
        and c.normalized_email = p_normalized_email
      limit 1
      for update;

      if found then
        return query select
          v_contact.id,
          v_contact.email,
          v_contact.first_name,
          v_contact.last_name,
          v_contact.phone,
          v_contact.title,
          v_contact.address,
          v_contact.normalized_email,
          v_contact.sheet_written,
          v_contact.sheet_written_to,
          v_contact.message_id;
        return;
      end if;
    end if;

    select c.*
      into v_contact
    from public.extracted_contacts as c
    where c.connection_id = p_connection_id
      and c.message_id = p_message_id
    limit 1
    for update;

    if found then
      return query select
        v_contact.id,
        v_contact.email,
        v_contact.first_name,
        v_contact.last_name,
        v_contact.phone,
        v_contact.title,
        v_contact.address,
        v_contact.normalized_email,
        v_contact.sheet_written,
        v_contact.sheet_written_to,
        v_contact.message_id;
      return;
    end if;

    begin
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
      returning * into v_contact;

      return query select
        v_contact.id,
        v_contact.email,
        v_contact.first_name,
        v_contact.last_name,
        v_contact.phone,
        v_contact.title,
        v_contact.address,
        v_contact.normalized_email,
        v_contact.sheet_written,
        v_contact.sheet_written_to,
        v_contact.message_id;
      return;
    exception
      when unique_violation then
        null;
    end;
  end loop;
end;
$$;

grant execute on function public.upsert_extracted_contact(uuid, text, uuid, text, text, text, text, text, text, text) to service_role;
