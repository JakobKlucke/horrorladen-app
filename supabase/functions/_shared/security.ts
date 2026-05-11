import { createClient } from 'npm:@supabase/supabase-js@2';

export function getSupabaseAdmin(){
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url || !serviceRoleKey) throw new Error('Supabase Admin-Secrets fehlen.');
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false }
  });
}

export async function requireUser(req: Request){
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const authorization = req.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if(!url || !anonKey) throw new Error('Supabase Auth-Secrets fehlen.');
  if(!token) throw new Error('Nicht angemeldet.');

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } }
  });
  const { data, error } = await authClient.auth.getUser(token);
  if(error || !data.user) throw new Error('Session ist ungueltig oder abgelaufen.');
  return data.user;
}

function base64ToBytes(value: string){
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function bytesToText(bytes: ArrayBuffer){
  return new TextDecoder().decode(bytes);
}

export async function sha256Hex(value: string){
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getScriptMasterKey(){
  const envKey = Deno.env.get('SCRIPT_MASTER_KEY');
  if(envKey) return envKey;

  const { data, error } = await getSupabaseAdmin().rpc('get_script_master_key');
  if(error) throw new Error(`SCRIPT_MASTER_KEY konnte nicht geladen werden: ${error.message}`);
  if(!data) throw new Error('SCRIPT_MASTER_KEY fehlt.');
  return String(data);
}

export async function decryptJson(ciphertext: { iv: string; ciphertext: string }){
  const masterKey = await getScriptMasterKey();
  const keyBytes = base64ToBytes(masterKey);
  if(keyBytes.byteLength !== 32) throw new Error('SCRIPT_MASTER_KEY muss 32 Bytes base64-kodieren.');

  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ciphertext.iv) },
    key,
    base64ToBytes(ciphertext.ciphertext)
  );
  return JSON.parse(bytesToText(plaintext));
}
