/* =================== BaseDir & Pfade =================== */
const CURRENT_DIR = (() => {
  const p = location.pathname;
  if (p.endsWith('/')) return p;
  return p.slice(0, p.lastIndexOf('/') + 1) || '/';
})();

/* CodePen-Fallback: JSONs vom Repo via jsDelivr holen */
const IS_PEN   = /codepen|cdpn\.io/.test(location.host);
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/jakobklucke/horrorladen-app@main/';

/* =================== Supabase =================== */
const SUPABASE_URL = 'https://aaxogoaxwultqlsrgpvx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFheG9nb2F4d3VsdHFsc3JncHZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2ODE0OTEsImV4cCI6MjA4NTI1NzQ5MX0.V82zIo-tyNk1BjaJKVFpGxypKvb_HKqHPAyDopsl1QQ';
const supa = (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;
const ScriptModel = window.ScriptModel;

function normalizeScriptPath(p){
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;                // absolute URLs lassen
  if (IS_PEN) return CDN_BASE + p.replace(/^\//,'');    // in CodePen -> CDN
  if (p.startsWith(location.pathname) || p.startsWith('/')) return p;
  if (p.startsWith('./')) p = p.slice(2);
  return CURRENT_DIR + p;
}

async function fetchJson(paths){
  for(const raw of paths){
    const url = normalizeScriptPath(raw);
    try{
      const r = await fetch(url, { cache:'no-store' });
      if(r.ok) return await r.json();
    }catch(_){}
  }
  throw new Error('Konnte keine Datei laden aus: ' + paths.join(', '));
}

/* =================== Utilities =================== */
function toNodes(x){
  if(x==null) return [];
  if(Array.isArray(x)) return x.flatMap(toNodes);
  if(x instanceof Node) return [x];
  if(typeof x==='string' || typeof x==='number') return [document.createTextNode(String(x))];
  return [];
}
const el = (t, a={}, ...kids)=>{
  const n=document.createElement(t);
  for(const [k,v] of Object.entries(a)){
    if(k==='class') n.className=v;
    else if(k==='html') n.innerHTML=v;
    else n.setAttribute(k,v);
  }
  toNodes(kids).forEach(ch=>n.appendChild(ch));
  return n;
};
const escapeHtml=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm=s=>(s||'').trim().toUpperCase();

/* =================== Prefs/State =================== */
const LS={ name:'hl_player_name', src:'hl_json_src', sfx:'hl_sfx_on', motion:'hl_reduce_motion', scriptChosen:'hl_script_chosen', lastMode:'hl_last_mode' };

let jsonSrc; {
  const rawSrc = localStorage.getItem(LS.src) || 'horrorladen_final_with_acts.json';
  jsonSrc = normalizeScriptPath(rawSrc);
  localStorage.setItem(LS.src, jsonSrc);
}

let sfxOn = localStorage.getItem(LS.sfx);
if(sfxOn==null){ sfxOn=true; localStorage.setItem(LS.sfx,'1'); }
else sfxOn = sfxOn==='1';

let reduceMotion = localStorage.getItem(LS.motion);
if(reduceMotion==null){ reduceMotion=false; localStorage.setItem(LS.motion,'0'); }
else reduceMotion = reduceMotion==='1';

const state={
  canonical:null, runtime:null,
  entries:[], items:[], roles:[],
  acts:[], scenes:[], songs:[],
  // Learn
  pageIndex:0, pageSizeClassic:8, pageSizeSingle:1, lastFiltered:[],
  // Viewer
  viewerIndex:0, viewerPageSize:20, viewerLast:[], viewerHighlightRole:'',
  // Scripts index
  indexFromScriptsJson:[],
  // Navigation
  inExercise:false
};

const treatSpeaker=sp=>{
  const s=norm(sp);
  if(s==='DIE ANDEREN') return 'ALLE';
  if(s==='BARAPAPAPA'||s==='BARAPAPAPABA') return '__IGNORE__';
  return s;
};

/* =================== Sound / Press Feedback =================== */
const AudioC = window.AudioContext || window.webkitAudioContext; let ac;
function tone(seq=[0],dur=.12,type='triangle',base=640){
  if(!sfxOn || !AudioC) return; ac=ac||new AudioC();
  const o=ac.createOscillator(), g=ac.createGain(); o.type=type; o.connect(g).connect(ac.destination);
  const now=ac.currentTime; let t=now; g.gain.setValueAtTime(.0001,now); g.gain.linearRampToValueAtTime(.22,now+.01);
  seq.forEach(semi=>{ o.frequency.setValueAtTime(base*Math.pow(2,semi/12),t); t+=dur; });
  g.gain.exponentialRampToValueAtTime(.0001,t+.04); o.start(now); o.stop(t+.05);
}
document.addEventListener('pointerdown', (e)=>{
  const t=e.target.closest('.btn, .opt, .mode-card, [data-nav], [data-goto-learn], [data-sfx]');
  if(!t) return;
  if(!(t.classList&&t.classList.contains('no-sfx'))) tone([0],.07);
  const btn=e.target.closest('.btn'); if(btn) btn.classList.add('pressed');
},{capture:true});
['pointerup','pointercancel','mouseleave'].forEach(evt=>{
  document.addEventListener(evt,()=>document.querySelectorAll('.btn.pressed').forEach(b=>b.classList.remove('pressed')), {capture:true});
});

/* =================== Parser =================== */
function looksLikeScriptData(data){
  if(!data) return false;
  if(ScriptModel && ScriptModel.isCanonicalScript(data)) return true;
  if(Array.isArray(data)){
    return data.some(node=>node&&typeof node==='object'&&(node.type||node.speaker||node.act||node.scene||node.song||node.content));
  }
  if(typeof data==='object'){
    return !!(data.entries || data.acts || data.segments || data.children || data.items);
  }
  return false;
}

function parseScriptsJson(data){
  const out=[]; const push=(label,value)=>{ if(value) out.push({label:label||value, value}); };
  const each=(it,i)=>{
    if(typeof it==='string') push(it,it);
    else if(it&&typeof it==='object'){
      const value=it.src||it.file||it.path||it.url||'';
      const label=it.title||it.name||it.label||value||`Skript ${i+1}`;
      push(label,value);
    }
  };
  if(Array.isArray(data)) data.forEach(each);
  else if(data&&typeof data==='object'){
    if(Array.isArray(data.scripts)) data.scripts.forEach(each);
    else if(typeof data.scripts==='object') Object.entries(data.scripts).forEach(([k,v])=>{
      if(typeof v==='string') push(k||v,v);
      else if(v&&typeof v==='object') push(v.title||v.name||k||v.src||v.path||'', v.src||v.file||v.path||'');
    });
    else if(Array.isArray(data.sources)) data.sources.forEach(each);
  }
  return out;
}

function setSelectOptions(sel,options,{placeholder='Alle',preserveValue=''}={}){
  if(!sel) return '';
  const safeOptions=Array.isArray(options)?options:[];
  const currentValue=preserveValue || sel.value || '';
  sel.innerHTML=[`<option value="">${placeholder}</option>`]
    .concat(safeOptions.map(item=>`<option value="${item.value}">${item.label}</option>`))
    .join('');
  const found=safeOptions.find(item=>item.value===currentValue);
  sel.value = found ? found.value : '';
  return sel.value;
}

function getFilterState(useViewer=false){
  return {
    role: useViewer ? '' : (roleSel?.value||''),
    actId: useViewer ? (actSelV?.value||'') : (actSel?.value||''),
    sceneId: useViewer ? (sceneSelV?.value||'') : (sceneSel?.value||''),
    songId: useViewer ? (songSelV?.value||'') : (songSel?.value||''),
    lyricsOnly: useViewer ? !!(lyricsOnlyV&&lyricsOnlyV.checked) : !!(lyricsOnly&&lyricsOnly.checked)
  };
}

function syncScopedFilters(useViewer=false){
  if(!state.runtime) return;
  const actSelect = useViewer ? actSelV : actSel;
  const sceneSelect = useViewer ? sceneSelV : sceneSel;
  const songSelect = useViewer ? songSelV : songSel;
  const actId = actSelect?.value || '';
  const prevScene = sceneSelect?.value || '';
  const prevSong = songSelect?.value || '';
  const scenes = ScriptModel.getScenesForAct(state.runtime, actId).map(scene=>({
    value: scene.id,
    label: scene.label
  }));
  const sceneId = setSelectOptions(sceneSelect, scenes, { preserveValue: prevScene });
  const songs = ScriptModel.getSongsForFilters(state.runtime, { actId, sceneId }).map(song=>({
    value: song.id,
    label: ScriptModel.formatSongLabel(song) || song.label
  }));
  setSelectOptions(songSelect, songs, { preserveValue: prevSong });
}

/* =================== DOM Refs =================== */
const scriptSelect=document.getElementById('scriptSelect');
const scriptsNote =document.getElementById('scriptsNote');
const jsonLabel   =document.getElementById('jsonSrcLabel');
const scriptContinue=document.getElementById('scriptContinue');
const manualToggle=document.getElementById('manualToggle');
const scriptInput=document.getElementById('scriptInput');
const loadScriptBtn=document.getElementById('loadScriptBtn');
const currentScriptLabel=document.getElementById('currentScriptLabel');
const reviewNotice=document.getElementById('reviewNotice');
const reviewSettingsNote=document.getElementById('reviewSettingsNote');
const importStudioLinkHome=document.getElementById('importStudioLinkHome');
const importStudioLinkSettings=document.getElementById('importStudioLinkSettings');
const playerNameInput=document.getElementById('playerName');
const saveSettingsBtn=document.getElementById('saveSettings');
const sfxToggle=document.getElementById('sfxToggle');
const motionToggle=document.getElementById('motionToggle');
const scriptStats=document.getElementById('scriptStats');

const actSel=document.getElementById('actFilter'),
      sceneSel=document.getElementById('sceneFilter'),
      songSel=document.getElementById('songFilter'),
      lyricsOnly=document.getElementById('lyricsOnly'),
      roleSel=document.getElementById('roleSel');

const actSelV=document.getElementById('actFilterV'),
      sceneSelV=document.getElementById('sceneFilterV'),
      songSelV=document.getElementById('songFilterV'),
      lyricsOnlyV=document.getElementById('lyricsOnlyV'),
      viewerRoleSel=document.getElementById('viewerRoleSel');

const roleSurv=document.getElementById('roleSurv');

const learnRoot=document.getElementById('learnRoot'),
      modeSel=document.getElementById('modeSel'),
      startLearnBtn=document.getElementById('startLearn'),
      pager=document.getElementById('learnPager'),
      pagerInfo=document.getElementById('pagerInfo'),
      prevPage=document.getElementById('prevPage'),
      nextPage=document.getElementById('nextPage'),
      learnProg=document.getElementById('learnProg'),
      learnCount=document.getElementById('learnCount');

const viewerRoot=document.getElementById('viewerRoot'),
      viewerPager=document.getElementById('viewerPager'),
      viewerPagerInfo=document.getElementById('viewerPagerInfo'),
      viewerPrev=document.getElementById('viewerPrev'),
      viewerNext=document.getElementById('viewerNext'),
      viewerProg=document.getElementById('viewerProg'),
      viewerCount=document.getElementById('viewerCount');

/* =================== scripts.json -> Dropdown =================== */
async function loadScriptsIndex(){
  try{
    const base = IS_PEN ? CDN_BASE : CURRENT_DIR;
    const idx  = await fetchJson([ base + 'scripts.json' ]);
    const list = parseScriptsJson(idx);
    if(list.length){
      state.indexFromScriptsJson=list.map(o=>({label:o.label||o.value, value: normalizeScriptPath(o.value)}));
      if(scriptSelect){
        scriptSelect.innerHTML=state.indexFromScriptsJson.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
        const found=state.indexFromScriptsJson.find(o=>o.value===jsonSrc || normalizeScriptPath(o.value)===jsonSrc);
        scriptSelect.value = found ? found.value : state.indexFromScriptsJson[0].value;
        jsonSrc = scriptSelect.value; localStorage.setItem(LS.src, jsonSrc);
      }
      if(scriptsNote) scriptsNote.textContent='Quelle: scripts.json';
      updateScriptLabels();
      if(scriptInput && !scriptInput.value) scriptInput.value=jsonSrc;
      return true;
    }else{
      if(scriptsNote) scriptsNote.textContent='scripts.json gefunden, aber leer.';
      if(scriptSelect) scriptSelect.innerHTML=`<option value="${jsonSrc}">${jsonSrc}</option>`;
      updateScriptLabels();
      return false;
    }
  }catch{
    if(scriptsNote) scriptsNote.textContent='Keine scripts.json gefunden – Pfad kann manuell gesetzt werden.';
    if(scriptSelect) scriptSelect.innerHTML=`<option value="${jsonSrc}">${jsonSrc}</option>`;
    updateScriptLabels();
    return false;
  }
}

function updateScriptLabels(){
  if(jsonLabel) jsonLabel.textContent = jsonSrc || '—';
  if(currentScriptLabel) currentScriptLabel.textContent = jsonSrc || '—';
  const target = `./importer.html?src=${encodeURIComponent(jsonSrc || '')}`;
  if(importStudioLinkHome) importStudioLinkHome.href = target;
  if(importStudioLinkSettings) importStudioLinkSettings.href = target;
}

function updateReviewNotes(){
  const issues = state.runtime?.issues || [];
  const pending = ScriptModel.countPendingIssues(issues);
  const total = Array.isArray(issues) ? issues.length : 0;
  const hasReviewData = total > 0;
  const message = !hasReviewData
    ? ''
    : pending > 0
      ? `Dieses Skript hat ${pending} offene Review-Hinweise. Prüfe sie im Import Studio.`
      : `Dieses Skript hat ${total} Review-Einträge und aktuell keine offenen Hinweise.`;
  [reviewNotice, reviewSettingsNote].forEach(node=>{
    if(!node) return;
    node.hidden = !hasReviewData;
    node.textContent = message;
    node.classList.toggle('review-note--ok', hasReviewData && pending === 0);
  });
}

function updateScriptStats(){
  if(!scriptStats) return;
  if(!state.runtime){
    scriptStats.textContent = 'Skript: —';
    return;
  }
  scriptStats.textContent = `Skript: ${state.items.length} Zeilen · ${state.roles.length} Rollen · ${state.acts.length} Akte · ${state.songs.length} Songs`;
}

function applySfxSetting(){
  if(sfxToggle) sfxToggle.checked = !!sfxOn;
}

function applyMotionSetting(){
  document.body.classList.toggle('reduce-motion', !!reduceMotion);
  if(motionToggle) motionToggle.checked = !!reduceMotion;
}

async function applyScriptSelection(src,{markChosen=false}={}){
  if(!src) return false;
  const chosen=normalizeScriptPath(src);
  jsonSrc=chosen; localStorage.setItem(LS.src, chosen);
  if(markChosen) localStorage.setItem(LS.scriptChosen,'1');
  updateScriptLabels();
  if(scriptSelect){
    const found=[...scriptSelect.options].find(o=>normalizeScriptPath(o.value)===chosen);
    if(found) scriptSelect.value=found.value;
  }
  if(scriptInput) scriptInput.value = chosen;
  await loadJSON();
  return true;
}

/* =================== Content JSON laden =================== */
async function loadJSON(){
  jsonSrc = normalizeScriptPath(jsonSrc);
  updateScriptLabels();
  const tryPaths=[jsonSrc,'/'+jsonSrc.replace(/^\//,''),'./'+jsonSrc.replace(/^\//,'')];

  let data;
  try{
    data=await fetchJson(tryPaths);
  }catch(err){
    showError('JSON konnte nicht geladen werden', err.message);
    return;
  }

  const maybeIndex=parseScriptsJson(data);
  if(maybeIndex.length && !looksLikeScriptData(data)){
    jsonSrc=normalizeScriptPath(maybeIndex[0].value);
    localStorage.setItem(LS.src,jsonSrc);
    return loadJSON();
  }

  const runtime = ScriptModel.buildRuntimeModel(data);
  state.canonical = runtime.canonical;
  state.runtime = runtime;
  state.entries = runtime.entries.slice();
  state.items = runtime.learnableEntries.slice();
  state.roles = runtime.roles.map(role=>role.label).filter(Boolean);
  state.acts = runtime.acts.map(act=>({ id:act.id, label:act.label }));
  state.scenes = runtime.scenes.slice();
  state.songs = runtime.songs.slice();

  populateFilters();
  updateScriptStats();
  updateReviewNotes();
}

/* =================== Errorbox =================== */
function showError(title,msg){
  const root=document.querySelector('[data-view].active')||document.body;
  root.querySelectorAll('[data-error]').forEach(n=>n.remove());
  const box=el('div',{class:'card','data-error':'1'},
    el('div',{class:'big'},`❗ ${title}`),
    el('div',{class:'faded'},String(msg||'')),
    el('div',{class:'faded'},`Quelle: ${jsonSrc}`)
  );
  root.appendChild(box);
}

/* =========================
   Navigation & View Switch
   ========================= */

// Aktive View umschalten (robust: active + hidden + inert)
function switchViewImmediate(name){
  document.querySelectorAll('[data-view]').forEach(v=>{
    const on = v.dataset.view === name;
    v.classList.toggle('active', on);
    v.toggleAttribute('hidden', !on);   // wirklich aus Layout
    try { v.inert = !on; } catch {}      // nicht fokussierbar
  });

  // Header-UI aktualisieren (falls vorhanden)
  const hdr = document.getElementById('hdr');
  if (hdr) hdr.classList.toggle('compact', name !== 'home');

  const sub = document.getElementById('subtitle');
  if (sub) sub.textContent = (name === 'home' ? 'made by Jakob with ❤️' : name[0].toUpperCase() + name.slice(1));

  // Body-Flag (z.B. für .home-only CSS)
  document.body.classList.toggle('show-home', name === 'home');

  // Nach oben scrollen
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });

  if(typeof onViewChanged==='function') onViewChanged(name);
}

// Alle Buttons/Links mit data-nav: nur View wechseln (KEIN tone() hier)
document.querySelectorAll('[data-nav]').forEach(b=>{
  b.addEventListener('click', () => {
    const target = b.dataset.nav;
    if (target) switchViewImmediate(target);
  });
});

// Karten auf der Startseite klickbar machen
document.querySelectorAll('.mode-card').forEach(card=>{
  card.addEventListener('click', (e)=>{
    if(e.target.closest('button, [data-nav], [data-goto-learn]')) return;
    // wenn die Karte einen Button mit data-nav / data-goto-learn enthält, den bevorzugen
    const btn = card.querySelector('[data-nav], [data-goto-learn]');
    if (btn) btn.click();
  });
});

// Lernen-Karten setzen Mode vor & wechseln zur Learn-View
document.querySelectorAll('[data-goto-learn]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const mode = el.dataset.mode || 'classic';
    const modeSel = document.getElementById('modeSel');
    if (modeSel) modeSel.value = mode;
    localStorage.setItem(LS.lastMode, mode);
    switchViewImmediate('learn');
    // Hinweis: Render startet erst nach Klick auf "Start" – so gewollt
  });
});

