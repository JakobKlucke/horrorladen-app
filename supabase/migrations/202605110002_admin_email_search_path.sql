create or replace function public.admin_email()
returns text
language sql
stable
set search_path = ''
as $$
  select 'kontakt@jakobklucke.de'::text;
$$;

revoke all on function public.admin_email() from public, anon, authenticated;
grant execute on function public.admin_email() to service_role;
