import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { decryptJson, getSupabaseAdmin, requireUser } from '../_shared/security.ts';

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    const user = await requireUser(req);
    const { scriptId } = await req.json();
    const id = String(scriptId || '').trim();
    if(!id) return jsonResponse({ error: 'scriptId fehlt.' }, 400);

    const supabase = getSupabaseAdmin();
    const { data: access, error: accessError } = await supabase
      .from('user_script_access')
      .select('script_id')
      .eq('user_id', user.id)
      .eq('script_id', id)
      .maybeSingle();
    if(accessError) return jsonResponse({ error: accessError.message }, 500);
    if(!access) return jsonResponse({ error: 'Kein Zugriff auf dieses Regiebuch.' }, 403);

    const { data: script, error: scriptError } = await supabase
      .from('encrypted_scripts')
      .select('id,title,ciphertext')
      .eq('id', id)
      .single();
    if(scriptError) return jsonResponse({ error: scriptError.message }, 500);

    const decrypted = await decryptJson(script.ciphertext);
    return jsonResponse({ script: decrypted });
  }catch(error){
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
