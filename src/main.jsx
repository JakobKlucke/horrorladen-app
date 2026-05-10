import React, { startTransition, useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { createRoot } from 'react-dom/client';
import {
  LEGACY_MODES,
  TAB_ITEMS,
  badgeLabel,
  buildEntryMap,
  clean,
  estimateAccuracy,
  firstAvailableMission,
  flattenMissions,
  formatNumber,
  getMissionProgress,
  nextReviews,
  percent,
  progressSummary,
  resolveScriptSource,
  sceneProgress,
  scriptOptionLabel,
  scriptOptionSource,
  scriptIdFromSource,
  stars
} from './stagecue-core.mjs';
import { createSecureScriptClient, getSupabaseConfig } from './secure-script-client.mjs';
import './styles.css';

const initialAppState = {
  manifest: null,
  scriptSrc: '',
  scriptTitle: '',
  runtime: null,
  roadmap: null,
  scriptId: '',
  profileState: null,
  profile: null,
  roleRoadmap: null,
  progress: null,
  loading: true,
  error: ''
};

const initialAuthState = {
  loading: true,
  error: '',
  secureClient: null,
  session: null,
  user: null
};

function getGlobals(){
  return {
    ScriptModel: window.ScriptModel,
    RoadmapModel: window.RoadmapModel,
    ProfileStore: window.ProfileStore
  };
}

function authStorageKey(userId, key){
  return `auth:${userId}:${key}`;
}

function Icon({ name }){
  const paths = {
    start: 'M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z',
    journey: 'M12 3v18M12 5h6l-2 3 2 3h-6M12 13H6l2 3-2 3h6',
    library: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm3 0v13a3 3 0 0 0 3 3',
    stats: 'M5 19V9M12 19V5M19 19v-7',
    profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
    play: 'M8 5v14l11-7L8 5Z',
    check: 'm5 13 4 4L19 7',
    lock: 'M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6V10Z',
    close: 'M6 6l12 12M18 6 6 18'
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.start} />
    </svg>
  );
}