// Brand/Logo oben: zurück zur Startseite
const brand = document.getElementById('brand');
if (brand){
  brand.addEventListener('click', ()=> switchViewImmediate('home'));
  brand.style.cursor = 'pointer';
}


/* =================== Filter & Learn =================== */
function populateFilters(){
  const roleOptions = state.roles.map(role=>({ value:role, label:role }));
  if(roleSel){
    const previous = roleSel.value;
    roleSel.innerHTML = roleOptions.map(role=>`<option value="${role.value}">${role.label}</option>`).join('');
    roleSel.value = roleOptions.some(role=>role.value===previous) ? previous : (roleOptions[0]?.value || '');
  }
  if(viewerRoleSel){
    setSelectOptions(viewerRoleSel, roleOptions, { placeholder:'Keine Hervorhebung', preserveValue: viewerRoleSel.value });
    state.viewerHighlightRole = viewerRoleSel.value || '';
  }
  if(roleSurv){
    const previous = roleSurv.value;
    roleSurv.innerHTML = roleOptions.map(role=>`<option value="${role.value}">${role.label}</option>`).join('');
    roleSurv.value = roleOptions.some(role=>role.value===previous) ? previous : (roleOptions[0]?.value || '');
  }

  const actOptions = state.acts.map(act=>({ value:act.id, label:act.label }));
  setSelectOptions(actSel, actOptions, { preserveValue: actSel?.value || '' });
  setSelectOptions(actSelV, actOptions, { preserveValue: actSelV?.value || '' });
  syncScopedFilters(false);
  syncScopedFilters(true);

  renderViewer();
  markLearnDirty();
}

