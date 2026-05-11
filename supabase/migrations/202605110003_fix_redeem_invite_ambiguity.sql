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
    set uses = invite_codes.uses + 1
    where code_hash = p_code_hash
      and (expires_at is null or expires_at > now())
      and (max_uses is null or uses < max_uses)
    returning * into matched_invite;

  if not found then
    raise exception 'Invite-Code ist ungueltig, abgelaufen oder bereits verbraucht.';
  end if;

  insert into public.user_script_access(user_id, script_id, granted_by_code_hash)
    values (p_user_id, matched_invite.script_id, matched_invite.code_hash)
    on conflict on constraint user_script_access_pkey do update
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