function App(){
  const [app, setApp] = useState(initialAppState);
  const [auth, setAuth] = useState(initialAuthState);
  const [tab, setTab] = useState('start');
  const [selectedChapterId, setSelectedChapterId] = useState('');
  const [runner, setRunner] = useState(null);

  useEffect(() => {
    let alive = true;
    const config = getSupabaseConfig(import.meta.env);
    if(!config.isConfigured){
      setAuth({ ...initialAuthState, loading:false, error:'Supabase ist nicht konfiguriert. Setze VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY.' });
      setApp(prev => ({ ...prev, loading:false }));
      return () => { alive = false; };
    }

    const supabase = createClient(config.url, config.anonKey, {
      auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
    });
    const secureClient = createSecureScriptClient({ supabase });

    secureClient.getSession().then(session => {
      if(!alive) return;
      setAuth({ loading:false, error:'', secureClient, session, user:session?.user || null });
      if(session) loadAuthenticatedApp(secureClient, session);
      else setApp(prev => ({ ...prev, loading:false }));
    }).catch(error => {
      if(!alive) return;
      setAuth({ ...initialAuthState, loading:false, secureClient, error:error.message || String(error) });
      setApp(prev => ({ ...prev, loading:false }));
    });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if(!alive) return;
      setAuth(prev => ({ ...prev, loading:false, error:'', secureClient, session, user:session?.user || null }));
      if(event === 'SIGNED_OUT'){
        setSelectedChapterId('');
        setRunner(null);
        setApp({ ...initialAppState, loading:false });
      }
    });

    return () => {
      alive = false;
      data?.subscription?.unsubscribe?.();
    };
  }, []);

  function createUserStore(ProfileStore, userId){
    return ProfileStore.createStore({
      indexedDB: window.indexedDB,
      localStorage: window.localStorage,
      namespace: `auth:${userId}`
    });
  }

  async function loadAuthenticatedApp(secureClient, session, sourceOverride){
    setApp(prev => ({ ...prev, loading:true, error:'' }));
    try{
      const next = await boot(secureClient, session, sourceOverride);
      setSelectedChapterId('');
      setRunner(null);
      startTransition(() => setApp(next));
    }catch(error){
      setApp(prev => ({ ...prev, loading:false, error:error.message || String(error) }));
    }
  }

  async function boot(secureClient, session, sourceOverride){
    const { ScriptModel, RoadmapModel, ProfileStore } = getGlobals();
    if(!ScriptModel || !RoadmapModel || !ProfileStore) throw new Error('StageCue-Modelle wurden nicht geladen.');

    const manifest = await secureClient.listScripts();
    const userId = session.user.id;
    const storedSource = sourceOverride || localStorage.getItem(authStorageKey(userId, 'hl_json_src')) || '';
    const scriptSrc = resolveScriptSource(manifest, storedSource);
    if(!scriptSrc) return { ...initialAppState, manifest, loading:false, error:'Keine freigegebenen Skripte gefunden. Loese zuerst einen Invite-Code ein.' };

    const scriptData = await secureClient.loadScript(scriptSrc);
    const normalized = ScriptModel.normalizeScriptData(scriptData);
    const runtime = ScriptModel.buildRuntimeModel(normalized);
    const scriptId = scriptIdFromSource(scriptSrc);
    const roadmap = RoadmapModel.validateRoadmap(RoadmapModel.buildRoadmap(runtime, { scriptId }), runtime).roadmap;
    const store = createUserStore(ProfileStore, userId);
    const displayName = session.user.user_metadata?.display_name || session.user.email || 'StageCue User';

    await store.ensureProfile({
      displayName,
      userId,
      scriptId,
      roleId: roadmap.roles[0]?.roleId || ''
    });

    let profileState = await store.loadState();

    let profile = profileState.profiles.find(item => item.id === profileState.activeProfileId) || profileState.profiles[0] || null;
    let roleRoadmap = RoadmapModel.getRoleRoadmap(roadmap, profile?.roleId) || roadmap.roles[0] || null;

    if(profile && roleRoadmap && profile.roleId !== roleRoadmap.roleId){
      profile = { ...profile, userId, scriptId, roleId: roleRoadmap.roleId, updatedAt: new Date().toISOString() };
      await store.upsertProfile(profile);
      profileState = await store.loadState();
      profile = profileState.profiles.find(item => item.id === profile.id) || profile;
    }

    const progress = profile && roleRoadmap
      ? await store.getProgress(profile.id, scriptId, roleRoadmap.roleId, () => RoadmapModel.createDefaultProgress({
          profileId: profile.id,
          scriptId,
          roleId: roleRoadmap.roleId
        }))
      : null;

    localStorage.setItem(authStorageKey(userId, 'hl_script_chosen'), '1');
    localStorage.setItem(authStorageKey(userId, 'hl_json_src'), scriptSrc);

    return {
      manifest,
      scriptSrc,
      scriptTitle: normalized.title || scriptData.title || scriptSrc,
      runtime,
      roadmap,
      scriptId,
      profileState,
      profile,
      roleRoadmap,
      progress,
      loading: false,
      error: ''
    };
  }

  async function reloadScript(nextSource){
    if(auth.secureClient && auth.session) await loadAuthenticatedApp(auth.secureClient, auth.session, nextSource);
  }

  async function selectRole(roleId){
    const { RoadmapModel, ProfileStore } = getGlobals();
    const store = createUserStore(ProfileStore, auth.user.id);
    const roleRoadmap = RoadmapModel.getRoleRoadmap(app.roadmap, roleId) || app.roadmap.roles[0] || null;
    const profile = { ...app.profile, roleId: roleRoadmap.roleId, scriptId: app.scriptId, updatedAt: new Date().toISOString() };
    await store.upsertProfile(profile);
    const profileState = await store.loadState();
    const progress = await store.getProgress(profile.id, app.scriptId, roleRoadmap.roleId, () => RoadmapModel.createDefaultProgress({
      profileId: profile.id,
      scriptId: app.scriptId,
      roleId: roleRoadmap.roleId
    }));
    setSelectedChapterId('');
    setApp(prev => ({ ...prev, profileState, profile, roleRoadmap, progress }));
  }

  async function createProfile(displayName, options = {}){
    const { ProfileStore } = getGlobals();
    const store = createUserStore(ProfileStore, auth.user.id);
    const roleId = app.roleRoadmap?.roleId || app.roadmap?.roles?.[0]?.roleId || '';
    const profile = ProfileStore.createDefaultProfile({ displayName, userId: auth.user.id, scriptId: app.scriptId, roleId });
    await store.upsertProfile(profile);
    await store.setActiveProfile(profile.id);
    const next = await boot(auth.secureClient, auth.session, app.scriptSrc);
    setSelectedChapterId('');
    setRunner(null);
    setTab('start');
    setApp(next);
  }

  async function selectProfile(profileId){
    const { ProfileStore } = getGlobals();
    const store = createUserStore(ProfileStore, auth.user.id);
    await store.setActiveProfile(profileId);
    const next = await boot(auth.secureClient, auth.session, app.scriptSrc);
    setSelectedChapterId('');
    setRunner(null);
    setTab('start');
    setApp(next);
  }

  async function signOut(){
    if(auth.secureClient) await auth.secureClient.signOut();
    setSelectedChapterId('');
    setRunner(null);
    setApp({ ...initialAppState, loading:false });
  }

  function startMission(mission){
    const entries = entriesForMission(app.runtime, mission);
    if(!entries.length) return;
    setRunner({ mission, entries, index:0, hints:0, misses:0, revealed:false });
  }

  async function finishMission(result){
    const { RoadmapModel, ProfileStore } = getGlobals();
    const store = createUserStore(ProfileStore, auth.user.id);
    const progress = RoadmapModel.completeMission(app.progress, runner.mission, result);
    await store.saveProgress(progress);
    setApp(prev => ({ ...prev, progress }));
    setRunner(prev => ({ ...prev, done:true, result, stars: progress.missions[prev.mission.id].stars, totalXp: progress.xp }));
  }

  async function handleAuthenticated(session){
    setAuth(prev => ({ ...prev, session, user:session?.user || null, error:'' }));
    if(session && auth.secureClient) await loadAuthenticatedApp(auth.secureClient, session);
  }

  if(auth.loading || app.loading) return <LoadingScreen />;
  if(auth.error || !auth.session) return <AuthScreen auth={auth} onAuthenticated={handleAuthenticated} />;
  if(app.error && app.error.includes('Keine freigegebenen Skripte')){
    return <InviteUnlockScreen message={app.error} onRedeem={async code => {
      await auth.secureClient.redeemInvite(code);
      await loadAuthenticatedApp(auth.secureClient, auth.session);
    }} onSignOut={signOut} />;
  }
  if(app.error) return <ErrorScreen message={app.error} onRetry={() => reloadScript(app.scriptSrc)} />;
  if(!app.runtime) return <ScriptPicker app={app} onLoad={reloadScript} />;

  const selectedChapter = selectedChapterId
    ? app.roleRoadmap?.chapters?.find(chapter => chapter.id === selectedChapterId)
    : null;

  return (
    <div className="stagecue-shell">
      <main className="phone-frame">
        <AppHeader activeTab={tab} />
        <section key={`${tab}:${selectedChapterId}`} className="screen-scroll">
          {tab === 'start' && <StartScreen app={app} onTab={setTab} onStartMission={startMission} />}
          {tab === 'journey' && (
            selectedChapter
              ? <MissionDetail app={app} chapter={selectedChapter} onBack={() => setSelectedChapterId('')} onStartMission={startMission} />
              : <JourneyScreen app={app} onSelectChapter={setSelectedChapterId} onStartMission={startMission} />
          )}
          {tab === 'library' && <LibraryScreen app={app} onLoadScript={reloadScript} onSelectRole={selectRole} />}
          {tab === 'stats' && <StatsScreen app={app} />}
          {tab === 'profile' && <ProfileScreen app={app} auth={auth} onCreateProfile={createProfile} onSelectProfile={selectProfile} onSelectRole={selectRole} onSignOut={signOut} />}
        </section>
        <BottomNav active={tab} onChange={next => {
          setSelectedChapterId('');
          setTab(next);
        }} />
      </main>
      {runner && (
        <MissionRunner
          app={app}
          runner={runner}
          setRunner={setRunner}
          onClose={() => setRunner(null)}
          onFinish={finishMission}
        />
      )}
    </div>
  );
}