function markLearnDirty(){
  if(!startLearnBtn) return;
  startLearnBtn.disabled=false;
  startLearnBtn.classList.add('pulse');
}
[actSel,sceneSel,songSel,lyricsOnly,roleSel,modeSel].filter(Boolean).forEach(e=>e.addEventListener('change',()=>{ state.pageIndex=0; markLearnDirty(); }));
if(actSel) actSel.addEventListener('change', ()=>{ syncScopedFilters(false); markLearnDirty(); });
if(sceneSel) sceneSel.addEventListener('change', ()=>{ syncScopedFilters(false); markLearnDirty(); });
if(modeSel){
  const savedMode = localStorage.getItem(LS.lastMode);
  if(savedMode) modeSel.value = savedMode;
  modeSel.addEventListener('change', ()=> localStorage.setItem(LS.lastMode, modeSel.value));
}

function applyFilters(items,{byRole=true,useViewer=false,roleOverride=null}={}){
  const filters = getFilterState(useViewer);
  const role = roleOverride || (byRole ? filters.role : '');
  return ScriptModel.filterLearnableEntries(items, {
    role,
    actId: filters.actId,
    sceneId: filters.sceneId,
    songId: filters.songId,
    lyricsOnly: filters.lyricsOnly,
    normalizeSpeaker: treatSpeaker
  }).filter(line=>{
    if(!byRole) return true;
    const speaker=treatSpeaker(line.speaker);
    return !!speaker && speaker!=='__IGNORE__';
  });
}

