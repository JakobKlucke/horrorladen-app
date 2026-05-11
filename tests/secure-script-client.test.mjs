import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSecureScriptClient,
  getAdminRedirectUrl,
  getSupabaseConfig,
  normalizeFunctionError
} from '../src/secure-script-client.mjs';

function fakeSupabase({ session = null, invoke } = {}){
  return {
    auth: {
      async signInAnonymously(options){
        fakeSupabase.signInAnonymouslyCalls.push(options);
        return { data: { session: { access_token: 'anon-token', user: { id: 'user-anon', is_anonymous: true } } }, error: null };
      },
      async signInWithOtp(options){
        fakeSupabase.signInWithOtpCalls.push(options);
        return { data: {}, error: null };
      },
      async getSession(){
        return { data: { session } };
      }
    },
    functions: {
      invoke
    }
  };
}
fakeSupabase.signInAnonymouslyCalls = [];
fakeSupabase.signInWithOtpCalls = [];

test('secure script client requires an authenticated session before invoking functions', async () => {
  let invoked = false;
  const client = createSecureScriptClient({
    supabase: fakeSupabase({
      invoke: async () => {
        invoked = true;
        return { data: null, error: null };
      }
    })
  });

  await assert.rejects(() => client.listScripts(), /Bitte melde dich an/);
  assert.equal(invoked, false);
});

test('secure script client forwards Supabase function errors as readable messages', async () => {
  const client = createSecureScriptClient({
    supabase: fakeSupabase({
      session: { access_token: 'token-1' },
      invoke: async () => ({ data: null, error: { message: 'Forbidden', context: { status: 403 } } })
    })
  });

  await assert.rejects(() => client.loadScript('horrorladen-final'), /Forbidden/);
});

test('secure script client sends the selected script id to get-script', async () => {
  const calls = [];
  const client = createSecureScriptClient({
    supabase: fakeSupabase({
      session: { access_token: 'token-1' },
      invoke: async (name, options) => {
        calls.push([name, options]);
        return { data: { script: { title: 'Horrorladen', entries: [] } }, error: null };
      }
    })
  });

  const script = await client.loadScript('horrorladen-final');

  assert.equal(script.title, 'Horrorladen');
  assert.deepEqual(calls, [['get-script', {
    body: { scriptId: 'horrorladen-final' },
    headers: { Authorization: 'Bearer token-1' }
  }]]);
});

test('Supabase config is read from Vite env names only', () => {
  assert.deepEqual(getSupabaseConfig({
    VITE_SUPABASE_URL: 'https://example.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'anon-key'
  }), {
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    isConfigured: true
  });
});

test('normalizeFunctionError falls back to the provided default message', () => {
  assert.equal(normalizeFunctionError(null, 'Fallback'), 'Fallback');
});

test('code login creates an anonymous session then stores profile name and redeems invite', async () => {
  fakeSupabase.signInAnonymouslyCalls = [];
  const calls = [];
  const client = createSecureScriptClient({
    supabase: fakeSupabase({
      session: { access_token: 'anon-token', user: { id: 'user-anon' } },
      invoke: async (name, options) => {
        calls.push([name, options.body]);
        return { data: name === 'redeem-invite' ? { access: { script_id: 'horrorladen-final' } } : { profile: { display_name: 'Jakob' } }, error: null };
      }
    })
  });

  const session = await client.signInWithCode({ displayName: ' Jakob ', inviteCode: ' STAGECUE-1 ' });

  assert.equal(session.access_token, 'anon-token');
  assert.deepEqual(fakeSupabase.signInAnonymouslyCalls, [{ options: { data: { display_name: 'Jakob' } } }]);
  assert.deepEqual(calls, [
    ['set-profile-name', { displayName: 'Jakob' }],
    ['redeem-invite', { inviteCode: 'STAGECUE-1' }]
  ]);
});

test('admin magic link is restricted to the configured admin email', async () => {
  fakeSupabase.signInWithOtpCalls = [];
  const client = createSecureScriptClient({
    supabase: fakeSupabase()
  });

  await assert.rejects(() => client.sendAdminMagicLink({ email: 'not-admin@example.com' }), /Admin-E-Mail/);
  await client.sendAdminMagicLink({ email: 'kontakt@jakobklucke.de', redirectTo: 'https://example.com/admin' });

  assert.deepEqual(fakeSupabase.signInWithOtpCalls, [{
    email: 'kontakt@jakobklucke.de',
    options: {
      emailRedirectTo: 'https://example.com/admin',
      shouldCreateUser: true
    }
  }]);
});

test('admin redirect URL does not use localhost for magic links', () => {
  assert.equal(
    getAdminRedirectUrl({}, { origin: 'http://localhost:5173' }),
    'https://horrorladen-app.vercel.app/admin'
  );
  assert.equal(
    getAdminRedirectUrl({}, { origin: 'http://127.0.0.1:5173' }),
    'https://horrorladen-app.vercel.app/admin'
  );
  assert.equal(
    getAdminRedirectUrl({}, { origin: 'https://horrorladen-app.vercel.app' }),
    'https://horrorladen-app.vercel.app/admin'
  );
});

test('secure client syncs leaderboard summaries through the protected function', async () => {
  const calls = [];
  const client = createSecureScriptClient({
    supabase: fakeSupabase({
      session: { access_token: 'token-1' },
      invoke: async (name, options) => {
        calls.push([name, options]);
        return { data: { leaderboard: { rank: 1 } }, error: null };
      }
    })
  });

  const leaderboard = await client.syncLeaderboard({ scriptId: 'horrorladen-final', xp: 120 });

  assert.deepEqual(leaderboard, { rank: 1 });
  assert.deepEqual(calls, [['sync-leaderboard', {
    body: { scriptId: 'horrorladen-final', xp: 120 },
    headers: { Authorization: 'Bearer token-1' }
  }]]);
});