function LoadingScreen(){
  return (
    <div className="stagecue-shell">
      <main className="phone-frame center-screen">
        <div className="brand-large"><span>Stage</span><strong>Cue</strong></div>
        <p>Lade deine Rollenreise...</p>
      </main>
    </div>
  );
}

function ErrorScreen({ message, onRetry }){
  return (
    <div className="stagecue-shell">
      <main className="phone-frame center-screen">
        <div className="brand-large"><span>Stage</span><strong>Cue</strong></div>
        <p>{message}</p>
        <button className="primary-button" type="button" onClick={onRetry}>Neu laden</button>
      </main>
    </div>
  );
}

function ScriptPicker({ app, onLoad }){
  const scripts = app.manifest?.scripts || [];
  const [value, setValue] = useState(scriptOptionSource(scripts[0]) || '');
  return (
    <div className="stagecue-shell">
      <main className="phone-frame center-screen">
        <div className="brand-large"><span>Stage</span><strong>Cue</strong></div>
        <div className="panel-card">
          <h1>Skript auswählen</h1>
          <p>Wähle ein lokales Musical-Skript als Grundlage für deine Rollenreise.</p>
          <select value={value} onChange={event => setValue(event.target.value)}>
            {scripts.map(item => <option key={scriptOptionSource(item)} value={scriptOptionSource(item)}>{scriptOptionLabel(item)}</option>)}
          </select>
          <button className="primary-button" type="button" onClick={() => onLoad(value)}>StageCue starten</button>
        </div>
      </main>
    </div>
  );
}