function getContextForLine(line,fullSeq,myRoleUC,onlySameSong){
  const role = myRoleUC === 'ALLE' ? 'DIE ANDEREN' : (myRoleUC||'');
  return ScriptModel.getContextForEntry(fullSeq, line.id, {
    role,
    onlySameSong,
    normalizeSpeaker: treatSpeaker
  });
}

/* Cloze Helper: max. 2 Lücken */
function clozeHtmlLimitTwo(text){
  const wordRe=/[A-Za-zÄÖÜäöüß]{3,}/g;
  const matches=[]; let m;
  while((m=wordRe.exec(text))!==null) matches.push({start:m.index,end:m.index+m[0].length});
  if(!matches.length) return escapeHtml(text);
  const picks=matches.sort(()=>Math.random()-.5).slice(0,Math.min(2,matches.length)).sort((a,b)=>a.start-b.start);
  let out='',cursor=0;
  for(const p of picks){
    out+=escapeHtml(text.slice(cursor,p.start));
    out+='<span style="border-bottom:3px dotted var(--green-dark);padding:0 .25rem">&nbsp;&nbsp;&nbsp;</span>';
    cursor=p.end;
  }
  out+=escapeHtml(text.slice(cursor));
  return out;
}

/* Learn Rendering */
function setProg(p){ if(learnProg) learnProg.style.width=p; }
function renderLearn(){ state.lastFiltered=applyFilters(state.items,{byRole:true}); state.pageIndex=0; renderLearnPage(); }

