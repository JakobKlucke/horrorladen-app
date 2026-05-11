create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(trim(display_name)) between 1 and 40)
);

create table if not exists public.leaderboard_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  script_id text not null references public.encrypted_scripts(id) on delete cascade,
  role_id text not null,
  display_name text not null,
  xp integer not null default 0,
  stars integer not null default 0,
  completed_missions integer not null default 0,
  streak_days integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, script_id, role_id),
  constraint leaderboard_xp_nonnegative check (xp >= 0),
  constraint leaderboard_stars_nonnegative check (stars >= 0),
  constraint leaderboard_completed_nonnegative check (completed_missions >= 0),
  constraint leaderboard_streak_nonnegative check (streak_days >= 0)
);

create index if not exists leaderboard_entries_script_score_idx
  on public.leaderboard_entries(script_id, xp desc, stars desc, updated_at desc);

alter table public.profiles enable row level security;
alter table public.leaderboard_entries enable row level security;

drop policy if exists profiles_no_direct_access on public.profiles;
create policy profiles_no_direct_access
  on public.profiles
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists leaderboard_entries_no_direct_access on public.leaderboard_entries;
create policy leaderboard_entries_no_direct_access
  on public.leaderboard_entries
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on public.profiles from anon, authenticated;
revoke all on public.leaderboard_entries from anon, authenticated;

grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.leaderboard_entries to service_role;

create or replace function public.admin_email()
returns text
language sql
stable
as $$
  select 'kontakt@jakobklucke.de'::text;
$$;

revoke all on function public.admin_email() from public, anon, authenticated;
grant execute on function public.admin_email() to service_role;
