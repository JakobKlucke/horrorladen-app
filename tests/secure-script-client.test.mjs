import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSecureScriptClient,
  getSupabaseConfig,
  normalizeFunctionError
} from '../src/secure-script-client.mjs';

function fakeSupabase({ session = null, invoke } = {}){
  return {
    auth: {
      async getSession(){
        return { data: { session } };
      }
    },
    functions: {
      invoke
    }
  };
}

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