function renderLearnPage(){
  if(!learnRoot) return;
  const mode = modeSel?.value || 'classic';
  const pageSize = (mode==='classic') ? state.pageSizeClassic : state.pageSizeSingle;
  const items = state.lastFiltered, total = items.length;

  if(!items.length){
    learnRoot.innerHTML = '<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    if(pager) pager.hidden = true;
    if(learnCount) learnCount.textContent = `0/${state.items.length}`;
    setProg('0%');
    return;
  }

  const pages = Math.max(1, Math.ceil(total/pageSize));
  state.pageIndex = Math.min(Math.max(0, state.pageIndex), pages-1);
  const slice = items.slice(state.pageIndex*pageSize, state.pageIndex*pageSize+pageSize);

  learnRoot.innerHTML = '';
  const myRoleUC = norm(roleSel?.value||''); 
  const fullSeq   = applyFilters(state.items,{byRole:false}); // gesamte gefilterte Abfolge
  const sameSongSelected = !!(songSel && songSel.value);

  if(mode==='classic'){
    // wir iterieren manuell, um Lyrics-Blocks am Stück zu rendern
    for(let k=0; k<slice.length; k++){
      const line = slice[k];

      if(line.kind==='lyric'){
        // block im aktuellen Slice (zusammenhängende lyrics mit gleichem song)
        let blockStart = k, blockEnd = k;
        while(blockEnd+1<slice.length && ScriptModel.sameLyricBlock(slice[blockEnd+1], line)) blockEnd++;

        const box = el('div',{class:'exchange'});

        // Kontext nur am echten Block-Anfang/Ende der GLOBALEN Sequenz
        const blockInfo = ScriptModel.getLyricBlockContext(fullSeq, line.id);
        const blockEndInfo = ScriptModel.getLyricBlockContext(fullSeq, slice[blockEnd].id);
        const showPrev = blockInfo.startIndex >= 0 && blockInfo.startIndex === blockInfo.index;
        const showNext = blockEndInfo.endIndex >= 0 && blockEndInfo.endIndex === blockEndInfo.index;
        const prev = blockInfo.prev;
        const next = blockEndInfo.next;

        if(showPrev && prev && norm(prev.speaker)!==myRoleUC){
          box.appendChild(el('div',{class:'faded'}, `${prev.speaker}: ${prev.text}`));
        }
        // alle lyrics des Blocks (nur Zeilen, kein Kontext dazwischen)
        for(let t=blockStart; t<=blockEnd; t++){
          const L = slice[t];
          box.appendChild(el('div',{class:'line big'}, `${L.speaker}: ${L.text}`));
        }
        if(showNext && next && norm(next.speaker)!==myRoleUC){
          box.appendChild(el('div',{class:'faded'}, `${next.speaker}: ${next.text}`));
        }

        learnRoot.appendChild(box);
        k = blockEnd; // überspringe bereits gerenderte Block-Zeilen
      } else {
        // normale Zeilen wie bisher
        const box = el('div',{class:'exchange'});
        const {prev,next} = getContextForLine(line, fullSeq, myRoleUC, sameSongSelected);
        if(prev) box.appendChild(el('div',{class:'faded'}, `${prev.speaker}: ${prev.text}`));
        box.appendChild(el('div',{class:'line big'}, `${line.speaker}: ${line.text}`));
        if(next) box.appendChild(el('div',{class:'faded'}, `${next.speaker}: ${next.text}`));
        learnRoot.appendChild(box);
      }
    }
  }
  else if(mode==='flash'){
    const line = slice[0];
    const {prev,next} = getContextForLine(line, fullSeq, myRoleUC, sameSongSelected);
    if(prev) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--top'}, `${prev.speaker}: ${prev.text}`));

    const card = el('div',{class:'fc-card',tabindex:'0','data-sfx':''});
    const title=el('h3',{class:'fc-card__title'}, line.speaker);
    const body =el('p',{class:'fc-card__content'}, '(tippen zum Aufdecken)');
    const arrow=el('div',{class:'fc-card__arrow','aria-hidden':'true'},
      el('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:'0 0 24 24',width:'15',height:'15'},
        el('path',{fill:'#fff',d:'M13.4697 17.9697C13.1768 18.2626 13.1768 18.7374 13.4697 19.0303C13.7626 19.3232 14.2374 19.3232 14.5303 19.0303L20.3232 13.2374C21.0066 12.554 21.0066 11.446 20.3232 10.7626L14.5303 4.96967C14.2374 4.67678 13.7626 4.67678 13.4697 4.96967C13.1768 5.26256 13.1768 5.73744 13.4697 6.03033L18.6893 11.25H4C3.58579 11.25 3.25 11.5858 3.25 12C3.25 12.4142 3.58579 12.75 4 12.75H18.6893L13.4697 17.9697Z'})
      )
    );
    body.dataset.front='(tippen zum Aufdecken)';
    body.dataset.back = `${line.text}`;
    const reveal=()=>{ const isRev=card.classList.toggle('revealed'); body.textContent=isRev?body.dataset.back:body.dataset.front; };
    card.addEventListener('click',reveal);
    card.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); reveal(); }});
    card.append(title,body,arrow);
    learnRoot.appendChild(card);

    if(next) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--bottom'}, `${next.speaker}: ${next.text}`));
  }
  else { // cloze mit Aufdecken – Kontext nur bei globalem Block-Anfang/-Ende
    const line = slice[0];
    const box  = el('div',{class:'exchange'});

    let showPrev=false, showNext=false, prev=null, next=null;
    if(line.kind==='lyric'){
      const info = ScriptModel.getLyricBlockContext(fullSeq, line.id);
      prev = info.prev; next = info.next;
      showPrev = info.startIndex >= 0 && info.startIndex === info.index;
      showNext = info.endIndex >= 0 && info.endIndex === info.index;
    }else{
      const ctx = getContextForLine(line, fullSeq, myRoleUC, sameSongSelected);
      prev = ctx.prev; next = ctx.next;
      showPrev = !!prev; showNext = !!next;
    }

    if(showPrev && prev && norm(prev.speaker)!==myRoleUC){
      box.appendChild(el('div',{class:'faded'}, `${prev.speaker}: ${prev.text}`));
    }

    const content = el('div',{class:'line big'});
    const masked  = clozeHtmlLimitTwo(line.text||''); 
    const full    = escapeHtml(line.text||'');
    let revealed  = false;
    const renderText=()=>{ content.innerHTML = `${line.speaker}: ${revealed?full:masked}`; };
    renderText();
    box.appendChild(content);

    const actions = el('div',{style:'margin-top:.5rem'}, 
      el('button',{class:'btn secondary','data-sfx':''},'Aufdecken'));
    const btn = actions.querySelector('button');
    btn.onclick=()=>{ revealed=!revealed; btn.textContent=revealed?'Verbergen':'Aufdecken'; renderText(); };
    box.appendChild(actions);

    if(showNext && next && norm(next.speaker)!==myRoleUC){
      box.appendChild(el('div',{class:'faded'}, `${next.speaker}: ${next.text}`));
    }
    learnRoot.appendChild(box);
  }

  if(pager){
    pager.hidden = pages<=1;
    pagerInfo.textContent = `Seite ${state.pageIndex+1}/${pages}`;
    prevPage.disabled = state.pageIndex===0; 
    nextPage.disabled = state.pageIndex>=pages-1;
  }
  if(learnCount) learnCount.textContent = `${total}/${state.items.length}`;
  setProg(`${((state.pageIndex+1)/pages)*100}%`);
}
if(prevPage) prevPage.onclick=()=>{state.pageIndex--; renderLearnPage();};
if(nextPage) nextPage.onclick=()=>{state.pageIndex++; renderLearnPage();};
if(startLearnBtn) startLearnBtn.onclick=()=>{ state.inExercise=true; startLearnBtn.classList.remove('pulse'); renderLearn(); };

