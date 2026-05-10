(function(){
  'use strict';

  const RoadmapModel = window.RoadmapModel;
  const ProfileStore = window.ProfileStore;
  const ScriptModel = window.ScriptModel;

  const state = {
    runtime: null,
    roadmap: null,
    scriptId: '',
    store: null,
    storeState: null,
    profile: null,
    roleRoadmap: null,
    progress: null,
    activeMission: null,
    missionIndex: 0,
    hintsUsed: 0,
    misses: 0,
    initialized: false,
    config: {}
  };

  const refs = {};

  function $(id){
    return document.getElementById(id);
  }

  function clean(value){
    return String(value || '').trim();
  }

  function escapeHtml(value){
    return String(value || '').replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[char]));
  }

  function scriptIdFromSource(value){
    const source = clean(value).split('?')[0].split('/').pop() || 'script';
    return source.replace(/\.[^.]+$/, '') || 'script';
  }

  function emitReward(){
    try{
      if(typeof window.confetti === 'function'){
        window.confetti({ particleCount: 80, spread: 72, origin: { y: 0.7 } });
      }
    }catch(_){}
  }

  function getActiveProfile(){
    if(!state.storeState || !state.storeState.profiles.length) return null;
    return state.storeState.profiles.find(profile => profile.id === state.storeState.activeProfileId) || state.storeState.profiles[0];
  }

  function missionById(roleRoadmap, missionId){
    return RoadmapModel.flattenMissions(roleRoadmap).find(mission => mission.id === missionId) || null;
  }

  function entriesForMission(mission){
    if(!state.runtime || !mission) return [];
    const byId = new Map(state.runtime.learnableEntries.map(entry => [entry.id, entry]));
    return mission.entryIds.map(id => byId.get(id)).filter(Boolean);
  }

  function starsForMission(missionId){
    return Number(state.progress?.missions?.[missionId]?.stars || 0);
  }

  function renderStars(count){
    return '★'.repeat(Math.max(0, count)) + '☆'.repeat(Math.max(0, 3 - count));
  }

  function progressSummary(roleRoadmap, progress){
    const missions = RoadmapModel.flattenMissions(roleRoadmap);
    const completed = missions.filter(mission => (progress?.missions?.[mission.id]?.stars || 0) > 0);
    const stars = missions.reduce((sum, mission) => sum + Number(progress?.missions?.[mission.id]?.stars || 0), 0);
    const maxStars = missions.length * 3;
    return {
      missions: missions.length,
      completed: completed.length,
      stars,
      maxStars,
      percent: missions.length ? Math.round((completed.length / missions.length) * 100) : 0
    };
  }

  function roleOptions(){
    return (state.roadmap?.roles || []).map(role => `<option value="${escapeHtml(role.roleId)}">${escapeHtml(role.label)}</option>`).join('');
  }

  async function ensureProgress(){
    if(!state.profile || !state.roleRoadmap) return null;
    const progress = await state.store.getProgress(
      state.profile.id,
      state.scriptId,
      state.roleRoadmap.roleId,
      () => RoadmapModel.createDefaultProgress({
        profileId: state.profile.id,
        scriptId: state.scriptId,
        roleId: state.roleRoadmap.roleId
      })
    );
    state.progress = progress;
    return progress;
  }

  async function saveProfile(profile){
    await state.store.upsertProfile(profile);
    state.storeState = await state.store.loadState();
    state.profile = getActiveProfile();
  }

  async function chooseRole(roleId){
    state.roleRoadmap = RoadmapModel.getRoleRoadmap(state.roadmap, roleId) || state.roadmap?.roles?.[0] || null;
    if(state.profile && state.roleRoadmap){
      state.profile = Object.assign({}, state.profile, {
        scriptId: state.scriptId,
        roleId: state.roleRoadmap.roleId
      });
      await saveProfile(state.profile);
    }
    await ensureProgress();
    render();
  }

  async function createProfileFromInput(){
    const name = clean(refs.profileName?.value) || 'Local Player';
    const roleId = refs.roleSelect?.value || state.roadmap?.roles?.[0]?.roleId || '';
    const profile = ProfileStore.createDefaultProfile({ displayName:name, scriptId:state.scriptId, roleId });
    await state.store.upsertProfile(profile);
    await state.store.setActiveProfile(profile.id);
    state.storeState = await state.store.loadState();
    state.profile = getActiveProfile();
    state.roleRoadmap = RoadmapModel.getRoleRoadmap(state.roadmap, roleId) || state.roadmap?.roles?.[0] || null;
    await ensureProgress();
    render();
  }

  async function selectProfile(profileId){
    await state.store.setActiveProfile(profileId);
    state.storeState = await state.store.loadState();
    state.profile = getActiveProfile();
    state.roleRoadmap = RoadmapModel.getRoleRoadmap(state.roadmap, state.profile?.roleId) || state.roadmap?.roles?.[0] || null;
    await ensureProgress();
    render();
  }

  function renderEmpty(message){
    if(refs.root) refs.root.innerHTML = `<div class="roadmap-empty">${escapeHtml(message)}</div>`;
  }

  function renderProfileBar(){
    const profiles = state.storeState?.profiles || [];
    return `
      <section class="roadmap-toolbar">
        <div class="roadmap-profile-switcher">
          <label for="roadmapProfileSelect">Profil</label>
          <select id="roadmapProfileSelect">
            ${profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === state.profile?.id ? 'selected' : ''}>${escapeHtml(profile.displayName)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="roadmapProfileName">Neues Profil</label>
          <div class="script-row">
            <input id="roadmapProfileName" type="text" placeholder="Name">
            <button class="btn secondary" id="roadmapAddProfile" type="button">Anlegen</button>
          </div>
        </div>
        <div>
          <label for="roadmapRoleSelect">Rolle</label>
          <select id="roadmapRoleSelect">${roleOptions()}</select>
        </div>
      </section>
    `;
  }

  function renderDashboard(){
    const profile = state.roleRoadmap?.profile || {};
    const summary = progressSummary(state.roleRoadmap, state.progress);
    const due = RoadmapModel.dueMissions(state.roleRoadmap, state.progress).length;
    return `
      <section class="roadmap-dashboard">
        <article class="roadmap-stat">
          <span>XP</span>
          <strong>${Number(state.progress?.xp || 0)}</strong>
        </article>
        <article class="roadmap-stat">
          <span>Streak</span>
          <strong>${Number(state.progress?.streakDays || 0)} Tage</strong>
        </article>
        <article class="roadmap-stat">
          <span>Fortschritt</span>
          <strong>${summary.percent}%</strong>
        </article>
        <article class="roadmap-stat">
          <span>Review</span>
          <strong>${due} faellig</strong>
        </article>
      </section>
      <section class="roadmap-hero-card">
        <div>
          <p class="roadmap-kicker">${escapeHtml(state.roadmap?.title || 'Game Roadmap')}</p>
          <h2>${escapeHtml(state.roleRoadmap?.label || 'Rolle')}</h2>
          <p>${profile.lineCount || 0} Zeilen · ${profile.wordCount || 0} Woerter · ${profile.sceneCount || 0} Szenen · ${escapeHtml(profile.difficulty || 'easy')}</p>
        </div>
        <div class="roadmap-ring" style="--progress:${summary.percent}%">
          <strong>${summary.completed}/${summary.missions}</strong>
          <span>Missionen</span>
        </div>
      </section>
    `;
  }

  function renderMission(mission, chapterLocked){
    const missionProgress = state.progress?.missions?.[mission.id] || {};
    const unlocked = !chapterLocked && RoadmapModel.isUnlocked(state.progress, mission);
    const stars = Number(missionProgress.stars || 0);
    return `
      <article class="mission-card ${unlocked ? '' : 'is-locked'} ${stars ? 'is-complete' : ''}" data-mission-id="${escapeHtml(mission.id)}">
        <div class="mission-card__meta">
          <span>${escapeHtml(RoadmapModel.MISSION_LABELS[mission.missionType] || mission.missionType)}</span>
          <span>${escapeHtml(mission.difficulty)}</span>
          <span>${mission.estimatedMinutes} min</span>
        </div>
        <h4>${escapeHtml(mission.title)}</h4>
        <p>${escapeHtml(mission.goal)}</p>
        <div class="mission-card__footer">
          <strong class="stars">${renderStars(stars)}</strong>
          <button class="btn ${unlocked ? '' : 'secondary'}" type="button" data-start-mission="${escapeHtml(mission.id)}" ${unlocked ? '' : 'disabled'}>
            ${stars ? 'Wiederholen' : unlocked ? 'Start' : 'Gesperrt'}
          </button>
        </div>
      </article>
    `;
  }

  function renderChapters(){
    const chapters = state.roleRoadmap?.chapters || [];
    return `
      <section class="roadmap-map">
        ${chapters.map((chapter, index) => {
          const chapterLocked = !RoadmapModel.isUnlocked(state.progress, chapter);
          const missions = chapter.missions || [];
          const completed = missions.filter(mission => starsForMission(mission.id) > 0).length;
          return `
            <article class="chapter-node ${chapterLocked ? 'is-locked' : ''}">
              <div class="chapter-node__head">
                <div class="chapter-node__marker">${chapterLocked ? '🔒' : index + 1}</div>
                <div>
                  <p class="roadmap-kicker">${escapeHtml(chapter.difficulty)} · ${chapter.metrics?.lineCount || 0} Zeilen</p>
                  <h3>${escapeHtml(chapter.title)}</h3>
                  <p>${completed}/${missions.length} Missionen</p>
                </div>
              </div>
              <div class="mission-grid">
                ${missions.map(mission => renderMission(mission, chapterLocked)).join('')}
              </div>
            </article>
          `;
        }).join('')}
      </section>
    `;
  }

  function renderBadges(){
    const badges = state.progress?.badges || [];
    if(!badges.length) return '<div class="faded">Noch keine Badges. Schließe Missionen ab, um welche zu verdienen.</div>';
    return `<div class="badge-list">${badges.map(badge => `<span class="reward-badge">${escapeHtml(badge)}</span>`).join('')}</div>`;
  }

  function render(){
    if(!refs.root) return;
    if(!state.runtime){
      renderEmpty('Noch kein Skript geladen.');
      return;
    }
    if(!state.roadmap || !state.roadmap.roles.length){
      renderEmpty('Dieses Skript hat noch keine lernbaren Rollen.');
      return;
    }
    if(!state.profile || !state.roleRoadmap || !state.progress){
      renderEmpty('Roadmap wird vorbereitet.');
      return;
    }

    refs.root.innerHTML = `
      ${renderProfileBar()}
      ${renderDashboard()}
      <section class="panel roadmap-panel">
        <div class="roadmap-panel__head">
          <h2>Story-Map</h2>
          <button class="btn secondary" type="button" id="roadmapDailyBtn">Daily Review</button>
        </div>
        ${renderChapters()}
      </section>
      <section class="panel roadmap-panel">
        <div class="roadmap-panel__head">
          <h2>Rewards</h2>
          <span>${renderStars(Math.min(3, Math.floor((state.progress.xp || 0) / 500)))}</span>
        </div>
        ${renderBadges()}
      </section>
    `;
    bindDynamicRefs();
  }

  function bindDynamicRefs(){
    refs.profileSelect = $('roadmapProfileSelect');
    refs.profileName = $('roadmapProfileName');
    refs.addProfile = $('roadmapAddProfile');
    refs.roleSelect = $('roadmapRoleSelect');

    if(refs.profileSelect){
      refs.profileSelect.addEventListener('change', () => selectProfile(refs.profileSelect.value));
    }
    if(refs.addProfile){
      refs.addProfile.addEventListener('click', createProfileFromInput);
    }
    if(refs.roleSelect){
      refs.roleSelect.value = state.roleRoadmap?.roleId || refs.roleSelect.value;
      refs.roleSelect.addEventListener('change', () => chooseRole(refs.roleSelect.value));
    }
    document.querySelectorAll('[data-start-mission]').forEach(button => {
      button.addEventListener('click', () => startMission(button.dataset.startMission));
    });
    const daily = $('roadmapDailyBtn');
    if(daily){
      daily.addEventListener('click', () => {
        const mission = RoadmapModel.dueMissions(state.roleRoadmap, state.progress)[0];
        if(mission) startMission(mission.id);
      });
    }
  }

  function startMission(missionId){
    const mission = missionById(state.roleRoadmap, missionId);
    if(!mission) return;
    state.activeMission = mission;
    state.missionIndex = 0;
    state.hintsUsed = 0;
    state.misses = 0;
    renderRunner();
  }

  function renderRunner(){
    if(!refs.runner || !state.activeMission) return;
    const entries = entriesForMission(state.activeMission);
    const entry = entries[state.missionIndex];
    if(!entry){
      finishMission();
      return;
    }
    const context = ScriptModel.getContextForEntry(state.runtime.learnableEntries, entry.id, { role:entry.speaker });
    refs.runner.hidden = false;
    refs.runner.innerHTML = `
      <div class="mission-runner__card">
        <div class="mission-runner__head">
          <div>
            <p class="roadmap-kicker">${escapeHtml(RoadmapModel.MISSION_LABELS[state.activeMission.missionType] || state.activeMission.missionType)}</p>
            <h3>${escapeHtml(state.activeMission.title)}</h3>
          </div>
          <button class="iconbtn" type="button" id="missionClose" aria-label="Mission schliessen">×</button>
        </div>
        <div class="bar">
          <div class="progress"><i style="width:${Math.round(((state.missionIndex + 1) / entries.length) * 100)}%"></i></div>
          <div class="faded">${state.missionIndex + 1}/${entries.length}</div>
        </div>
        ${context.prev ? `<div class="fc-ctx fc-ctx--top">${escapeHtml(context.prev.speaker)}: ${escapeHtml(context.prev.text)}</div>` : ''}
        <div class="line big mission-line" data-answer hidden>${escapeHtml(entry.speaker)}: ${escapeHtml(entry.text)}</div>
        <div class="line big mission-line mission-line--prompt">Deine Zeile fuer ${escapeHtml(entry.speaker)}</div>
        ${context.next ? `<div class="fc-ctx fc-ctx--bottom">${escapeHtml(context.next.speaker)}: ${escapeHtml(context.next.text)}</div>` : ''}
        <div class="mission-actions">
          <button class="btn secondary" type="button" id="missionReveal">Hilfe</button>
          <button class="btn secondary" type="button" id="missionMiss">Falsch</button>
          <button class="btn" type="button" id="missionKnown">Gewusst</button>
        </div>
      </div>
    `;
    $('missionClose')?.addEventListener('click', closeRunner);
    $('missionReveal')?.addEventListener('click', () => {
      state.hintsUsed += 1;
      const answer = refs.runner.querySelector('[data-answer]');
      const prompt = refs.runner.querySelector('.mission-line--prompt');
      if(answer) answer.hidden = false;
      if(prompt) prompt.hidden = true;
    });
    $('missionMiss')?.addEventListener('click', () => {
      state.misses += 1;
      state.missionIndex += 1;
      renderRunner();
    });
    $('missionKnown')?.addEventListener('click', () => {
      state.missionIndex += 1;
      renderRunner();
    });
  }

  async function finishMission(){
    const entries = entriesForMission(state.activeMission);
    const accuracy = entries.length ? Math.max(0, (entries.length - state.misses) / entries.length) : 1;
    state.progress = RoadmapModel.completeMission(state.progress, state.activeMission, {
      accuracy,
      hintsUsed: state.hintsUsed
    });
    await state.store.saveProgress(state.progress);
    emitReward();
    if(refs.runner){
      const stars = state.progress.missions[state.activeMission.id].stars;
      refs.runner.hidden = false;
      refs.runner.innerHTML = `
        <div class="mission-runner__card mission-runner__card--done">
          <h3>Mission abgeschlossen</h3>
          <div class="stars mission-stars">${renderStars(stars)}</div>
          <p>${Math.round(accuracy * 100)}% Treffer · ${state.hintsUsed} Hilfen · ${Number(state.progress.xp || 0)} XP gesamt</p>
          <button class="btn" type="button" id="missionDoneClose">Weiter</button>
        </div>
      `;
      $('missionDoneClose')?.addEventListener('click', closeRunner);
    }
  }

  function closeRunner(){
    state.activeMission = null;
    if(refs.runner){
      refs.runner.hidden = true;
      refs.runner.innerHTML = '';
    }
    render();
  }

  async function setRuntime(runtime, options = {}){
    state.runtime = runtime;
    state.scriptId = clean(options.scriptId) || scriptIdFromSource(options.scriptSrc) || 'script';
    state.roadmap = RoadmapModel.buildRoadmap(runtime, { scriptId:state.scriptId });
    const validation = RoadmapModel.validateRoadmap(state.roadmap, runtime);
    state.roadmap = validation.roadmap;
    await state.store.ensureProfile({
      displayName: localStorage.getItem('hl_player_name') || 'Local Player',
      scriptId: state.scriptId,
      roleId: state.roadmap.roles[0]?.roleId || ''
    });
    state.storeState = await state.store.loadState();
    state.profile = getActiveProfile();
    state.roleRoadmap = RoadmapModel.getRoleRoadmap(state.roadmap, state.profile?.roleId) || state.roadmap.roles[0] || null;
    if(state.profile && state.roleRoadmap && state.profile.roleId !== state.roleRoadmap.roleId){
      state.profile = Object.assign({}, state.profile, { scriptId:state.scriptId, roleId:state.roleRoadmap.roleId });
      await saveProfile(state.profile);
    }
    await ensureProgress();
    render();
  }

  function init(config = {}){
    if(state.initialized) return;
    state.initialized = true;
    state.config = config;
    refs.root = $('roadmapRoot');
    refs.runner = $('roadmapRunner');
    state.store = ProfileStore.createStore({
      indexedDB: window.indexedDB,
      localStorage: window.localStorage
    });
  }

  window.RoadmapUI = {
    init,
    setRuntime,
    render,
    state
  };
})();
