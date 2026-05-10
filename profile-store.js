(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.ProfileStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const DB_NAME = 'musical-roadmap-profiles';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const KEYS = {
    profiles: 'hl_profiles_v1',
    activeProfileId: 'hl_active_profile_id',
    progress: 'hl_roadmap_progress_v1'
  };
  const AVATARS = ['Spotlight', 'Cue', 'Star', 'Stage', 'Encore'];
  const COLORS = ['#58CC02', '#1CB0F6', '#FFB020', '#F04438', '#7A5AF8'];

  function clone(value){
    return JSON.parse(JSON.stringify(value));
  }

  function clean(value){
    return String(value || '').trim();
  }

  function scopedKey(namespace, key){
    const scope = clean(namespace);
    return scope ? `${scope}:${key}` : key;
  }

  function safeJsonParse(value, fallback){
    try{
      return value ? JSON.parse(value) : fallback;
    }catch(_){
      return fallback;
    }
  }

  function makeId(prefix){
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createDefaultProfile({ displayName = 'Local Player', scriptId = '', roleId = '', userId = '' } = {}){
    const index = Math.abs(clean(displayName).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0));
    return {
      id: makeId('profile'),
      displayName: clean(displayName) || 'Local Player',
      avatar: AVATARS[index % AVATARS.length],
      color: COLORS[index % COLORS.length],
      userId: clean(userId),
      scriptId: clean(scriptId),
      roleId: clean(roleId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function createEmptyState(){
    return {
      profiles: [],
      activeProfileId: '',
      progress: {}
    };
  }

  function openDatabase(indexedDBRef){
    if(!indexedDBRef) return Promise.resolve(null);
    return new Promise(resolve => {
      const request = indexedDBRef.open(DB_NAME, DB_VERSION);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        const db = request.result;
        if(!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function dbGet(db, key){
    return new Promise(resolve => {
      if(!db) return resolve(undefined);
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function dbSet(db, key, value){
    return new Promise(resolve => {
      if(!db) return resolve(false);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function readLocal(localStorageRef, keys = KEYS){
    if(!localStorageRef) return createEmptyState();
    return {
      profiles: safeJsonParse(localStorageRef.getItem(keys.profiles), []),
      activeProfileId: localStorageRef.getItem(keys.activeProfileId) || '',
      progress: safeJsonParse(localStorageRef.getItem(keys.progress), {})
    };
  }

  function writeLocal(localStorageRef, state, keys = KEYS){
    if(!localStorageRef) return;
    localStorageRef.setItem(keys.profiles, JSON.stringify(state.profiles || []));
    localStorageRef.setItem(keys.activeProfileId, state.activeProfileId || '');
    localStorageRef.setItem(keys.progress, JSON.stringify(state.progress || {}));
  }

  function normalizeState(state){
    const next = Object.assign(createEmptyState(), state || {});
    next.profiles = Array.isArray(next.profiles) ? next.profiles : [];
    next.progress = next.progress && typeof next.progress === 'object' ? next.progress : {};
    if(!next.activeProfileId && next.profiles[0]) next.activeProfileId = next.profiles[0].id;
    if(next.activeProfileId && !next.profiles.some(profile => profile.id === next.activeProfileId)){
      next.activeProfileId = next.profiles[0] ? next.profiles[0].id : '';
    }
    return next;
  }

  function progressKey(profileId, scriptId, roleId){
    return [profileId, scriptId, roleId].map(clean).join('::');
  }

  function createStore({ indexedDB: indexedDBRef, localStorage: localStorageRef, namespace = '' } = {}){
    let dbPromise = openDatabase(indexedDBRef);
    let cachedState = null;
    const keys = {
      profiles: scopedKey(namespace, KEYS.profiles),
      activeProfileId: scopedKey(namespace, KEYS.activeProfileId),
      progress: scopedKey(namespace, KEYS.progress)
    };
    const dbStateKey = scopedKey(namespace, 'state');

    async function loadState(){
      if(cachedState) return clone(cachedState);
      const db = await dbPromise;
      const fromDb = db ? await dbGet(db, dbStateKey) : null;
      const state = normalizeState(fromDb || readLocal(localStorageRef, keys));
      cachedState = state;
      if(!fromDb && db) await dbSet(db, dbStateKey, state);
      writeLocal(localStorageRef, state, keys);
      return clone(state);
    }

    async function saveState(state){
      const next = normalizeState(state);
      next.profiles = next.profiles.map(profile => Object.assign({}, profile, { updatedAt:new Date().toISOString() }));
      cachedState = next;
      const db = await dbPromise;
      if(db) await dbSet(db, dbStateKey, next);
      writeLocal(localStorageRef, next, keys);
      return clone(next);
    }

    async function ensureProfile(defaults = {}){
      const state = await loadState();
      if(state.profiles.length){
        return {
          state,
          profile: state.profiles.find(profile => profile.id === state.activeProfileId) || state.profiles[0]
        };
      }
      const profile = createDefaultProfile(defaults);
      state.profiles.push(profile);
      state.activeProfileId = profile.id;
      const saved = await saveState(state);
      return { state:saved, profile };
    }

    async function upsertProfile(profile){
      const state = await loadState();
      const payload = Object.assign(createDefaultProfile(profile), profile || {}, { updatedAt:new Date().toISOString() });
      const index = state.profiles.findIndex(item => item.id === payload.id);
      if(index >= 0) state.profiles[index] = payload;
      else state.profiles.push(payload);
      if(!state.activeProfileId) state.activeProfileId = payload.id;
      return saveState(state);
    }

    async function setActiveProfile(profileId){
      const state = await loadState();
      if(state.profiles.some(profile => profile.id === profileId)){
        state.activeProfileId = profileId;
      }
      return saveState(state);
    }

    async function getProgress(profileId, scriptId, roleId, fallbackFactory){
      const state = await loadState();
      const key = progressKey(profileId, scriptId, roleId);
      if(!state.progress[key] && typeof fallbackFactory === 'function'){
        state.progress[key] = fallbackFactory();
        await saveState(state);
      }
      return clone(state.progress[key] || null);
    }

    async function saveProgress(progress){
      const state = await loadState();
      const key = progressKey(progress.profileId, progress.scriptId, progress.roleId);
      state.progress[key] = clone(progress);
      await saveState(state);
      return clone(progress);
    }

    return {
      keys,
      loadState,
      saveState,
      ensureProfile,
      upsertProfile,
      setActiveProfile,
      getProgress,
      saveProgress,
      progressKey
    };
  }

  return {
    KEYS,
    createDefaultProfile,
    createStore,
    progressKey,
    createEmptyState
  };
});
