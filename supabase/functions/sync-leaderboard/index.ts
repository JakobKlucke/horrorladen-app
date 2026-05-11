import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireUser } from '../_shared/security.ts';

function clean(value: unknown){
  return String(value || '').trim();
}

function nonnegativeInteger(value: unknown){
  return Math.max(0, Math.floor(Number(value || 0)));
}

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    const user = await requireUser(req);
    const body = await req.json();
    const scriptId = clean(body.scriptId);
    const roleId = clean(body.roleId);
    if(!scriptId || !roleId) return jsonResponse({ error: 'scriptId und roleId fehlen.' }, 400);

    const supabase = getSupabaseAdmin();
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('user_id', user.id)
      .maybeSingle();

    const displayName = clean(profile?.display_name || body.displayName || user.user_metadata?.display_name || 'RoleQuest User').slice(0, 40);
    const payload = {
      user_id: user.id,
      script_id: scriptId,
      role_id: roleId,
      display_name: displayName || 'RoleQuest User',
      xp: nonnegativeInteger(body.xp),
      stars: nonnegativeInteger(body.stars),
      completed_missions: nonnegativeInteger(body.completedMissions),
      streak_days: nonnegativeInteger(body.streakDays),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('leaderboard_entries')
      .upsert(payload, { onConflict: 'user_id,script_id,role_id' })
      .select('user_id,script_id,role_id,display_name,xp,stars,completed_missions,streak_days,updated_at')
      .single();
    if(error) return jsonResponse({ error: error.message }, 500);

    return jsonResponse({ leaderboard: data });
  }catch(error){
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
