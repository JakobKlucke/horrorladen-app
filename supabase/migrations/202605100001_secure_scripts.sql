create table if not exists public.encrypted_scripts (
  id text primary key,
  title text not null,
  label text,
  ciphertext jsonb not null,
  checksum text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invite_codes (
  code_hash text primary key,
  script_id text not null references public.encrypted_scripts(id) on delete cascade,
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invite_codes_uses_nonnegative check (uses >= 0),
  constraint invite_codes_max_uses_positive check (max_uses is null or max_uses > 0)
);

create table if not exists public.user_script_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  script_id text not null references public.encrypted_scripts(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by_code_hash text references public.invite_codes(code_hash),
  primary key (user_id, script_id)
);

create index if not exists user_script_access_user_id_idx
  on public.user_script_access(user_id);

create index if not exists invite_codes_script_id_idx
  on public.invite_codes(script_id);

create index if not exists user_script_access_script_id_idx
  on public.user_script_access(script_id);

create index if not exists user_script_access_granted_by_code_hash_idx
  on public.user_script_access(granted_by_code_hash);

create extension if not exists supabase_vault with schema vault;

alter table public.encrypted_scripts enable row level security;
alter table public.invite_codes enable row level security;
alter table public.user_script_access enable row level security;

drop policy if exists encrypted_scripts_no_direct_access on public.encrypted_scripts;
create policy encrypted_scripts_no_direct_access
  on public.encrypted_scripts
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists invite_codes_no_direct_access on public.invite_codes;
create policy invite_codes_no_direct_access
  on public.invite_codes
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists user_script_access_no_direct_access on public.user_script_access;
create policy user_script_access_no_direct_access
  on public.user_script_access
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on public.encrypted_scripts from anon, authenticated;
revoke all on public.invite_codes from anon, authenticated;
revoke all on public.user_script_access from anon, authenticated;

grant select, insert, update, delete on public.encrypted_scripts to service_role;
grant select, insert, update, delete on public.invite_codes to service_role;
grant select, insert, update, delete on public.user_script_access to service_role;

create or replace function public.redeem_invite_code(p_code_hash text, p_user_id uuid)
returns table(script_id text, title text, label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_invite public.invite_codes%rowtype;
begin
  update public.invite_codes
    set uses = uses + 1
    where code_hash = p_code_hash
      and (expires_at is null or expires_at > now())
      and (max_uses is null or uses < max_uses)
    returning * into matched_invite;

  if not found then
    raise exception 'Invite-Code ist ungueltig, abgelaufen oder bereits verbraucht.';
  end if;

  insert into public.user_script_access(user_id, script_id, granted_by_code_hash)
    values (p_user_id, matched_invite.script_id, matched_invite.code_hash)
    on conflict (user_id, script_id) do update
      set granted_at = excluded.granted_at,
          granted_by_code_hash = excluded.granted_by_code_hash;

  return query
    select scripts.id, scripts.title, scripts.label
    from public.encrypted_scripts as scripts
    where scripts.id = matched_invite.script_id;
end;
$$;

revoke all on function public.redeem_invite_code(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_invite_code(text, uuid) to service_role;

create or replace function public.get_script_master_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'script_master_key'
  order by created_at desc
  limit 1;
$$;

revoke all on function public.get_script_master_key() from public, anon, authenticated;
grant execute on function public.get_script_master_key() to service_role;
