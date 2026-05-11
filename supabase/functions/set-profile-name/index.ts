import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireUser } from '../_shared/security.ts';

function cleanName(value: unknown){
  return String(value || '').trim().slice(0, 40);
}

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    const user = await requireUser(req);
    const { displayName } = await req.json();
    const name = cleanName(displayName);
    if(!name) return jsonResponse({ error: 'Benutzername fehlt.' }, 400);

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        user_id: user.id,
        display_name: name,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select('user_id,display_name,updated_at')
      .single();
    if(error) return jsonResponse({ error: error.message }, 500);

    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...(user.user_metadata || {}),
        display_name: name
      }
    });

    return jsonResponse({ profile: data, source: 'set-profile-name' });
  }catch(error){
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
