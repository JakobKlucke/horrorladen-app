/* =================== BaseDir & Pfade =================== */
const CURRENT_DIR = (() => {
  const p = location.pathname;
  return p.endsWith('/') ? p : p.replace(/[^/]+$/, '/');
})();

/* CodePen-Fallback: JSONs vom Repo via jsDelivr holen */
const IS_PEN   = /codepen|cdpn\.io/.test(location.host);
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/jakobklucke/horrorladen-app@main/';

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
const LS={ name:'hl_player_name', src:'hl_json_src', sfx:'hl_sfx_on', motion:'hl_reduce_motion' };

let jsonSrc; {
  const rawSrc = localStorage.getItem(LS.src) || 'horrorladen_final_with_acts.json';
  jsonSrc = normalizeScriptPath(rawSrc);
  localStorage.setItem(LS.src, jsonSrc);
}

let sfxOn = true;

const state={
  items:[], roles:[],
  actsList:[], scenesByAct:{},
  songsSet:new Set(),
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
const scanTitleLike=o=>{ if(!o||typeof o!=='object') return null; for(const k of ['title','name','label','id']) if(typeof o[k]==='string'&&o[k].trim()) return o[k].trim(); return null; };
const normalizeTitle=v=> typeof v==='string'?v:(typeof v==='number'?String(v):(v&&typeof v==='object'?(scanTitleLike(v)||''):''));

function isFullScript(data){
  if(!data) return false;
  if(Array.isArray(data)) return data.some(n=>typeof n==='object' && (n.type||'')==='speaker_block') || data.some(n=>n&&n.acts) || data.some(n=>n.children||n.segments||n.items);
  if(typeof data==='object') return !!(data.acts || data.segments || data.children || data.items);
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

function flattenAny(node,ctx={act:null,scene:null,song:null},out=[],meta){
  if(!node||typeof node!=='object') return;
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

/* =================== DOM Refs =================== */
const scriptSelect=document.getElementById('scriptSelect');
const scriptsNote =document.getElementById('scriptsNote');
const jsonLabel   =document.getElementById('jsonSrcLabel');

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
      return true;
    }else{
      if(scriptsNote) scriptsNote.textContent='scripts.json gefunden, aber leer.';
      if(scriptSelect) scriptSelect.innerHTML=`<option value="${jsonSrc}">${jsonSrc}</option>`;
      return false;
    }
  }catch{
    if(scriptsNote) scriptsNote.textContent='Keine scripts.json gefunden – Pfad kann manuell gesetzt werden.';
    if(scriptSelect) scriptSelect.innerHTML=`<option value="${jsonSrc}">${jsonSrc}</option>`;
    return false;
  }
}

