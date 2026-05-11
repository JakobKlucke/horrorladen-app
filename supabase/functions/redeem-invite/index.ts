import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireUser, sha256Hex } from '../_shared/security.ts';

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    const user = await requireUser(req);
    const { inviteCode } = await req.json();
    const code = String(inviteCode || '').trim();
    if(!code) return jsonResponse({ error: 'Invite-Code fehlt.' }, 400);

    const supabase = getSupabaseAdmin();
    const codeHash = await sha256Hex(code);
    const { data, error } = await supabase.rpc('redeem_invite_code', {
      p_code_hash: codeHash,
      p_user_id: user.id
    });
    if(error) return jsonResponse({ error: error.message }, 403);

    return jsonResponse({ access: data?.[0] || null });
  }catch(error){
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
