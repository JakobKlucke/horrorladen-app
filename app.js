/* ---------------- Utilitys ---------------- */
// Cloze Helper: max. 2 Wörter werden ersetzt
function clozeHtmlLimitTwo(text){
  const wordRe = /[A-Za-zÄÖÜäöüß]{3,}/g;
  const matches = [];
  let m;
  while ((m = wordRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  if (!matches.length) return escapeHtml(text);

  const picks = matches
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(2, matches.length))
    .sort((a,b)=>a.start-b.start);

  let out = '', cursor = 0;
  for (const p of picks) {
    out += escapeHtml(text.slice(cursor, p.start));
    out += '<span style="border-bottom:3px dotted var(--green-dark);padding:0 .25rem">&nbsp;&nbsp;&nbsp;</span>';
    cursor = p.end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}




/* ---------------- BaseDir & Path Normalisierung ---------------- */
const CURRENT_DIR = (() => {
  const p = location.pathname;
  return p.endsWith('/') ? p : p.replace(/[^/]+$/, '/');
})();

function normalizeScriptPath(p){
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;                         // externe URL
  if (p.startsWith(CURRENT_DIR)) return p;                        // bereits projekt-abs.
  if (p.startsWith('./')) p = p.slice(2);                         // "./" entfernen
  if (p.startsWith('/')) return p;                                // Root-pfad (lassen)
  return CURRENT_DIR + p;                                         // relativer Name -> ergänzen
}

async function fetchJson(paths){
  for (const raw of paths){
    const url = normalizeScriptPath(raw);
    try{
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return await r.json();
    }catch(e){ /* ignore & try next */ }
  }
  throw new Error('Konnte keine Datei laden aus: ' + paths.join(', '));
}

/* ---------------- Prefs/State ---------------- */
const LS = { name:'hl_player_name', src:'hl_json_src', sfx:'hl_sfx_on', motion:'hl_reduce_motion' };

// LS-Bereinigung einmalig
let jsonSrcRaw = localStorage.getItem(LS.src) || 'horrorladen_final_with_acts.json';
let jsonSrc     = normalizeScriptPath(jsonSrcRaw);
localStorage.setItem(LS.src, jsonSrc);

let sfxOn = true;

const state = {
  items: [], roles: [],
  actsList: [], scenesByAct: {},
  songsSet: new Set(),
  pageIndex: 0, pageSizeClassic: 8, pageSizeSingle: 1, lastFiltered: [],
  viewerIndex: 0, viewerPageSize: 20, viewerLast: [], viewerHighlightRole: '',
  indexFromScriptsJson: []
};

const norm = s => (s||'').trim().toUpperCase();
const treatSpeaker = sp => { const s = norm(sp); if (s==='DIE ANDEREN') return 'ALLE'; if (s==='BARAPAPAPA'||s==='BARAPAPAPABA') return '__IGNORE__'; return s; };
const el = (t,a={},...c)=>{ const n=document.createElement(t); for (const[k,v] of Object.entries(a)){ if(k==='class') n.className=v; else if(k==='html') n.innerHTML=v; else n.setAttribute(k,v); } c.forEach(x=>{ if(x!=null) n.appendChild(typeof x==='string'?document.createTextNode(x):x); }); return n; };
const escapeHtml=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------------- Sounds ---------------- */
const AudioC = window.AudioContext || window.webkitAudioContext; let ac;
function tone(seq=[0],dur=.12,type='triangle',base=640){
  if(!sfxOn || !AudioC) return; ac = ac || new AudioC();
  const o=ac.createOscillator(), g=ac.createGain(); o.type=type; o.connect(g).connect(ac.destination);
  const now=ac.currentTime; let t=now; g.gain.setValueAtTime(.0001,now); g.gain.linearRampToValueAtTime(.22,now+.01);
  seq.forEach(semi=>{ o.frequency.setValueAtTime(base*Math.pow(2,semi/12),t); t+=dur; });
  g.gain.exponentialRampToValueAtTime(.0001,t+.04); o.start(now); o.stop(t+.05);
}
document.addEventListener('click',e=>{ if(e.target.closest('[data-sfx]')) tone([0],.07); },{capture:true});

/* ---------------- Parser & Flatten ---------------- */
const scanTitleLike = o => { if(!o || typeof o!=='object') return null; for(const k of ['title','name','label','id']) if(typeof o[k]==='string' && o[k].trim()) return o[k].trim(); return null; }
const normalizeTitle = v => typeof v==='string'?v:(typeof v==='number'?String(v):(v&&typeof v==='object'?(scanTitleLike(v)||''):'' ));

function isFullScript(data){
  if(!data) return false;
  if(Array.isArray(data)) return data.some(n=>typeof n==='object' && (n.type||'')==='speaker_block') || data.some(n=>n&&n.acts) || data.some(n=>n.children||n.segments||n.items);
  if(typeof data==='object') return !!(data.acts || data.segments || data.children || data.items);
  return false;
}

function parseScriptsJson(data){
  const out=[]; const push=(label,value)=>{ if(value) out.push({label:label||value, value}); };
  const each=(it,i)=>{
    if(typeof it==='string'){ push(it,it); }
    else if(it && typeof it==='object'){
      const value = it.src || it.file || it.path || it.url || '';
      const label = it.title || it.name || it.label || value || `Skript ${i+1}`;
      push(label,value);
    }
  };
  if(Array.isArray(data)) data.forEach(each);
  else if(data && typeof data==='object'){
    if(Array.isArray(data.scripts)) data.scripts.forEach(each);
    else if(typeof data.scripts==='object') Object.entries(data.scripts).forEach(([k,v])=>{
      if(typeof v==='string') push(k||v,v);
      else if(v && typeof v==='object') push(v.title||v.name||k||v.src||v.path||'', v.src||v.file||v.path||'');
    });
    else if(Array.isArray(data.sources)) data.sources.forEach(each);
  }
  return out;
}

function flattenAny(node,ctx={act:null,scene:null,song:null},out=[],meta){
  if(!node || typeof node!=='object') return;
  const t=(node.type||'').toLowerCase();
  if(t==='act' || 'act' in node){ const a=normalizeTitle('act' in node?node.act:node); if(a) ctx={...ctx,act:a}; }
  if(t==='scene' || 'scene' in node){ const s=normalizeTitle('scene' in node?node.scene:node); if(s) ctx={...ctx,scene:s}; }
  if(t==='song' || 'song' in node){ const sg=normalizeTitle('song' in node?node.song:node); if(sg) ctx={...ctx,song:sg}; }
  if(t==='speaker_block' && node.speaker){
    const content=Array.isArray(node.content)?node.content:[];
    content.forEach(c=>{
      if(!c||!c.type) return; const ty=String(c.type).toLowerCase();
      if(ty==='line' || ty==='lyric'){
        const text=(c.text||'').trim(); if(!text) return;
        out.push({type:'dialogue', speaker:node.speaker, text, kind:ty, meta:{...ctx}});
        meta.roles.add(norm(node.speaker)); if(ctx.song) meta.songs.add(ctx.song);
      }
    });
  }
  const kids=[].concat(node.segments||[], node.children||[], node.parts||[], node.items||[], Array.isArray(node)?node:[]);
  kids.forEach(ch=>flattenAny(ch,ctx,out,meta));
}

/* ---------------- scripts.json -> Dropdown ---------------- */
const scriptSelect = document.getElementById('scriptSelect');
const scriptsNote  = document.getElementById('scriptsNote');

async function loadScriptsIndex(){
  try{
    const idx  = await fetchJson([ CURRENT_DIR + 'scripts.json', 'scripts.json', './scripts.json' ]);
    const list = parseScriptsJson(idx);
    if(list.length){
      state.indexFromScriptsJson = list.map(o=>({ label:o.label||o.value, value: normalizeScriptPath(o.value) }));
      scriptSelect.innerHTML = state.indexFromScriptsJson.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
      scriptsNote.textContent = 'Quelle: scripts.json im aktuellen Ordner';

      const found = state.indexFromScriptsJson.find(o => o.value===jsonSrc || normalizeScriptPath(o.value)===jsonSrc);
      if(found){ scriptSelect.value = found.value; }
      else { scriptSelect.value = state.indexFromScriptsJson[0].value; jsonSrc = scriptSelect.value; localStorage.setItem(LS.src,jsonSrc); }
      return true;
    } else {
      scriptsNote.textContent = 'scripts.json gefunden, aber leer.';
      scriptSelect.innerHTML = `<option value="${jsonSrc}">${jsonSrc}</option>`;
      return false;
    }
  }catch{
    scriptsNote.textContent = 'Keine scripts.json gefunden – Pfad kann manuell gesetzt werden.';
    scriptSelect.innerHTML = `<option value="${jsonSrc}">${jsonSrc}</option>`;
    return false;
  }
}

/* ---------------- Content JSON laden ---------------- */
const jsonLabel = document.getElementById('jsonSrcLabel');
async function loadJSON(){
  jsonSrc = normalizeScriptPath(jsonSrc);
  if (jsonLabel) jsonLabel.textContent = jsonSrc;

  const tryPaths = [ jsonSrc, '/'+jsonSrc.replace(/^\//,''), './'+jsonSrc.replace(/^\//,'') ];

  let data;
  try {
    data = await fetchJson(tryPaths);
  } catch (err) {
    showError('JSON konnte nicht geladen werden', err.message);
    return;
  }

  // erlaubt: scripts.json als Index
  const maybeIndex = parseScriptsJson(data);
  if (maybeIndex.length && !isFullScript(data)){
    jsonSrc = normalizeScriptPath(maybeIndex[0].value);
    localStorage.setItem(LS.src, jsonSrc);
    return loadJSON();
  }

  const out = [];
  const meta = { roles: new Set(), songs: new Set() };
  Array.isArray(data) ? flattenAny({segments:data}, {}, out, meta)
                      : flattenAny(data, {}, out, meta);

  state.items = out;
  state.roles = [...meta.roles];

  state.songsSet = new Set(
    [...meta.songs].map(normalizeTitle).filter(Boolean).sort((a,b)=>a.localeCompare(b))
  );

  state.actsList = [];
  state.scenesByAct = {};
  if (data && Array.isArray(data.acts)){
    data.acts.forEach(act=>{
      const a = normalizeTitle(act);
      if (!a) return;
      state.actsList.push(a);
      state.scenesByAct[a] = (Array.isArray(act.scenes)?act.scenes:[])
        .map(s=>normalizeTitle(s)).filter(Boolean);
    });
  }

  populateFilters();
}

/* ---------------- Errorbox ---------------- */
function showError(title,msg){
  const root=document.querySelector('[data-view].active')||document.body;
  const box=el('div',{class:'card'},
    el('div',{class:'big'},`❗ ${title}`),
    el('div',{class:'faded'},String(msg||'')),
    el('div',{class:'faded'},`Quelle: ${jsonSrc}`)
  );
  root.appendChild(box);
}

/* ---------------- Navigation ---------------- */
let currentView = 'home';
state.inExercise = false; // Trackt ob eine Übung läuft

function switchViewImmediate(name){
  document.querySelectorAll('[data-view]')
    .forEach(v => v.classList.toggle('active', v.dataset.view === name));
  document.getElementById('hdr').classList.toggle('compact', name !== 'home');
  document.getElementById('subtitle').textContent =
    name === 'home' ? 'Willkommen' : name[0].toUpperCase() + name.slice(1);
  currentView = name;
}

// Sanfter Wrapper mit Abfrage
function switchView(name){
  if(state.inExercise && name === 'home'){
    const ok = confirm('Willst du die aktuelle Übung wirklich beenden und ins Hauptmenü zurückkehren?');
    if(!ok) return;
    state.inExercise = false;
  }
  switchViewImmediate(name);
}

// Normale Navigations-Buttons
document.querySelectorAll('[data-nav]').forEach(b => {
  b.onclick = () => {
    switchView(b.dataset.nav);
    tone([0,4], .05);
  };
});

// Logo/Brand oben links klickbar machen → Home
const brand = document.getElementById('brand');
if(brand){
  brand.style.cursor = 'pointer';
  brand.onclick = () => switchView('home');
}

// Direkt-Buttons im Home für Lernmodi
document.querySelectorAll('[data-goto-learn]').forEach(btn => {
  btn.onclick = () => {
    const m = btn.dataset.mode || 'classic';
    modeSel.value = m;
    switchView('learn');
    state.inExercise = true;   // wir starten eine Lernsession
    renderLearn();             // sofort laden
  };
});

// Settings-Button
document.getElementById('goSettings').onclick = () => {
  switchView('settings');
  tone([0,4], .05);
};

/* ---------------- Controls & Filter ---------------- */
const actSel=document.getElementById('actFilter'), sceneSel=document.getElementById('sceneFilter'), songSel=document.getElementById('songFilter'), lyricsOnly=document.getElementById('lyricsOnly'), roleSel=document.getElementById('roleSel');
const actSelV=document.getElementById('actFilterV'), sceneSelV=document.getElementById('sceneFilterV'), songSelV=document.getElementById('songFilterV'), lyricsOnlyV=document.getElementById('lyricsOnlyV'), viewerRoleSel=document.getElementById('viewerRoleSel');
const roleSurv=document.getElementById('roleSurv');

function fillSongs(sel){ sel.innerHTML='<option value="">Alle</option>'+[...state.songsSet].map(s=>`<option>${s}</option>`).join(''); }

function populateFilters(){
  const roleOpts = state.roles.map(r=>`<option>${r}</option>`).join('');
  roleSel.innerHTML = roleOpts; if(roleSurv) roleSurv.innerHTML = roleOpts; viewerRoleSel.innerHTML = roleOpts; state.viewerHighlightRole = viewerRoleSel.value||'';

  const fillActs = sel => sel.innerHTML='<option value="">Alle</option>'+state.actsList.map(a=>`<option>${a}</option>`).join('');
  fillActs(actSel); fillActs(actSelV);

  const refreshScenes=(act,sel)=>{ const list=act?(state.scenesByAct[act]||[]):Object.values(state.scenesByAct).flat(); sel.innerHTML='<option value="">Alle</option>'+list.map(s=>`<option>${s}</option>`).join(''); };
  refreshScenes('',sceneSel); refreshScenes('',sceneSelV);

  fillSongs(songSel); fillSongs(songSelV);

  renderLearn(); renderViewer();
}

actSel.addEventListener('change',()=>{ const a=actSel.value; const l=a?(state.scenesByAct[a]||[]):Object.values(state.scenesByAct).flat(); sceneSel.innerHTML='<option value="">Alle</option>'+l.map(s=>`<option>${s}</option>`).join(''); renderLearn(); });
actSelV.addEventListener('change',()=>{ const a=actSelV.value; const l=a?(state.scenesByAct[a]||[]):Object.values(state.scenesByAct).flat(); sceneSelV.innerHTML='<option value="">Alle</option>'+l.map(s=>`<option>${s}</option>`).join(''); renderViewer(); });

function applyFilters(items,{byRole=true,useViewer=false,roleOverride=null}={}){
  const role = roleOverride || roleSel.value;
  const act  = useViewer?actSelV.value:actSel.value;
  const scene= useViewer?sceneSelV.value:sceneSel.value;
  const song = useViewer?songSelV.value:songSel.value;
  const lyr  = useViewer?!!lyricsOnlyV.checked:!!lyricsOnly.checked;

  return items.filter(it=>{
    if(byRole){
      const sp = treatSpeaker(it.speaker);
      if(!sp || sp==='__IGNORE__') return false;
      if(sp!=='ALLE' && sp!==norm(role)) return false;
    }
    if(act  && (it.meta?.act||'')   !== act)   return false;
    if(scene&& (it.meta?.scene||'') !== scene) return false;
    if(song && (it.meta?.song||'')  !== song)  return false;
    if(lyr  && it.kind!=='lyric')            return false;
    return true;
  });
}

function getContextForLine(line,fullSeq,myRoleUC,onlySameSong){
  const idx=fullSeq.findIndex(x=>norm(x.speaker)===norm(line.speaker)&&x.text===line.text&&(x.meta?.act||'')===(line.meta?.act||'')&&(x.meta?.scene||'')===(line.meta?.scene||'')&&(x.meta?.song||'')===(line.meta?.song||'')); 
  if(idx<0) return {prev:null,next:null};
  let prev=null; for(let i=idx-1;i>=0;i--){ const okRole=norm(fullSeq[i].speaker)!==myRoleUC; const okSong=!onlySameSong||(fullSeq[i].meta?.song||'')===(line.meta?.song||''); if(okRole&&okSong){ prev=fullSeq[i]; break; } }
  let next=null; for(let i=idx+1;i<fullSeq.length;i++){ const okRole=norm(fullSeq[i].speaker)!==myRoleUC; const okSong=!onlySameSong||(fullSeq[i].meta?.song||'')===(line.meta?.song||''); if(okRole&&okSong){ next=fullSeq[i]; break; } }
  return {prev,next};
}

/* ---------------- Learn ---------------- */
const learnRoot=document.getElementById('learnRoot'); const modeSel=document.getElementById('modeSel'); const startLearnBtn=document.getElementById('startLearn');
const pager=document.getElementById('learnPager'); const pagerInfo=document.getElementById('pagerInfo'); const prevPage=document.getElementById('prevPage'); const nextPage=document.getElementById('nextPage'); const learnProg=document.getElementById('learnProg'); const learnCount=document.getElementById('learnCount');

function setProg(p){ learnProg.style.width=p; }
function renderLearn(){ state.lastFiltered=applyFilters(state.items,{byRole:true}); state.pageIndex=0; renderLearnPage(true); }

function renderLearnPage(){
  const mode=modeSel.value;
  const pageSize=(mode==='classic')?state.pageSizeClassic:state.pageSizeSingle;
  const items=state.lastFiltered;
  const total=items.length;

  if(!items.length){
    learnRoot.innerHTML='<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    pager.hidden=true; learnCount.textContent=`0/${state.items.length}`; setProg('0%'); return;
  }

  const pages=Math.max(1,Math.ceil(total/pageSize));
  state.pageIndex=Math.min(Math.max(0,state.pageIndex),pages-1);
  const slice=items.slice(state.pageIndex*pageSize, state.pageIndex*pageSize+pageSize);

  learnRoot.innerHTML='';
  const myRoleUC=norm(roleSel.value||'');
  const fullSeq=applyFilters(state.items,{byRole:false});
  const sameSong=!!songSel.value;

  if(mode==='classic'){
    slice.forEach(line=>{
      const box=el('div',{class:'exchange'});
      const {prev,next}=getContextForLine(line,fullSeq,myRoleUC,sameSong);
      if(prev) box.appendChild(el('div',{class:'faded'},`${prev.speaker}: ${prev.text}`));
      box.appendChild(el('div',{class:'line big'},`${line.speaker}: ${line.text}`));
      if(next) box.appendChild(el('div',{class:'faded'},`${next.speaker}: ${next.text}`));
      learnRoot.appendChild(box);
    });
  }
  else if(mode==='flash'){
    const line=slice[0];
    const {prev,next}=getContextForLine(line,fullSeq,myRoleUC,sameSong);

    if(prev) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--top'},`${prev.speaker}: ${prev.text}`));

    const card = el('div',{class:'fc-card',tabindex:'0','data-sfx':''});
    const title= el('h3',{class:'fc-card__title'}, line.speaker);
    const body = el('p',{class:'fc-card__content'}, '(tippen zum Aufdecken)');
    const arrow= el('div',{class:'fc-card__arrow','aria-hidden':'true'},
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

    if(next) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--bottom'},`${next.speaker}: ${next.text}`));
  }
  else { // cloze
  const line = slice[0];
  const { prev, next } = getContextForLine(line, fullSeq, myRoleUC, sameSong);

  const card = el('div', { class: 'card' });

  if (prev) card.appendChild(el('div', { class: 'ctx ctx-top' }, `${prev.speaker}: ${prev.text}`));

  const html = clozeHtmlLimitTwo(line.text || '');
  card.appendChild(el('div', { class: 'big', html: `${line.speaker}: ${html}` }));

  if (next) card.appendChild(el('div', { class: 'ctx ctx-bottom' }, `${next.speaker}: ${next.text}`));

  learnRoot.appendChild(card);
}

  pager.hidden=pages<=1;
  pagerInfo.textContent=`Seite ${state.pageIndex+1}/${pages}`;
  prevPage.disabled=state.pageIndex===0;
  nextPage.disabled=state.pageIndex>=pages-1;
  learnCount.textContent=`${total}/${state.items.length}`;
  setProg(`${((state.pageIndex+1)/pages)*100}%`);
}

startLearnBtn.onclick = renderLearn;
[sceneSel,songSel,lyricsOnly,roleSel,modeSel].forEach(e=>e.addEventListener('change',()=>{state.pageIndex=0; renderLearn();}));
prevPage.onclick=()=>{ state.pageIndex--; renderLearnPage(); };
nextPage.onclick=()=>{ state.pageIndex++; renderLearnPage(); };

/* ---------------- Viewer ---------------- */
const viewerRoot=document.getElementById('viewerRoot'); const viewerPager=document.getElementById('viewerPager'); const viewerPagerInfo=document.getElementById('viewerPagerInfo'); const viewerPrev=document.getElementById('viewerPrev'); const viewerNext=document.getElementById('viewerNext'); const viewerProg=document.getElementById('viewerProg'); const viewerCount=document.getElementById('viewerCount');

function renderViewer(){ state.viewerLast=applyFilters(state.items,{byRole:false,useViewer:true}); state.viewerIndex=0; renderViewerPage(); }

function renderViewerPage(){
  const items=state.viewerLast, total=items.length;
  if(!items.length){
    viewerRoot.innerHTML='<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    viewerPager.hidden=true; viewerCount.textContent=`0/${state.items.length}`; viewerProg.style.width='0%'; return;
  }

  const pages=Math.max(1,Math.ceil(items.length/state.viewerPageSize));
  state.viewerIndex=Math.min(Math.max(0,state.viewerIndex),pages-1);
  const slice=items.slice(state.viewerIndex*state.viewerPageSize, state.viewerIndex*state.viewerPageSize+state.viewerPageSize);

  viewerRoot.innerHTML='';
  const hl=norm(state.viewerHighlightRole||'');
  slice.forEach(line=>{
    const isMatch = !!hl && norm(line.speaker) === hl;
    const cls = isMatch ? 'line big hl' : 'line big dim';
    viewerRoot.appendChild(el('div',{class:'exchange'}, el('div',{class:cls}, `${line.speaker}: ${line.text}`)));
  });

  viewerPager.hidden = pages<=1;
  viewerPagerInfo.textContent=`Seite ${state.viewerIndex+1}/${pages}`;
  viewerPrev.disabled = state.viewerIndex===0;
  viewerNext.disabled = state.viewerIndex>=pages-1;
  viewerCount.textContent=`${total}/${state.items.length}`;
  viewerProg.style.width = `${((state.viewerIndex+1)/pages)*100}%`;
}

[actSelV, sceneSelV, songSelV, lyricsOnlyV].forEach(e =>
  e.addEventListener('change', () => { state.viewerIndex = 0; renderViewer(); })
);
viewerRoleSel.addEventListener('change',()=>{ state.viewerHighlightRole = viewerRoleSel.value||''; renderViewerPage(); });

/* ---------------- Survival (chronologisch + ähnliche Länge) ---------------- */
const survRoot = document.getElementById('survRoot');
const roleSurv = document.getElementById('roleSurv');
let survLives = 3, survScore = 0;
let survPool = [];   // chronologische Liste der Zeilen für die gewählte Rolle
let survIdx  = 0;    // aktueller Index in survPool

const hearts = () => {
  const pill = document.getElementById('heartPill');
  if (pill) pill.textContent = '❤️'.repeat(Math.max(0, survLives));
};
const score  = () => {
  const pill = document.getElementById('scorePill');
  if (pill) pill.textContent = survScore;
};

function startSurv(){
  // 1) chronologischer Pool: gefiltert nach Rolle, Reihenfolge = wie im Skript
  survPool = applyFilters(state.items, { byRole:true, roleOverride: roleSurv.value });
  if (!survPool.length) {
    survRoot.innerHTML = '<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    return;
  }
  survLives = 3; survScore = 0; survIdx = 0; hearts(); score();
  state.inExercise = true;
  nextQ();
}

// Hilfsfunktion: wählt 2 Texte ähnlicher Länge zur "correct" Line
function pickSimilarLengthWrongs(correctText){
  const targetLen = (correctText||'').length;
  // Alle Items (ohne Rollenfilter), nur Texte
  const all = applyFilters(state.items, { byRole:false })
    .map(x => x.text)
    .filter(t => t && t !== correctText);

  // nach absoluten Längendifferenzen sortieren, dann die nächsten 2
  const wrongs = [...new Set(all)] // uniq
    .map(t => ({ t, d: Math.abs(t.length - targetLen) }))
    .sort((a,b) => a.d - b.d)
    .slice(0, 12)                // kleine Vorauswahl
    .sort(() => Math.random() - .5)
    .slice(0, 2)
    .map(o => o.t);

  // Fallback: falls zu wenig gefunden, irgendeinen auffüllen
  while (wrongs.length < 2) {
    const extra = all[Math.floor(Math.random()*all.length)];
    if (extra && !wrongs.includes(extra) && extra !== correctText) wrongs.push(extra);
  }
  return wrongs.slice(0,2);
}

function nextQ(){
  if (survLives <= 0) { over(); return; }
  if (survIdx >= survPool.length) { over(); return; }

  const line    = survPool[survIdx];
  const correct = line.text;
  const wrongs  = pickSimilarLengthWrongs(correct);
  const opts    = [correct, ...wrongs].sort(() => Math.random() - .5);

  survRoot.innerHTML = '';
  const card = el('div', { class: 'card' });

  // Frage (nur Sprecher, Inhalt wird geraten)
  card.appendChild(el('div', { class: 'big' }, `${line.speaker}: …`));

  // Antworten untereinander
  const list = el('div', { class: 'opt-list' });
  opts.forEach(o => {
    const b = el('button', { class: 'opt', 'data-sfx': '' }, o);
    b.onclick = (ev) => {
      if (o === correct) {
        survScore++; score();
        try { confetti({ particleCount: 24, spread: 60, origin: { x:(ev.clientX||innerWidth/2)/innerWidth, y:(ev.clientY||innerHeight*.6)/innerHeight } }); } catch {}
      } else {
        survLives--; hearts();
      }
      // Immer zur nächsten Zeile -> chronologisch vorwärts
      survIdx++;
      nextQ();
    };
    list.appendChild(b);
  });

  card.appendChild(list);
  survRoot.appendChild(card);
}

const over = () => {
  survRoot.innerHTML = '';
  survRoot.appendChild(el('div', { class: 'card big' }, `Game Over! Score: ${survScore}`));
  saveScore(survScore);     // noop, wenn GUN nicht verfügbar
  state.inExercise = false;
};

const startBtn = document.getElementById('startSurv');
if (startBtn) startBtn.onclick = startSurv;


/* ---------------- Leaderboard (robust init) ---------------- */
const boardDiv  = document.getElementById('board');
const boardInfo = document.getElementById('boardInfo');
let gun = null, board = null, gunReady = false;

function enableBoardUI(){ if(!gunReady && boardInfo) boardInfo.textContent='Leaderboard deaktiviert'; }

function initGunIfAvailable(){
  try{
    if (window.Gun && !gunReady){
      gun   = Gun(['https://relay.peer.ooo/gun','https://gun-manhattan.herokuapp.com/gun']); // mehrere Relays
      board = gun.get('horrorladen-scores');
      gunReady = true;
      renderBoardAuto();
    }
  }catch(e){ console.warn('Gun init failed:', e); }
  finally{ enableBoardUI(); }
}

let gunRetryTimer=null;
function startGunRetry(){
  let retries=10;
  gunRetryTimer=setInterval(()=>{
    if(gunReady){ clearInterval(gunRetryTimer); return; }
    initGunIfAvailable();
    if(--retries<=0) clearInterval(gunRetryTimer);
  },300);
}
window.addEventListener('load', ()=>{ initGunIfAvailable(); startGunRetry(); });

function saveScore(score){
  if(!gunReady || !board) return;
  const name = (localStorage.getItem(LS.name) || 'Anon');
  const role = roleSurv ? roleSurv.value : '';
  board.set({ name, role, score, time: Date.now() });
  renderBoardAuto();
}
function renderBoardAuto(){
  if(!gunReady || !board){
    enableBoardUI();
    if(boardDiv) boardDiv.innerHTML='';
    return;
  }
  const list=[]; board.map().once(d=>{ if(d) list.push(d); renderBoard(list); });
}
function renderBoard(list){
  if(!boardDiv || !boardInfo) return;
  list.sort((a,b)=> (b?.score||0) - (a?.score||0));
  boardDiv.innerHTML='';
  boardInfo.textContent = `${list.length} Einträge, zuletzt: ${new Date().toLocaleTimeString()}`;
  list.forEach((r,i)=>boardDiv.appendChild(
    el('div',{class:'exchange',style:'display:flex;justify-content:space-between;align-items:center'},
      `${i+1}. ${r?.name||'Anon'} ${r?.role?`(${r.role})`:''}`,
      el('strong',{}, r?.score ?? 0)
    )
  ));
}

/* ---------------- Settings ---------------- */
const playerName   = document.getElementById('playerName');
const saveSettings = document.getElementById('saveSettings');
const manualToggle = document.getElementById('manualToggle');
const scriptInput  = document.getElementById('scriptInput');
const loadScriptBtn= document.getElementById('loadScriptBtn');

if(playerName) playerName.value = localStorage.getItem(LS.name)||'';
if(saveSettings) saveSettings.onclick = ()=>{ localStorage.setItem(LS.name,(playerName.value||'').trim()||'Anon'); tone([0,7],.06); };
if(manualToggle && scriptInput) manualToggle.onchange = ()=>{ scriptInput.style.display = manualToggle.checked ? '' : 'none'; };

if(document.getElementById('jsonSrcLabel')) document.getElementById('jsonSrcLabel').textContent = jsonSrc;

if(loadScriptBtn) loadScriptBtn.onclick = ()=>{
  const raw = manualToggle?.checked ? (scriptInput.value||'').trim() : scriptSelect.value;
  if(!raw) return;
  const chosen = normalizeScriptPath(raw);
  localStorage.setItem(LS.src, chosen);
  jsonSrc = chosen;
  if(document.getElementById('jsonSrcLabel')) document.getElementById('jsonSrcLabel').textContent = jsonSrc;
  loadJSON();
};

if (scriptSelect) {
  scriptSelect.addEventListener('change', async (e) => {
    const chosen = normalizeScriptPath(e.target.value);
    jsonSrc = chosen;
    localStorage.setItem(LS.src, chosen);
    if(document.getElementById('jsonSrcLabel')) document.getElementById('jsonSrcLabel').textContent = chosen;
    await loadJSON();
  });
}

/* ---------------- Mobile: Zoom strikt verbieten ---------------- */
(function(){
  ['gesturestart','gesturechange','gestureend'].forEach(evt=>document.addEventListener(evt,e=>e.preventDefault(),{passive:false}));
  let lt=0; document.addEventListener('touchend',e=>{const n=Date.now(); if(n-lt<=300) e.preventDefault(); lt=n;},{passive:false});
})();

/* ---------------- Boot ---------------- */
function switchHome(){ switchViewImmediate('home'); }
document.querySelector('[data-nav="home"]').onclick = switchHome;

async function boot(){
  switchViewImmediate('home');
  await loadScriptsIndex();
  await loadJSON();
  renderBoardAuto();
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