/* =================== Viewer =================== */
function renderViewer(){
  if(!viewerRoot) return;
  state.viewerLast=applyFilters(state.items,{byRole:false,useViewer:true}); state.viewerIndex=0; renderViewerPage();
}
function renderViewerPage(){
  const items=state.viewerLast, total=items.length;
  if(!items.length){
    viewerRoot.innerHTML='<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    if(viewerPager) viewerPager.hidden=true; if(viewerCount) viewerCount.textContent=`0/${state.items.length}`; if(viewerProg) viewerProg.style.width='0%'; return;
  }
  const pages=Math.max(1,Math.ceil(items.length/state.viewerPageSize));
  state.viewerIndex=Math.min(Math.max(0,state.viewerIndex),pages-1);
  const slice=items.slice(state.viewerIndex*state.viewerPageSize, state.viewerIndex*state.viewerPageSize+state.viewerPageSize);

  viewerRoot.innerHTML='';
  const hl=norm(state.viewerHighlightRole||'');
  slice.forEach(line=>{
    const isMatch = !!hl && norm(line.speaker)===hl;
    const cls = isMatch ? 'line big hl' : 'line big dim';
    viewerRoot.appendChild(el('div',{class:'exchange'}, el('div',{class:cls}, `${line.speaker}: ${line.text}`)));
  });

  if(viewerPager){
    viewerPager.hidden=pages<=1; viewerPagerInfo.textContent=`Seite ${state.viewerIndex+1}/${pages}`;
    viewerPrev.disabled=state.viewerIndex===0; viewerNext.disabled=state.viewerIndex>=pages-1;
  }
  if(viewerCount) viewerCount.textContent=`${total}/${state.items.length}`;
  if(viewerProg) viewerProg.style.width=`${((state.viewerIndex+1)/pages)*100}%`;
}
[actSelV,sceneSelV,songSelV,lyricsOnlyV].filter(Boolean).forEach(e=>e.addEventListener('change',()=>{ state.viewerIndex=0; renderViewer(); }));
if(actSelV) actSelV.addEventListener('change', ()=>{ syncScopedFilters(true); state.viewerIndex=0; renderViewer(); });
if(sceneSelV) sceneSelV.addEventListener('change', ()=>{ syncScopedFilters(true); state.viewerIndex=0; renderViewer(); });
if(viewerRoleSel) viewerRoleSel.addEventListener('change',()=>{ state.viewerHighlightRole=viewerRoleSel.value||''; renderViewerPage(); });
if(viewerPrev) viewerPrev.onclick=()=>{ state.viewerIndex--; renderViewerPage(); };
if(viewerNext) viewerNext.onclick=()=>{ state.viewerIndex++; renderViewerPage(); };