function InviteUnlockScreen({ message, onRedeem, onSignOut }){
  const [inviteCode, setInviteCode] = useState('');
  const [feedback, setFeedback] = useState(message);
  const [busy, setBusy] = useState(false);

  async function submit(event){
    event.preventDefault();
    setFeedback('');
    if(!clean(inviteCode)){
      setFeedback('Bitte gib deinen Invite-Code ein.');
      return;
    }
    setBusy(true);
    try{
      await onRedeem(inviteCode);
    }catch(error){
      setFeedback(error.message || String(error));
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="stagecue-shell">
      <main className="phone-frame auth-frame">
        <section className="auth-screen">
          <div className="auth-brand">
            <div className="brand-large"><span>Stage</span><strong>Cue</strong></div>
            <p>Dein Konto ist angemeldet, aber noch fuer kein Regiebuch freigeschaltet.</p>
          </div>
          <form className="auth-card card" onSubmit={submit}>
            <h1>Invite-Code einloesen</h1>
            <p className="muted">Nach erfolgreicher Freischaltung laedt StageCue die Skriptliste neu.</p>
            <label>Invite-Code</label>
            <input value={inviteCode} onChange={event => setInviteCode(event.target.value)} autoComplete="one-time-code" placeholder="Code" />
            {feedback && <p className="auth-message">{feedback}</p>}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Bitte warten...' : 'Freischalten'}</button>
            <button className="secondary-button" type="button" onClick={onSignOut}>Anderen Account nutzen</button>
          </form>
        </section>
      </main>
    </div>
  );
}

function AuthScreen({ auth, onAuthenticated }){
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [message, setMessage] = useState(auth.error || '');
  const [busy, setBusy] = useState(false);

  async function submit(event){
    event.preventDefault();
    setMessage('');
    if(auth.error){
      setMessage(auth.error);
      return;
    }
    if(!auth.secureClient){
      setMessage('Supabase ist noch nicht bereit.');
      return;
    }
    if(!clean(email) || !password){
      setMessage('Bitte E-Mail und Passwort eingeben.');
      return;
    }
    if(mode === 'register' && !clean(inviteCode)){
      setMessage('Bitte gib deinen Invite-Code ein.');
      return;
    }
    setBusy(true);
    try{
      const session = mode === 'login'
        ? await auth.secureClient.signIn({ email, password })
        : await auth.secureClient.signUp({ email, password, displayName });
      if(!session){
        setMessage('Pruefe bitte deine E-Mails und bestaetige den Account, bevor du dich einloggst.');
        return;
      }
      if(clean(inviteCode)) await auth.secureClient.redeemInvite(inviteCode);
      await onAuthenticated(session);
    }catch(error){
      setMessage(error.message || String(error));
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="stagecue-shell">
      <main className="phone-frame auth-frame">
        <section className="auth-screen">
          <div className="auth-brand">
            <div className="brand-large"><span>Stage</span><strong>Cue</strong></div>
            <p>Regiebuecher werden erst nach Login und Invite-Code ueber die gesicherte Supabase-Funktion geladen.</p>
          </div>
          <form className="auth-card card" onSubmit={submit}>
            <div className="auth-toggle" role="tablist" aria-label="Anmeldemodus">
              <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>Einloggen</button>
              <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>Registrieren</button>
            </div>
            {mode === 'login' ? (
              <>
                <h1>Willkommen zurück</h1>
                <p className="muted">Melde dich mit deinem freigeschalteten Konto an.</p>
              </>
            ) : (
              <>
                <h1>Konto erstellen</h1>
                <p className="muted">Der Invite-Code schaltet dein Konto fuer die hinterlegten Regiebuecher frei.</p>
                <label>Name</label>
                <input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Dein Name" autoComplete="nickname" />
              </>
            )}
            <label>E-Mail</label>
            <input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email" placeholder="name@example.com" />
            <label>Passwort</label>
            <input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="Passwort" />
            <label>Invite-Code {mode === 'login' ? 'optional' : ''}</label>
            <input value={inviteCode} onChange={event => setInviteCode(event.target.value)} autoComplete="one-time-code" placeholder="Code" />
            {message && <p className="auth-message">{message}</p>}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Bitte warten...' : (mode === 'login' ? 'Einloggen' : 'Registrieren')}</button>
          </form>
        </section>
      </main>
    </div>
  );
}

function AppHeader({ activeTab }){
  return (
    <header className="app-header">
      <div className="wordmark"><span>Stage</span><strong>Cue</strong></div>
      <div className="header-title">{TAB_ITEMS.find(item => item.id === activeTab)?.label}</div>
    </header>
  );
}

function BottomNav({ active, onChange }){
  return (
    <nav className="bottom-tabs" aria-label="Hauptnavigation">
      {TAB_ITEMS.map(item => (
        <button key={item.id} className={`${item.id === active ? 'active' : ''} ${item.primary ? 'primary-tab' : ''}`} type="button" onClick={() => onChange(item.id)}>
          <Icon name={item.id === 'library' ? 'library' : item.id} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function StartScreen({ app, onTab, onStartMission }){
  const { RoadmapModel } = getGlobals();
  const summary = progressSummary(app.roleRoadmap, app.progress, RoadmapModel);
  const profile = app.roleRoadmap?.profile || {};
  const due = RoadmapModel.dueMissions(app.roleRoadmap, app.progress);
  const nextMission = firstAvailableMission(app.roleRoadmap, app.progress, RoadmapModel);
  const completedMissions = flattenMissions(app.roleRoadmap, RoadmapModel)
    .filter(mission => getMissionProgress(app.progress, mission.id)?.status === 'completed');
  const lastCompleted = completedMissions[completedMissions.length - 1] || null;
  return (
    <div className="screen-stack">
      <section className="role-hero card">
        <div className="portrait-orb">{initials(app.roleRoadmap?.label)}</div>
        <div>
          <p>Deine Rolle</p>
          <h1>{app.roleRoadmap?.label || 'Rolle'}</h1>
          <span>{app.scriptTitle}</span>
        </div>
      </section>
      <section className="metric-grid">
        <MetricCard label="Tage Streak" value={app.progress?.streakDays || 0} />
        <RingCard label="XP" value={formatNumber(app.progress?.xp || 0)} progress={percent(app.progress?.xp || 0, Math.max(500, (summary.missions || 1) * 80))} />
      </section>
      <section className="card mastery-card">
        <div>
          <p>Gesamtmeisterschaft</p>
          <strong>{summary.percent}%</strong>
        </div>
        <ProgressBar value={summary.percent} />
      </section>
      <section className="card current-script">
        <div>
          <p>Aktuelles Stück</p>
          <h2>{app.scriptTitle}</h2>
          <span>{profile.sceneCount || 0} Szenen · Schwierigkeit: {profile.difficulty || 'easy'}</span>
        </div>
      </section>
      <button className="primary-button continue" type="button" onClick={() => nextMission ? onStartMission(nextMission) : onTab('journey')}>
        Weiterlernen <Icon name="play" />
      </button>
      <section className="quick-grid">
        <QuickCard title="Daily Review" value={due.length ? `${due.length} fällig` : 'Keine fällig'} onClick={() => due[0] && onStartMission(due[0])} />
        <QuickCard title="Boss-Level" value={bossStatus(app.roleRoadmap, app.progress)} onClick={() => onTab('journey')} />
        <QuickCard title="Letzte Mission" value={lastCompleted?.missionType ? missionLabel(lastCompleted) : 'Noch offen'} onClick={() => onTab('journey')} />
      </section>
    </div>
  );
}

function JourneyScreen({ app, onSelectChapter }){
  const { RoadmapModel } = getGlobals();
  const profile = app.roleRoadmap?.profile || {};
  return (
    <div className="screen-stack">
      <section className="profile-summary card">
        <div className="portrait-orb small">{initials(app.roleRoadmap?.label)}</div>
        <div><strong>{profile.lineCount || 0}</strong><span>Zeilen</span></div>
        <div><strong>{profile.wordCount || 0}</strong><span>Wörter</span></div>
        <div><strong>{profile.sceneCount || 0}</strong><span>Szenen</span></div>
        <p>Schwierigkeit: <em>{profile.difficulty || 'easy'}</em></p>
      </section>
      <section className="timeline">
        {app.roleRoadmap?.chapters?.map((chapter, index) => {
          const locked = !RoadmapModel.isUnlocked(app.progress, chapter);
          const missions = chapter.missions || [];
          const completed = missions.filter(mission => Number(getMissionProgress(app.progress, mission.id)?.stars || 0) > 0).length;
          const boss = missions.find(mission => mission.missionType === 'boss_scene');
          return (
            <article key={chapter.id} className={`timeline-row ${locked ? 'locked' : ''}`} onClick={() => !locked && onSelectChapter(chapter.id)}>
              <div className={`timeline-dot ${boss ? 'boss' : ''}`}>{locked ? <Icon name="lock" /> : completed ? <Icon name="check" /> : index + 1}</div>
              <div className="card chapter-card">
                <h2>{chapter.title}</h2>
                <p>{completed}/{missions.length} Missionen</p>
                <div className="chapter-missions">
                  {missions.slice(0, 4).map(mission => (
                    <span key={mission.id}>{missionLabel(mission)} <b>{stars(getMissionProgress(app.progress, mission.id)?.stars || 0)}</b></span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function MissionDetail({ app, chapter, onBack, onStartMission }){
  const { RoadmapModel } = getGlobals();
  const missions = chapter.missions || [];
  const completed = missions.filter(mission => Number(getMissionProgress(app.progress, mission.id)?.stars || 0) > 0).length;
  return (
    <div className="screen-stack mission-detail">
      <button className="ghost-button back-button" type="button" onClick={onBack}>‹ Rollenreise</button>
      <section className="scene-hero card">
        <div className="scene-glow" />
        <h1>{chapter.title.toUpperCase()}</h1>
      </section>
      <div className="chapter-progress">
        <span>Kapitel-Fortschritt</span>
        <ProgressBar value={percent(completed, missions.length)} />
        <strong>{completed}/{missions.length}</strong>
      </div>
      <h2 className="section-title">Missionen</h2>
      {missions.map(mission => {
        const unlocked = RoadmapModel.isUnlocked(app.progress, chapter) && RoadmapModel.isUnlocked(app.progress, mission);
        return (
          <article key={mission.id} className={`mission-row card ${mission.missionType === 'boss_scene' ? 'boss' : ''} ${unlocked ? '' : 'locked'}`}>
            <div>
              <h3>{mission.title}</h3>
              <p>{missionLabel(mission)} · {mission.estimatedMinutes} Min · {mission.difficulty}</p>
            </div>
            <div className="mission-reward">
              <span>{mission.rewards?.xp || 0} XP</span>
              <b>{stars(getMissionProgress(app.progress, mission.id)?.stars || 0)}</b>
            </div>
            <button className="row-action" type="button" disabled={!unlocked} onClick={() => onStartMission(mission)}>
              {unlocked ? 'Start' : 'Gesperrt'}
            </button>
          </article>
        );
      })}
      <section className="card criteria-card">
        <h3>Erfolgs-Kriterien</h3>
        <p>✓ 90% oder höher · ✓ Ohne Hilfe bestehen · ✓ Mission abschließen</p>
      </section>
    </div>
  );
}

function LibraryScreen({ app, onLoadScript, onSelectRole }){
  const scripts = app.manifest?.scripts || [];
  return (
    <div className="screen-stack">
      <section className="card">
        <h1>Bibliothek</h1>
        <p className="muted">Skript, Rolle und Lern-Engines an einem Ort.</p>
        <label>Skript</label>
        <select value={app.scriptSrc} onChange={event => onLoadScript(event.target.value)}>
          {scripts.map(item => <option key={scriptOptionSource(item)} value={scriptOptionSource(item)}>{scriptOptionLabel(item)}</option>)}
        </select>
        <label>Rolle</label>
        <select value={app.roleRoadmap?.roleId || ''} onChange={event => onSelectRole(event.target.value)}>
          {app.roadmap?.roles?.map(role => <option key={role.roleId} value={role.roleId}>{role.label}</option>)}
        </select>
      </section>
      <section className="mode-list">
        {LEGACY_MODES.map(mode => (
          <a className="card mode-link" key={mode.id} href="./legacy.html">
            <div>
              <h2>{mode.label}</h2>
              <p>{mode.description}</p>
            </div>
            <span>Öffnen</span>
          </a>
        ))}
      </section>
    </div>
  );
}

function StatsScreen({ app }){
  const { RoadmapModel } = getGlobals();
  const summary = progressSummary(app.roleRoadmap, app.progress, RoadmapModel);
  const scenes = sceneProgress(app.roleRoadmap, app.progress).slice(0, 6);
  const reviews = nextReviews(app.roleRoadmap, app.progress, 3);
  return (
    <div className="screen-stack">
      <section className="card mastery-graph">
        <p>Gesamtmeisterschaft</p>
        <strong>{summary.percent}%</strong>
        <svg className="mastery-sparkline" viewBox="0 0 180 72" aria-hidden="true">
          <defs>
            <linearGradient id="sparkGradient" x1="0" x2="1">
              <stop offset="0%" stopColor="#6FAE26" />
              <stop offset="100%" stopColor="#A7E34A" />
            </linearGradient>
          </defs>
          <path className="sparkline-shadow" d="M6 58 C24 50 36 55 52 44 S82 38 98 30 124 34 142 20 160 18 174 8" />
          <path className="sparkline-line" d="M6 58 C24 50 36 55 52 44 S82 38 98 30 124 34 142 20 160 18 174 8" />
          <circle cx="174" cy="8" r="4" />
        </svg>
      </section>
      <section className="stats-grid">
        <MetricCard label="Streak" value={app.progress?.streakDays || 0} suffix="Tage" />
        <MetricCard label="Übungszeit" value="4h 35m" />
        <RingCard label="Genauigkeit" value={`${estimateAccuracy(app.progress)}%`} progress={estimateAccuracy(app.progress)} />
      </section>
      <section className="card">
        <h2>Szenen-Fortschritt</h2>
        {scenes.map(scene => (
          <div className="scene-row" key={scene.id}>
            <span>{scene.title}</span>
            <ProgressBar value={scene.percent} />
            <b>{scene.percent}%</b>
          </div>
        ))}
      </section>
      <section className="card">
        <h2>Abzeichen</h2>
        <div className="badge-grid">
          {(app.progress?.badges?.length ? app.progress.badges : ['cue-meister','dialog-profi','premierenreif']).slice(0, 3).map(id => (
            <span className="achievement" key={id}>{badgeLabel(id)}</span>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Nächste Reviews</h2>
        {reviews.length ? reviews.map(item => <p key={item.mission.id} className="review-row">{item.mission.title}<span>{relativeReview(item.progress.nextReviewAt)}</span></p>) : <p className="muted">Keine Reviews geplant.</p>}
      </section>
    </div>
  );
}

function ProfileScreen({ app, auth, onCreateProfile, onSelectProfile, onSelectRole, onSignOut }){
  const [name, setName] = useState('');
  return (
    <div className="screen-stack">
      <section className="card profile-card">
        <div className="portrait-orb">{initials(app.roleRoadmap?.label)}</div>
        <div>
          <h1>{app.profile?.displayName || 'Local Player'}</h1>
          <p>{auth.user?.email || 'Supabase Account'} · {app.roleRoadmap?.label || 'Rolle'} · {app.scriptTitle}</p>
        </div>
      </section>
      <section className="card">
        <label>Profil wechseln</label>
        <select value={app.profile?.id || ''} onChange={event => onSelectProfile(event.target.value)}>
          {app.profileState?.profiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
        </select>
        <label>Neues Profil</label>
        <div className="inline-form">
          <input value={name} onChange={event => setName(event.target.value)} placeholder="Name" />
          <button type="button" onClick={() => {
            if(clean(name)) onCreateProfile(name);
            setName('');
          }}>Anlegen</button>
        </div>
        <label>Standardrolle</label>
        <select value={app.roleRoadmap?.roleId || ''} onChange={event => onSelectRole(event.target.value)}>
          {app.roadmap?.roles?.map(role => <option key={role.roleId} value={role.roleId}>{role.label}</option>)}
        </select>
      </section>
      <button className="secondary-button" type="button" onClick={onSignOut}>Supabase-Account abmelden</button>
      <a className="primary-button legacy-link" href="./legacy.html">Legacy-App öffnen</a>
    </div>
  );
}

function MissionRunner({ app, runner, setRunner, onClose, onFinish }){
  const entry = runner.entries[runner.index];
  const context = entry
    ? window.ScriptModel.getContextForEntry(app.runtime.learnableEntries, entry.id, { role: entry.speaker })
    : null;

  function next(known){
    const misses = known ? runner.misses : runner.misses + 1;
    const nextIndex = runner.index + 1;
    if(nextIndex >= runner.entries.length){
      const accuracy = runner.entries.length ? Math.max(0, (runner.entries.length - misses) / runner.entries.length) : 1;
      onFinish({ accuracy, hintsUsed: runner.hints });
      return;
    }
    setRunner(prev => ({ ...prev, index:nextIndex, misses, revealed:false }));
  }

  if(runner.done){
    return (
      <div className="runner-overlay">
        <section className="runner-card done">
          <h1>Mission abgeschlossen</h1>
          <div className="finish-stars">{stars(runner.stars)}</div>
          <p>{Math.round((runner.result?.accuracy || 0) * 100)}% Treffer · {runner.result?.hintsUsed || 0} Hilfen · {formatNumber(runner.totalXp)} XP gesamt</p>
          <button className="primary-button" type="button" onClick={onClose}>Weiter</button>
        </section>
      </div>
    );
  }

  return (
    <div className="runner-overlay">
      <section className="runner-card">
        <div className="runner-top">
          <button className="icon-button" type="button" onClick={onClose} aria-label="Mission schließen"><Icon name="close" /></button>
          <ProgressBar value={percent(runner.index + 1, runner.entries.length)} />
          <span className="hearts">♥ 5</span>
        </div>
        <p className="runner-kicker">Mission: {missionLabel(runner.mission)}</p>
        <p className="muted">{runner.mission.title} · {runner.index + 1}/{runner.entries.length}</p>
        <div className="cue-card">
          {context?.prev && <p className="speaker">{context.prev.speaker}</p>}
          <h2>{context?.prev?.text || 'Starte diese Zeile ohne Vorlauf.'}</h2>
          <div className="mask-divider">◆</div>
          <h3>Dein Satz</h3>
          <p className="muted">Was antwortest du?</p>
          {runner.revealed && entry && <div className="answer-line"><b>{entry.speaker}</b>: {entry.text}</div>}
        </div>
        <div className="runner-actions">
          <button className="secondary-button" type="button" onClick={() => setRunner(prev => ({ ...prev, hints: prev.hints + 1, revealed:true }))}>Tipp</button>
          <button className="secondary-button" type="button" onClick={() => setRunner(prev => ({ ...prev, hints: prev.hints + 1, revealed:true }))}>Antwort anzeigen</button>
          <button className="secondary-button large" type="button" onClick={() => next(false)}>Nochmal</button>
          <button className="primary-button large" type="button" onClick={() => next(true)}>Ich weiß es</button>
        </div>
      </section>
    </div>
  );
}

function MetricCard({ label, value, suffix = '' }){
  return <article className="card metric-card"><span>{label}</span><strong>{value}</strong>{suffix && <small>{suffix}</small>}</article>;
}

function RingCard({ label, value, progress }){
  return (
    <article className="card ring-card">
      <div className="ring" style={{ '--progress': `${progress}%` }}><strong>{value}</strong></div>
      <span>{label}</span>
    </article>
  );
}

function QuickCard({ title, value, onClick }){
  return <button className="card quick-card" type="button" onClick={onClick}><span>{title}</span><strong>{value}</strong></button>;
}

function ProgressBar({ value }){
  return <div className="progress-track"><i style={{ width: `${value}%` }} /></div>;
}

function entriesForMission(runtime, mission){
  const map = buildEntryMap(runtime);
  return (mission?.entryIds || []).map(id => map.get(id)).filter(Boolean);
}

function missionLabel(mission){
  return window.RoadmapModel?.MISSION_LABELS?.[mission?.missionType] || mission?.missionType || 'Mission';
}

function initials(value){
  const text = clean(value || 'SC');
  return text.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function bossStatus(roleRoadmap, progress){
  const boss = roleRoadmap?.chapters?.flatMap(chapter => chapter.missions || []).filter(mission => mission.missionType === 'boss_scene') || [];
  const done = boss.filter(mission => getMissionProgress(progress, mission.id)?.status === 'completed').length;
  return done ? `${done}/${boss.length} geschafft` : 'Finale';
}

function relativeReview(value){
  const diff = new Date(value).getTime() - Date.now();
  if(diff <= 0) return 'Jetzt';
  const hours = Math.round(diff / 36e5);
  if(hours < 24) return `In ${hours}h`;
  return 'Morgen';
}

createRoot(document.getElementById('root')).render(<App />);
