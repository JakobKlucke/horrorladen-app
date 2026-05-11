import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getSupabaseAdmin, requireUser } from '../_shared/security.ts';

Deno.serve(async req => {
  if(req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if(req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try{
    const user = await requireUser(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_script_access')
      .select('encrypted_scripts(id,title,label)')
      .eq('user_id', user.id)
      .order('granted_at', { ascending: true });
    if(error) return jsonResponse({ error: error.message }, 500);

    const scripts = (data || [])
      .map(row => row.encrypted_scripts)
      .filter(Boolean)
      .map(script => ({
        id: script.id,
        src: script.id,
        title: script.title,
        label: script.label || script.title
      }));

    return jsonResponse({ scripts });
  }catch(error){
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 401);
  }
});