/* =================== Survival (chronologisch + ähnliche Länge) =================== */
const survRoot=document.getElementById('survRoot');
let survLives=3, survScore=0, survPool=[], survIdx=0;

const hearts=()=>{ const pill=document.getElementById('heartPill'); if(pill) pill.textContent='❤️'.repeat(Math.max(0,survLives)); };
const score =()=>{ const pill=document.getElementById('scorePill'); if(pill) pill.textContent=survScore; };

function startSurv(){
  survPool = applyFilters(state.items,{byRole:true, roleOverride: roleSurv?roleSurv.value:''});
  if(!survPool.length){ if(survRoot) survRoot.innerHTML='<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>'; return; }
  survLives=3; survScore=0; survIdx=0; hearts(); score(); state.inExercise=true; nextQ();
}
function pickSimilarLengthWrongs(correctText){
  const targetLen=(correctText||'').length;
  const all = applyFilters(state.items,{byRole:false})
    .map(x=>x.text).filter(t=>t && t!==correctText);
  const wrongs=[...new Set(all)]
    .map(t=>({t, d:Math.abs(t.length-targetLen)}))
    .sort((a,b)=>a.d-b.d).slice(0,12)
    .sort(()=>Math.random()-.5).slice(0,2)
    .map(o=>o.t);
  while(wrongs.length<2 && all.length){
    const extra=all[Math.floor(Math.random()*all.length)];
    if(extra && !wrongs.includes(extra) && extra!==correctText) wrongs.push(extra);
  }
  return wrongs.slice(0,2);
}
function nextQ(){
  if(survLives<=0) return over();
  if(survIdx>=survPool.length) return over();
  if(!survRoot){ survIdx++; return nextQ(); }

  const line=survPool[survIdx], correct=line.text, wrongs=pickSimilarLengthWrongs(correct);
  const opts=[correct,...wrongs].sort(()=>Math.random()-.5);

  survRoot.innerHTML=''; const card=el('div',{class:'card'});
  card.appendChild(el('div',{class:'big'}, `${line.speaker}: …`));
  const list=el('div',{class:'opt-list'});
  opts.forEach(o=>{
    const b=el('button',{class:'opt','data-sfx':''}, o);
    b.onclick=(ev)=>{
      if(o===correct){
        survScore++; score();
        try{ confetti({particleCount:24,spread:60,origin:{x:(ev.clientX||innerWidth/2)/innerWidth,y:(ev.clientY||innerHeight*.6)/innerHeight}});}catch{}
      }else{ survLives--; hearts(); }
      survIdx++; nextQ();
    };
    list.appendChild(b);
  });
  card.appendChild(list);
  survRoot.appendChild(card);
}
function over(){
  if(survRoot){
    survRoot.innerHTML='';
    survRoot.appendChild(el('div',{class:'card big'}, `Game Over! Score: ${survScore}`));
  }
  if(!localStorage.getItem(LS.name)){
    const entered = window.prompt('Dein Name für das Leaderboard:', '');
    if(entered && entered.trim()) localStorage.setItem(LS.name, entered.trim());
  }
  saveScore(survScore);
  state.inExercise=false;
}
const startBtn=document.getElementById('startSurv'); if(startBtn) startBtn.onclick=startSurv;

/* =================== Leaderboard (ohne GUN) =================== */
const SCORES_URL = (IS_PEN ? CDN_BASE : CURRENT_DIR) + 'scores.json';

