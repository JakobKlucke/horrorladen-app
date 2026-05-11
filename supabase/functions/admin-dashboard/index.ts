import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireAdmin } from '../_shared/security.ts';

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    await requireAdmin(req);
    const supabase = getSupabaseAdmin();

    const [scriptsResult, invitesResult, accessResult, profilesResult, leaderboardResult] = await Promise.all([
      supabase.from('encrypted_scripts').select('id,title,label,created_at').order('title'),
      supabase.from('invite_codes').select('code_hash,script_id,max_uses,uses,expires_at,created_at').order('created_at', { ascending: false }),
      supabase.from('user_script_access').select('user_id,script_id,granted_at,granted_by_code_hash').order('granted_at', { ascending: false }),
      supabase.from('profiles').select('user_id,display_name,updated_at'),
      supabase.from('leaderboard_entries').select('user_id,script_id,role_id,display_name,xp,stars,completed_missions,streak_days,updated_at').order('xp', { ascending: false }).limit(50)
    ]);

    const firstError = scriptsResult.error || invitesResult.error || accessResult.error || profilesResult.error || leaderboardResult.error;
    if(firstError) return jsonResponse({ error: firstError.message }, 500);

    const profiles = new Map((profilesResult.data || []).map(profile => [profile.user_id, profile]));
    const users = (accessResult.data || []).map(row => ({
      user_id: row.user_id,
      script_id: row.script_id,
      granted_at: row.granted_at,
      code_hash_prefix: row.granted_by_code_hash ? `${String(row.granted_by_code_hash).slice(0, 10)}…` : '',
      display_name: profiles.get(row.user_id)?.display_name || 'Ohne Namen'
    }));
    const invites = (invitesResult.data || []).map(invite => ({
      script_id: invite.script_id,
      max_uses: invite.max_uses,
      uses: invite.uses,
      expires_at: invite.expires_at,
      created_at: invite.created_at,
      code_hash_prefix: `${String(invite.code_hash).slice(0, 10)}…`
    }));

    return jsonResponse({
      scripts: scriptsResult.data || [],
      invites,
      users,
      leaderboard: leaderboardResult.data || []
    });
  }catch(error){
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, message.includes('Admin') ? 403 : 401);
  }
});