/* =================== Content JSON laden =================== */
async function loadJSON(){
  jsonSrc = normalizeScriptPath(jsonSrc);
  if(jsonLabel) jsonLabel.textContent=jsonSrc;
  const tryPaths=[jsonSrc,'/'+jsonSrc.replace(/^\//,''),'./'+jsonSrc.replace(/^\//,'')];

  let data;
  try{
    data=await fetchJson(tryPaths);
  }catch(err){
    showError('JSON konnte nicht geladen werden', err.message);
    return;
  }

  const maybeIndex=parseScriptsJson(data);
  if(maybeIndex.length && !isFullScript(data)){
    jsonSrc=normalizeScriptPath(maybeIndex[0].value);
    localStorage.setItem(LS.src,jsonSrc);
    return loadJSON();
  }

  const out=[]; const meta={roles:new Set(), songs:new Set()};
  Array.isArray(data) ? flattenAny({segments:data},{},out,meta)
                      : flattenAny(data,{},out,meta);

  state.items=out;
  state.roles=[...meta.roles];
  state.songsSet=new Set([...meta.songs].map(normalizeTitle).filter(Boolean).sort((a,b)=>a.localeCompare(b)));

  state.actsList=[]; state.scenesByAct={};
  if(data && Array.isArray(data.acts)){
    data.acts.forEach(act=>{
      const a=normalizeTitle(act); if(!a) return;
      state.actsList.push(a);
      state.scenesByAct[a]=(Array.isArray(act.scenes)?act.scenes:[])
        .map(s=>normalizeTitle(s)).filter(Boolean);
    });
  }

  populateFilters();
}

/* =================== Errorbox =================== */
function showError(title,msg){
  const root=document.querySelector('[data-view].active')||document.body;
  const box=el('div',{class:'card'},
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
  if (sub) sub.textContent = (name === 'home' ? 'Willkommen' : name[0].toUpperCase() + name.slice(1));

  // Body-Flag (z.B. für .home-only CSS)
  document.body.classList.toggle('show-home', name === 'home');

  // Nach oben scrollen
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

// Globaler Klick-Sound nur über data-sfx (einheitlich, kein Doppel-Sound)
document.addEventListener('click', e=>{
  if (e.target.closest('[data-sfx]')) {
    tone([0], .07); // deine vorhandene tone()-Funktion
  }
}, { capture:true });


/* =================== Filter & Learn =================== */
function fillSongs(sel){ if(!sel) return; sel.innerHTML='<option value="">Alle</option>'+[...state.songsSet].map(s=>`<option>${s}</option>`).join(''); }

function populateFilters(){
  const roleOpts=state.roles.map(r=>`<option>${r}</option>`).join('');
  if(roleSel) roleSel.innerHTML=roleOpts;
  if(viewerRoleSel){ viewerRoleSel.innerHTML=roleOpts; state.viewerHighlightRole=viewerRoleSel.value||''; }
  if(roleSurv) roleSurv.innerHTML=roleOpts;

  const fillActs=sel=>{ if(!sel) return; sel.innerHTML='<option value="">Alle</option>'+state.actsList.map(a=>`<option>${a}</option>`).join(''); };
  fillActs(actSel); fillActs(actSelV);

  const refreshScenes=(act,sel)=>{ if(!sel) return; const list=act?(state.scenesByAct[act]||[]):Object.values(state.scenesByAct).flat(); sel.innerHTML='<option value="">Alle</option>'+list.map(s=>`<option>${s}</option>`).join(''); };
  refreshScenes('',sceneSel); refreshScenes('',sceneSelV);

  fillSongs(songSel); fillSongs(songSelV);

  renderViewer();
  markLearnDirty();
}

function markLearnDirty(){
  if(!startLearnBtn) return;
  startLearnBtn.disabled=false;
  startLearnBtn.classList.add('pulse');
}
[actSel,sceneSel,songSel,lyricsOnly,roleSel,modeSel].filter(Boolean).forEach(e=>e.addEventListener('change',()=>{ state.pageIndex=0; markLearnDirty(); }));

function applyFilters(items,{byRole=true,useViewer=false,roleOverride=null}={}){
  const role = roleOverride || (byRole && roleSel ? roleSel.value : '');
  const act  = useViewer?(actSelV?.value||''):(actSel?.value||'');
  const scene= useViewer?(sceneSelV?.value||''):(sceneSel?.value||'');
  const song = useViewer?(songSelV?.value||''):(songSel?.value||'');
  const lyr  = useViewer?!!(lyricsOnlyV&&lyricsOnlyV.checked):!!(lyricsOnly&&lyricsOnly.checked);

  return items.filter(it=>{
    if(byRole){
      const sp=treatSpeaker(it.speaker);
      if(!sp || sp==='__IGNORE__') return false;
      if(sp!=='ALLE' && sp!==norm(role)) return false;
    }
    if(act  && (it.meta?.act||'')   !== act)   return false;
    if(scene&& (it.meta?.scene||'') !== scene) return false;
    if(song && (it.meta?.song||'')  !== song)  return false;
    if(lyr  && it.kind!=='lyric')             return false;
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
  const mode=modeSel?.value||'classic';
  const pageSize=(mode==='classic')?state.pageSizeClassic:state.pageSizeSingle;
  const items=state.lastFiltered, total=items.length;

  if(!items.length){
    learnRoot.innerHTML='<div class="card">Keine Zeilen für die aktuelle Auswahl.</div>';
    if(pager) pager.hidden=true; if(learnCount) learnCount.textContent=`0/${state.items.length}`; setProg('0%'); return;
  }

  const pages=Math.max(1,Math.ceil(total/pageSize));
  state.pageIndex=Math.min(Math.max(0,state.pageIndex),pages-1);
  const slice=items.slice(state.pageIndex*pageSize, state.pageIndex*pageSize+pageSize);

  learnRoot.innerHTML='';
  const myRoleUC=norm(roleSel?.value||''); const fullSeq=applyFilters(state.items,{byRole:false}); const sameSong=!!(songSel&&songSel.value);

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
    const line=slice[0]; const {prev,next}=getContextForLine(line,fullSeq,myRoleUC,sameSong);
    if(prev) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--top'},`${prev.speaker}: ${prev.text}`));
    const card=el('div',{class:'fc-card',tabindex:'0','data-sfx':''});
    const title=el('h3',{class:'fc-card__title'}, line.speaker);
    const body=el('p',{class:'fc-card__content'}, '(tippen zum Aufdecken)');
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
    if(next) learnRoot.appendChild(el('div',{class:'fc-ctx fc-ctx--bottom'},`${next.speaker}: ${next.text}`));
  }
  else { // cloze (mit Aufdecken) – im exchange/line-Stil
    const line=slice[0]; const {prev,next}=getContextForLine(line,fullSeq,myRoleUC,sameSong);
    const box=el('div',{class:'exchange'});
    if(prev) box.appendChild(el('div',{class:'faded'},`${prev.speaker}: ${prev.text}`));

    const content=el('div',{class:'line big'});
    const masked=clozeHtmlLimitTwo(line.text||''); const full=escapeHtml(line.text||''); let revealed=false;
    const renderText=()=>{ content.innerHTML = `${line.speaker}: ${revealed?full:masked}`; };
    renderText();
    box.appendChild(content);

    const actions=el('div',{style:'margin-top:.5rem'}, el('button',{class:'btn secondary','data-sfx':''},'Aufdecken'));
    const btn=actions.querySelector('button'); btn.onclick=()=>{ revealed=!revealed; btn.textContent=revealed?'Verbergen':'Aufdecken'; renderText(); };
    box.appendChild(actions);

    if(next) box.appendChild(el('div',{class:'faded'},`${next.speaker}: ${next.text}`));
    learnRoot.appendChild(box);
  }

  if(pager){
    pager.hidden=pages<=1;
    pagerInfo.textContent=`Seite ${state.pageIndex+1}/${pages}`;
    prevPage.disabled=state.pageIndex===0; nextPage.disabled=state.pageIndex>=pages-1;
  }
  if(learnCount) learnCount.textContent=`${total}/${state.items.length}`;
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
function saveScore(score){
  const entry={ name:getPlayerName(), role:(roleSurv&&roleSurv.value)||'', score:Number(score)||0, ts:new Date().toISOString() };
  addLocalScore(entry);
}
async function fetchScoresJson(){
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

/* =================== Scripts-Auswahl Events =================== */
if(scriptSelect){
  scriptSelect.addEventListener('change', async e=>{
    const chosen=normalizeScriptPath(e.target.value);
    jsonSrc=chosen; localStorage.setItem(LS.src, chosen);
    if(jsonLabel) jsonLabel.textContent=chosen;
    await loadJSON();
  });
}

/* =================== Mobile: Pinch-Zoom killen =================== */
(function(){ ['gesturestart','gesturechange','gestureend'].forEach(evt=>document.addEventListener(evt,e=>e.preventDefault(),{passive:false})); })();

/* =================== Boot =================== */
async function boot(){
  switchViewImmediate('home');
  await loadScriptsIndex();
  await loadJSON();
  renderViewer(); // Learn erst nach Klick auf „Start“
}
document.readyState==='loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