function getPlayerName(){ return localStorage.getItem(LS.name)||'Anon'; }
function getLocalScores(){ try{ return JSON.parse(localStorage.getItem('hl_local_scores')||'[]'); }catch{ return []; } }
function addLocalScore(entry){
  const list=getLocalScores(); list.push(entry);
  localStorage.setItem('hl_local_scores', JSON.stringify(list).slice(0,100000));
}
async function saveScore(score){
  const entry={ name:getPlayerName(), role:(roleSurv&&roleSurv.value)||'', score:Number(score)||0, ts:new Date().toISOString() };
  addLocalScore(entry);
  if(supa){
    try{
      await supa.from('scores').insert(entry);
    }catch(e){
      console.warn('Supabase-Insert fehlgeschlagen:', e);
    }
  }
}
async function fetchScoresJson(){
  if(supa){
    try{
      const { data, error } = await supa
        .from('scores')
        .select('name,role,score,ts')
        .order('score', { ascending: false })
        .limit(50);
      if(error) throw error;
      return Array.isArray(data) ? data : [];
    }catch(e){
      console.warn('Supabase-Read fehlgeschlagen, fallback zu scores.json:', e);
    }
  }
  try{
    const r=await fetch(SCORES_URL+`?t=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error(r.statusText);
    const j=await r.json();
    return Array.isArray(j.scores)?j.scores:[];
  }catch(e){ console.warn('scores.json konnte nicht geladen werden:', e); return []; }
}
async function renderBoard(){
  const boardDiv=document.getElementById('board');
  const info=document.getElementById('boardInfo');
  if(!boardDiv) return;

  const remote=await fetchScoresJson(); const local=getLocalScores();
  if(info) info.textContent = (remote.length||local.length) ? `Einträge: ${remote.length} (Repo) + ${local.length} (lokal)` : '—';

  const combined=[...remote,...local]
    .filter(s=>typeof s.score==='number' && s.score>=0)
    .sort((a,b)=> b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0,50);

  const rows=combined.map((r,i)=>{
    const rank=i+1, who=r.name||'Anon', role=r.role?` (${r.role})`:'', when=r.ts?new Date(r.ts).toLocaleDateString():'';
    return el('div',{class:'row'},
      el('div',{class:'rank'}, `#${rank}`),
      el('div',{class:'who'}, `${who}${role}`),
      el('strong',{}, r.score),
      el('div',{class:'when'}, when)
    );
  });

  boardDiv.innerHTML='';
  boardDiv.appendChild(
    el('div',{class:'card'},
      el('div',{class:'big'}, 'Leaderboard'),
      el('div',{class:'board-list'}, rows.length?rows:el('div',{class:'faded'},'Noch keine Einträge'))
    )
  );
}
/* Achtung: deine View heißt "scores" → hier rendern */
function onViewChanged(name){ if(name==='scores') renderBoard(); }

/* =================== Settings =================== */
if(playerNameInput){
  playerNameInput.value = localStorage.getItem(LS.name)||'';
}
if(saveSettingsBtn){
  saveSettingsBtn.addEventListener('click', ()=>{
    const name=(playerNameInput && playerNameInput.value.trim())||'Anon';
    localStorage.setItem(LS.name, name);
    const old=saveSettingsBtn.textContent;
    saveSettingsBtn.textContent='Gespeichert';
    setTimeout(()=>{ saveSettingsBtn.textContent=old; }, 1200);
  });
}
if(sfxToggle){
  applySfxSetting();
  sfxToggle.addEventListener('change', ()=>{
    sfxOn = !!sfxToggle.checked;
    localStorage.setItem(LS.sfx, sfxOn?'1':'0');
  });
}
if(motionToggle){
  applyMotionSetting();
  motionToggle.addEventListener('change', ()=>{
    reduceMotion = !!motionToggle.checked;
    localStorage.setItem(LS.motion, reduceMotion?'1':'0');
    applyMotionSetting();
  });
}

/* =================== Scripts-Auswahl Events =================== */
const getScriptFromUI=()=>{
  const manualOn=!!(manualToggle && manualToggle.checked);
  const manualVal=scriptInput && scriptInput.value.trim();
  if(manualOn && manualVal) return manualVal;
  if(scriptSelect) return scriptSelect.value;
  return '';
};

if(manualToggle && scriptInput){
  const sync=()=>{ scriptInput.style.display = manualToggle.checked ? 'block' : 'none'; };
  sync();
  manualToggle.addEventListener('change', sync);
}

if(scriptSelect){
  scriptSelect.addEventListener('change', async e=>{
    await applyScriptSelection(e.target.value,{markChosen:true});
  });
}

if(loadScriptBtn){
  loadScriptBtn.addEventListener('click', async ()=>{
    const src=getScriptFromUI();
    if(!src){ showError('Keine Quelle', 'Bitte eine JSON-Datei wählen oder manuell eingeben.'); return; }
    await applyScriptSelection(src,{markChosen:true});
  });
}

if(scriptContinue){
  scriptContinue.addEventListener('click', async ()=>{
    const src=getScriptFromUI();
    if(!src){ showError('Keine Quelle', 'Bitte eine JSON-Datei wählen oder manuell eingeben.'); return; }
    await applyScriptSelection(src,{markChosen:true});
    switchViewImmediate('home');
  });
}

/* =================== Mobile: Pinch-Zoom killen =================== */
(function(){ ['gesturestart','gesturechange','gestureend'].forEach(evt=>document.addEventListener(evt,e=>e.preventDefault(),{passive:false})); })();

/* =================== Boot =================== */
async function boot(){
  if(!ScriptModel){
    showError('Script-Modul fehlt', 'script-model.js konnte nicht geladen werden.');
    return;
  }
  applySfxSetting();
  applyMotionSetting();
  await loadScriptsIndex();
  updateScriptLabels();
  const chosenFlag = localStorage.getItem(LS.scriptChosen)==='1';
  const shouldPrompt = !chosenFlag && (state.indexFromScriptsJson.length>1 || !state.indexFromScriptsJson.length);
  const startView = shouldPrompt ? 'script' : 'home';
  switchViewImmediate(startView);
  await loadJSON();
  renderViewer(); // Learn erst nach Klick auf „Start“
}
document.readyState==='loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
