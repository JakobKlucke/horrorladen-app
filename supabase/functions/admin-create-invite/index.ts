import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireAdmin, sha256Hex } from '../_shared/security.ts';

function clean(value: unknown){
  return String(value || '').trim();
}

function randomPart(){
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function codeForScript(scriptId: string){
  const slug = scriptId.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
  return `STAGECUE-${slug}-${randomPart()}`;
}

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    await requireAdmin(req);
    const { scriptId, maxUses } = await req.json();
    const id = clean(scriptId);
    if(!id) return jsonResponse({ error: 'scriptId fehlt.' }, 400);

    const supabase = getSupabaseAdmin();
    const { data: script, error: scriptError } = await supabase
      .from('encrypted_scripts')
      .select('id,title,label')
      .eq('id', id)
      .single();
    if(scriptError || !script) return jsonResponse({ error: 'Textbuch wurde nicht gefunden.' }, 404);

    const code = codeForScript(id);
    const codeHash = await sha256Hex(code);
    const normalizedMaxUses = maxUses == null ? null : Math.max(1, Math.floor(Number(maxUses || 1)));
    const { error } = await supabase
      .from('invite_codes')
      .insert({
        code_hash: codeHash,
        script_id: id,
        max_uses: normalizedMaxUses,
        expires_at: null
      });
    if(error) return jsonResponse({ error: error.message }, 500);

    return jsonResponse({
      invite: {
        scriptId: id,
        scriptTitle: script.label || script.title,
        code,
        code_hash_prefix: `${codeHash.slice(0, 10)}…`,
        maxUses: normalizedMaxUses,
        uses: 0
      }
    });
  }catch(error){
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, message.includes('Admin') ? 403 : 401);
  }
});
