import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(path){
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Supabase migration defines profile and leaderboard tables', async () => {
  const migration = await read('supabase/migrations/202605110001_admin_leaderboard.sql');

  assert.match(migration, /create table if not exists public\.profiles/);
  assert.match(migration, /create table if not exists public\.leaderboard_entries/);
  assert.match(migration, /admin_email/);
  assert.match(migration, /enable row level security/);
});

test('new Edge Functions exist for profile, leaderboard and admin dashboard flows', async () => {
  const files = await Promise.all([
    read('supabase/functions/set-profile-name/index.ts'),
    read('supabase/functions/sync-leaderboard/index.ts'),
    read('supabase/functions/admin-dashboard/index.ts'),
    read('supabase/functions/admin-create-invite/index.ts')
  ]);

  assert.match(files[0], /set-profile-name/);
  assert.match(files[1], /leaderboard_entries/);
  assert.match(files[2], /requireAdmin/);
  assert.match(files[3], /crypto\.randomUUID|crypto\.getRandomValues/);
});
