drop function if exists public.claim_email_processing(uuid,text,uuid);
drop function if exists public.set_email_processing_status(uuid,text,uuid,text);
drop function if exists public.increment_tool_run_stats(uuid,uuid,integer,integer,integer);

revoke execute on function public.upsert_extracted_contact(
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.upsert_extracted_contact(
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;
