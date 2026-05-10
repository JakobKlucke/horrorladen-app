export function getSupabaseConfig(env = {}){
  const url = String(env.VITE_SUPABASE_URL || '').trim();
  const anonKey = String(env.VITE_SUPABASE_ANON_KEY || '').trim();
  return {
    url,
    anonKey,
    isConfigured: Boolean(url && anonKey)
  };
}

export function normalizeFunctionError(error, fallback = 'Supabase-Funktion fehlgeschlagen.'){
  if(!error) return fallback;
  if(typeof error === 'string') return error;
  if(error.message) return error.message;
  if(error.error_description) return error.error_description;
  if(error.error) return error.error;
  return fallback;
}

function cleanValue(value){
  return String(value || '').trim();
}

function authHeaders(session){
  const token = cleanValue(session?.access_token);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requireSession(supabase){
  const { data, error } = await supabase.auth.getSession();
  if(error) throw new Error(normalizeFunctionError(error, 'Session konnte nicht gelesen werden.'));
  const session = data?.session || null;
  if(!session?.access_token) throw new Error('Bitte melde dich an, bevor du Regiebuecher laedst.');
  return session;
}

async function invokeRequired(supabase, name, options = {}){
  const session = await requireSession(supabase);
  const { data, error } = await supabase.functions.invoke(name, {
    ...options,
    headers: {
      ...authHeaders(session),
      ...(options.headers || {})
    }
  });
  if(error) throw new Error(normalizeFunctionError(error));
  return data;
}

export function createSecureScriptClient({ supabase } = {}){
  if(!supabase) throw new Error('Supabase client fehlt.');

  async function getSession(){
    const { data, error } = await supabase.auth.getSession();
    if(error) throw new Error(normalizeFunctionError(error, 'Session konnte nicht gelesen werden.'));
    return data?.session || null;
  }

  async function signIn({ email, password }){
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanValue(email),
      password: String(password || '')
    });
    if(error) throw new Error(normalizeFunctionError(error, 'Login fehlgeschlagen.'));
    return data?.session || null;
  }

  async function signUp({ email, password, displayName }){
    const { data, error } = await supabase.auth.signUp({
      email: cleanValue(email),
      password: String(password || ''),
      options: {
        data: { display_name: cleanValue(displayName) }
      }
    });
    if(error) throw new Error(normalizeFunctionError(error, 'Registrierung fehlgeschlagen.'));
    return data?.session || null;
  }

  async function signOut(){
    const { error } = await supabase.auth.signOut();
    if(error) throw new Error(normalizeFunctionError(error, 'Abmeldung fehlgeschlagen.'));
  }

  async function redeemInvite(inviteCode){
    const data = await invokeRequired(supabase, 'redeem-invite', {
      body: { inviteCode: cleanValue(inviteCode) }
    });
    return data?.access || data;
  }

  async function listScripts(){
    const data = await invokeRequired(supabase, 'get-scripts');
    return {
      scripts: Array.isArray(data?.scripts) ? data.scripts : []
    };
  }

  async function loadScript(scriptId){
    const data = await invokeRequired(supabase, 'get-script', {
      body: { scriptId: cleanValue(scriptId) }
    });
    return data?.script || data;
  }

  return {
    supabase,
    getSession,
    signIn,
    signUp,
    signOut,
    redeemInvite,
    listScripts,
    loadScript
  };
}
