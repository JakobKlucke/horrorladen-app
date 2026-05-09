(function(){
  'use strict';

  const ScriptModel = window.ScriptModel;
  const KIND_OPTIONS = [
    ['dialogue', 'Dialog'],
    ['lyric', 'Liedtext'],
    ['stage_direction', 'Regie'],
    ['narration', 'Erzählung']
  ];
  const PAGE_SIZE = 100;

  const state = {
    sourceName: '',
    title: '',
    sessionId: '',
    pages: [],
    canonical: null,
    runtime: null,
    entries: [],
    roles: [],
    songs: [],
    reviewRows: [],
    activeStep: 0,
    backendStatus: null,
    pagination: {
      structurePage: 1,
      cutPage: 1
    },
    filters: {
      structureScene: '',
      structureSpeaker: '',
      songScene: '',
      cutScene: '',
      cutSong: '',
      cutSpeaker: '',
      showCutInFinal: false
    }
  };

  const refs = {
    steps: Array.from(document.querySelectorAll('.wizard-step')),
    panels: Array.from(document.querySelectorAll('.wizard-panel')),
    wizardProgress: document.getElementById('wizardProgress'),
    globalStatus: document.getElementById('globalStatus'),
    pdfFileInput: document.getElementById('pdfFileInput'),
    pdfTitleInput: document.getElementById('pdfTitleInput'),
    ocrModeSelect: document.getElementById('ocrModeSelect'),
    runPdfImportBtn: document.getElementById('runPdfImportBtn'),
    refreshBackendBtn: document.getElementById('refreshBackendBtn'),
    backendStatus: document.getElementById('backendStatus'),
    jsonFileInput: document.getElementById('jsonFileInput'),
    reviewFileInput: document.getElementById('reviewFileInput'),
    restructureBtn: document.getElementById('restructureBtn'),
    newRoleInput: document.getElementById('newRoleInput'),
    addRoleBtn: document.getElementById('addRoleBtn'),
    rolesList: document.getElementById('rolesList'),
    structureSceneFilter: document.getElementById('structureSceneFilter'),
    structureSpeakerFilter: document.getElementById('structureSpeakerFilter'),
    structureTable: document.getElementById('structureTable'),
    songSceneFilter: document.getElementById('songSceneFilter'),
    songsList: document.getElementById('songsList'),
    cutSceneFilter: document.getElementById('cutSceneFilter'),
    cutSongFilter: document.getElementById('cutSongFilter'),
    cutSpeakerFilter: document.getElementById('cutSpeakerFilter'),
    showCutInFinalToggle: document.getElementById('showCutInFinalToggle'),
    originalColumn: document.getElementById('originalColumn'),
    cutColumn: document.getElementById('cutColumn'),
    summaryTitle: document.getElementById('summaryTitle'),
    summaryEntries: document.getElementById('summaryEntries'),
    summaryLearnable: document.getElementById('summaryLearnable'),
    summaryIssues: document.getElementById('summaryIssues'),
    exportStatus: document.getElementById('exportStatus'),
    downloadReviewBtn: document.getElementById('downloadReviewBtn'),
    downloadJsonBtn: document.getElementById('downloadJsonBtn'),
    prevStepBtn: document.getElementById('prevStepBtn'),
    nextStepBtn: document.getElementById('nextStepBtn')
  };

  function escapeHtml(value){
    return String(value || '').replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[char]));
  }

  function normalize(value){
    return String(value || '').trim();
  }

  function normalizeList(value){
    return ScriptModel.normalizeStringList ? ScriptModel.normalizeStringList(value) : String(value || '').split(',').map(normalize).filter(Boolean);
  }

  function slugify(value){
    return normalize(value).toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  }

  function clone(value){
    return JSON.parse(JSON.stringify(value || null));
  }

  function csvNeedsQuotes(value){
    return /[",\n]/.test(String(value || ''));
  }

  function stringifyCsv(rows){
    const columns = ['issue_id', 'start_entry_id', 'end_entry_id', 'field', 'value', 'status', 'reason', 'page', 'confidence'];
    const lines = [columns.join(',')];
    (rows || []).forEach(row => {
      const values = columns.map(column => {
        const value = row && row[column] != null ? String(row[column]) : '';
        if(!csvNeedsQuotes(value)) return value;
        return `"${value.replace(/"/g, '""')}"`;
      });
      lines.push(values.join(','));
    });
    return lines.join('\n') + '\n';
  }

  function parseCsv(text){
    const rows = [];
    const source = String(text || '');
    const values = [];
    let current = '';
    let inQuotes = false;

    for(let i = 0; i < source.length; i += 1){
      const char = source[i];
      if(inQuotes){
        if(char === '"' && source[i + 1] === '"'){
          current += '"';
          i += 1;
        }else if(char === '"'){
          inQuotes = false;
        }else{
          current += char;
        }
        continue;
      }
      if(char === '"') inQuotes = true;
      else if(char === ','){
        values.push(current);
        current = '';
      }else if(char === '\n'){
        values.push(current.replace(/\r$/, ''));
        rows.push(values.splice(0, values.length));
        current = '';
      }else current += char;
    }
    if(current.length || values.length){
      values.push(current.replace(/\r$/, ''));
      rows.push(values.splice(0, values.length));
    }
    if(!rows.length) return [];
    const headers = rows.shift().map(value => value.trim());
    return rows
      .filter(row => row.some(value => normalize(value)))
      .map(row => {
        const item = {};
        headers.forEach((header, index) => {
          item[header] = row[index] != null ? row[index] : '';
        });
        return item;
      });
  }

  function downloadBlob(filename, text, type){
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function setNote(node, message, ok = false){
    if(!node) return;
    node.textContent = message;
    node.classList.toggle('review-note--ok', !!ok);
  }

  function defaultLaunchCommand(){
    return 'python3 tools/import_studio_server.py';
  }

  function formatBackendStatus(payload){
    const deps = payload && payload.dependencies ? payload.dependencies : {};
    const pypdfReady = !!(deps.pypdf && deps.pypdf.available);
    const ocrReady = !!(deps.ocr && deps.ocr.available);
    const parts = [
      pypdfReady ? 'PDF-Import bereit.' : `pypdf fehlt: ${deps.pypdf?.installHint || 'python3 -m pip install pypdf'}`,
      ocrReady ? 'OCR bereit.' : 'OCR nicht vollständig verfügbar.'
    ];
    if(deps.ocr && Array.isArray(deps.ocr.languages) && deps.ocr.languages.length){
      parts.push(`Sprachen: ${deps.ocr.languages.join(', ')}`);
    }
    return parts.join(' ');
  }

  function roleById(id){
    return state.roles.find(role => role.id === id);
  }

  function confirmedRoles(){
    return state.roles.filter(role => role.confirmed !== false && normalize(role.label));
  }

  function hasRoleDraft(){
    return !!state.sessionId || !!state.roles.length || !!state.entries.length;
  }

  function songById(id){
    return state.songs.find(song => song.id === id);
  }

  function songLabel(song){
    if(!song) return '';
    return ScriptModel.formatSongLabel({
      songNumber: song.number,
      songTitle: song.title,
      label: song.label
    }) || song.label || song.title || song.number || '';
  }

  function entrySceneLabel(entry){
    return entry.sceneLabel || entry.actLabel || 'Ohne Szene';
  }

  function entrySongLabel(entry){
    const song = songById(entry.songId);
    return songLabel(song) || entry.songLabel || 'Ohne Song';
  }

  function currentScript(){
    const roles = confirmedRoles().map(role => ({
      id: role.id,
      label: role.label,
      aliases: normalizeList(role.aliases)
    }));
    const songs = state.songs.map(song => ({
      id: song.id,
      label: songLabel(song),
      number: song.number || '',
      title: song.title || song.label || '',
      actId: song.actId || '',
      sceneId: song.sceneId || '',
      singerIds: normalizeList(song.singerIds)
    }));
    const entries = state.entries.map(entry => {
      const next = Object.assign({}, entry);
      const role = roleById(next.speakerId);
      if(role){
        next.speaker = role.label;
      }
      const song = songById(next.songId);
      if(song){
        next.songNumber = song.number || '';
        next.songTitle = song.title || '';
        next.songLabel = songLabel(song);
      }
      return next;
    });
    return ScriptModel.normalizeScriptData({
      schemaVersion: ScriptModel.CANONICAL_VERSION,
      title: state.title || state.canonical?.title || 'Unbenanntes Skript',
      sourceFormat: state.canonical?.sourceFormat || 'pdf_import',
      sourceFile: state.canonical?.sourceFile || state.sourceName,
      pages: clone(state.pages) || [],
      roles,
      songs,
      entries,
      issues: state.reviewRows.map(row => Object.assign({}, row))
    });
  }

  function syncRuntime(){
    if(!state.entries.length){
      state.runtime = null;
      return;
    }
    const script = currentScript();
    state.canonical = script;
    state.runtime = ScriptModel.buildRuntimeModel(script);
  }

  function resetEntryPagination(){
    state.pagination.structurePage = 1;
    state.pagination.cutPage = 1;
  }

  function pageSlice(items, page){
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    return {
      items: items.slice(start, start + PAGE_SIZE),
      currentPage,
      totalPages,
      start,
      end: Math.min(start + PAGE_SIZE, total),
      total
    };
  }

  function renderPager(kind, pageInfo){
    if(pageInfo.total <= PAGE_SIZE) return '';
    return `
      <div class="pager-row" data-pager="${kind}">
        <button class="btn secondary" type="button" data-page-action="prev" ${pageInfo.currentPage <= 1 ? 'disabled' : ''}>Zurück</button>
        <strong>${pageInfo.start + 1}-${pageInfo.end} von ${pageInfo.total}</strong>
        <button class="btn secondary" type="button" data-page-action="next" ${pageInfo.currentPage >= pageInfo.totalPages ? 'disabled' : ''}>Weiter</button>
      </div>
    `;
  }

  function changePage(kind, direction){
    const key = kind === 'cuts' ? 'cutPage' : 'structurePage';
    state.pagination[key] = Math.max(1, state.pagination[key] + direction);
    renderWizard();
  }

  function onPagerClick(event){
    const action = event.target.dataset.pageAction;
    const pager = event.target.closest('[data-pager]');
    if(!action || !pager) return;
    changePage(pager.dataset.pager, action === 'next' ? 1 : -1);
  }

  function setSelectOptions(select, options, selectedValue, allLabel){
    if(!select) return;
    const current = selectedValue || '';
    select.innerHTML = [
      `<option value="">${escapeHtml(allLabel)}</option>`,
      ...options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === current ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    ].join('');
  }

  function sceneOptions(){
    const seen = new Set();
    return state.entries
      .filter(entry => entry.sceneId || entry.sceneLabel)
      .map(entry => ({ value:entry.sceneId || entry.sceneLabel, label:entry.sceneLabel || entry.sceneId }))
      .filter(option => {
        if(seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
      });
  }

  function speakerOptions(){
    return confirmedRoles().map(role => ({ value:role.id, label:role.label }));
  }

  function songOptions(){
    return state.songs.map(song => ({ value:song.id, label:songLabel(song) || song.id }));
  }

  function filteredEntries(kind){
    return state.entries.filter(entry => {
      if(kind === 'structure'){
        if(state.filters.structureScene && (entry.sceneId || entry.sceneLabel) !== state.filters.structureScene) return false;
        if(state.filters.structureSpeaker && entry.speakerId !== state.filters.structureSpeaker) return false;
      }
      if(kind === 'cuts'){
        if(state.filters.cutScene && (entry.sceneId || entry.sceneLabel) !== state.filters.cutScene) return false;
        if(state.filters.cutSong && entry.songId !== state.filters.cutSong) return false;
        if(state.filters.cutSpeaker && entry.speakerId !== state.filters.cutSpeaker) return false;
      }
      return true;
    });
  }

  function updateSummary(){
    if(!state.entries.length){
      refs.summaryTitle.textContent = '-';
      refs.summaryEntries.textContent = '0 Einträge';
      refs.summaryLearnable.textContent = '0 lernbar';
      refs.summaryIssues.textContent = '0 Hinweise';
      setNote(refs.exportStatus, state.roles.length ? 'Rollen sind vorbereitet. Das Skript muss noch strukturiert werden.' : 'Noch kein Skript geladen.');
      refs.downloadReviewBtn.disabled = true;
      refs.downloadJsonBtn.disabled = true;
      return;
    }
    const learnableCount = state.entries.filter(entry => (entry.kind === 'dialogue' || entry.kind === 'lyric') && !entry.cut).length;
    const pending = ScriptModel.countPendingIssues(state.reviewRows);
    refs.summaryTitle.textContent = state.title || state.canonical?.title || 'Unbenanntes Skript';
    refs.summaryEntries.textContent = `${state.entries.length} Einträge`;
    refs.summaryLearnable.textContent = `${learnableCount} lernbar`;
    refs.summaryIssues.textContent = state.reviewRows.length ? `${pending}/${state.reviewRows.length} offen` : '0 Hinweise';
    setNote(refs.exportStatus, `${learnableCount} Zeilen gehen in die Lernfassung. ${state.entries.filter(entry => entry.cut).length} Zeilen sind gestrichen.`, true);
    refs.downloadReviewBtn.disabled = false;
    refs.downloadJsonBtn.disabled = false;
  }

  function renderRoles(){
    if(!refs.rolesList) return;
    if(!hasRoleDraft()){
      refs.rolesList.innerHTML = '<div class="faded">Noch keine PDF oder JSON geladen.</div>';
      return;
    }
    if(!state.roles.length){
      refs.rolesList.innerHTML = '<div class="faded">Keine Figuren erkannt. Du kannst sie manuell hinzufügen.</div>';
      return;
    }
    const mergeTargets = confirmedRoles();
    refs.rolesList.innerHTML = state.roles.map(role => {
      const count = state.entries.filter(entry => entry.speakerId === role.id || normalize(entry.speaker).toUpperCase() === normalize(role.label).toUpperCase()).length;
      const aliasText = normalizeList(role.aliases).join(', ');
      const detail = [
        role.description,
        role.page ? `Seite ${role.page}` : '',
        role.source ? `Quelle: ${role.source}` : ''
      ].filter(Boolean).join(' · ');
      const targetOptions = mergeTargets
        .filter(target => target.id !== role.id)
        .map(target => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`)
        .join('');
      return `
        <article class="role-row" data-role-id="${escapeHtml(role.id)}">
          <label class="checkbox-container">
            <input class="custom-checkbox" type="checkbox" data-role-field="confirmed" ${role.confirmed === false ? '' : 'checked'}>
            <span>Aktiv</span>
          </label>
          <label>Figur
            <input type="text" data-role-field="label" value="${escapeHtml(role.label)}">
          </label>
          <label>Aliase
            <input type="text" data-role-field="aliases" value="${escapeHtml(aliasText)}" placeholder="Alias 1, Alias 2">
          </label>
          <div class="role-row__meta">${count} Zeilen</div>
          <div class="role-row__detail">${escapeHtml(detail)}</div>
          <select data-role-field="mergeTarget">
            <option value="">Zusammenführen mit...</option>
            ${targetOptions}
          </select>
          <button class="btn secondary" type="button" data-role-action="merge">Zusammenführen</button>
          <button class="btn secondary" type="button" data-role-action="remove">Entfernen</button>
        </article>
      `;
    }).join('');
  }

  function renderStructure(){
    if(!refs.structureTable) return;
    if(!state.entries.length){
      refs.structureTable.innerHTML = '<div class="faded">Bestätige zuerst die Figuren und klicke auf Skript strukturieren.</div>';
      return;
    }
    setSelectOptions(refs.structureSceneFilter, sceneOptions(), state.filters.structureScene, 'Alle Szenen');
    setSelectOptions(refs.structureSpeakerFilter, speakerOptions(), state.filters.structureSpeaker, 'Alle Figuren');
    const entries = filteredEntries('structure');
    const pageInfo = pageSlice(entries, state.pagination.structurePage);
    state.pagination.structurePage = pageInfo.currentPage;
    const speakerSelect = current => [
      '<option value="">Ohne Sprecher</option>',
      ...speakerOptions().map(option => `<option value="${escapeHtml(option.value)}" ${option.value === current ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    ].join('');
    refs.structureTable.innerHTML = entries.length ? [
      renderPager('structure', pageInfo),
      ...pageInfo.items.map(entry => `
      <article class="structure-row" data-entry-id="${escapeHtml(entry.id)}">
        <div class="structure-row__meta">
          <span class="meta-chip">Seite ${escapeHtml(entry.page || '-')}</span>
          <span class="meta-chip">${escapeHtml(entrySceneLabel(entry))}</span>
          <span class="meta-chip">${escapeHtml(entrySongLabel(entry))}</span>
        </div>
        <select data-entry-field="speakerId">${speakerSelect(entry.speakerId)}</select>
        <select data-entry-field="kind">
          ${KIND_OPTIONS.map(([value, label]) => `<option value="${value}" ${entry.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <label class="checkbox-container">
          <input class="custom-checkbox" type="checkbox" data-entry-field="cut" ${entry.cut ? 'checked' : ''}>
          <span>Strich</span>
        </label>
        <div class="structure-row__text">${escapeHtml(entry.text)}</div>
      </article>
    `),
      renderPager('structure', pageInfo)
    ].join('') : '<div class="faded">Keine Einträge für diesen Filter.</div>';
  }

  function renderSongs(){
    if(!refs.songsList) return;
    setSelectOptions(refs.songSceneFilter, sceneOptions(), state.filters.songScene, 'Alle Szenen');
    const songs = state.songs.filter(song => !state.filters.songScene || song.sceneId === state.filters.songScene);
    if(!state.entries.length){
      refs.songsList.innerHTML = '<div class="panel wizard-card faded">Noch kein Skript geladen.</div>';
      return;
    }
    if(!songs.length){
      refs.songsList.innerHTML = '<div class="panel wizard-card faded">Keine Songs erkannt.</div>';
      return;
    }
    const roles = confirmedRoles();
    refs.songsList.innerHTML = songs.map(song => {
      const entries = state.entries.filter(entry => entry.songId === song.id);
      const preview = entries.slice(0, 4).map(entry => `<p>${escapeHtml(entry.speaker || 'Ohne Sprecher')}: ${escapeHtml(entry.text)}</p>`).join('');
      const singers = roles.map(role => {
        const checked = normalizeList(song.singerIds).includes(role.id);
        return `
          <label class="checkbox-container singer-check">
            <input class="custom-checkbox" type="checkbox" data-song-id="${escapeHtml(song.id)}" data-singer-id="${escapeHtml(role.id)}" ${checked ? 'checked' : ''}>
            <span>${escapeHtml(role.label)}</span>
          </label>
        `;
      }).join('');
      return `
        <article class="panel song-card" data-song-id="${escapeHtml(song.id)}">
          <div class="song-card__head">
            <label>Nummer
              <input type="text" data-song-field="number" value="${escapeHtml(song.number || '')}">
            </label>
            <label>Titel
              <input type="text" data-song-field="title" value="${escapeHtml(song.title || song.label || '')}">
            </label>
          </div>
          <div class="review-entry-card__meta">
            <span class="meta-chip">${escapeHtml(song.sceneId || 'Ohne Szene')}</span>
            <span class="meta-chip">${entries.length} Zeilen</span>
          </div>
          <div class="singer-list">${singers || '<span class="faded">Keine aktiven Figuren.</span>'}</div>
          <div class="song-preview">${preview || '<p class="faded">Keine Vorschau.</p>'}</div>
        </article>
      `;
    }).join('');
  }

  function renderCuts(){
    if(!state.entries.length){
      refs.originalColumn.innerHTML = '<div class="faded">Bestätige zuerst die Figuren und strukturiere das Skript.</div>';
      refs.cutColumn.innerHTML = '<div class="faded">Noch keine Strichfassung verfügbar.</div>';
      return;
    }
    setSelectOptions(refs.cutSceneFilter, sceneOptions(), state.filters.cutScene, 'Alle Szenen');
    setSelectOptions(refs.cutSongFilter, songOptions(), state.filters.cutSong, 'Alle Songs');
    setSelectOptions(refs.cutSpeakerFilter, speakerOptions(), state.filters.cutSpeaker, 'Alle Figuren');
    const entries = filteredEntries('cuts');
    const pageInfo = pageSlice(entries, state.pagination.cutPage);
    state.pagination.cutPage = pageInfo.currentPage;
    const original = pageInfo.items.map(entry => `
      <article class="cut-line ${entry.cut ? 'is-cut' : ''}" data-entry-id="${escapeHtml(entry.id)}">
        <div>
          <strong>${escapeHtml(entry.speaker || entry.kind)}</strong>
          <p>${escapeHtml(entry.text)}</p>
        </div>
        <button class="btn secondary" type="button" data-toggle-cut="${escapeHtml(entry.id)}">${entry.cut ? 'Wiederherstellen' : 'Streichen'}</button>
      </article>
    `).join('');
    const finalEntries = pageInfo.items.filter(entry => state.filters.showCutInFinal || !entry.cut);
    const finalVersion = finalEntries.map(entry => `
      <article class="cut-line ${entry.cut ? 'is-cut' : ''}">
        <div>
          <strong>${escapeHtml(entry.speaker || entry.kind)}</strong>
          <p>${escapeHtml(entry.text)}</p>
        </div>
      </article>
    `).join('');
    const pager = renderPager('cuts', pageInfo);
    refs.originalColumn.innerHTML = entries.length ? `${pager}${original}${pager}` : '<div class="faded">Keine Einträge für diesen Filter.</div>';
    refs.cutColumn.innerHTML = entries.length ? `${pager}${finalVersion || '<div class="faded">Alle Einträge auf dieser Seite sind gestrichen.</div>'}${pager}` : '<div class="faded">Keine Einträge für diesen Filter.</div>';
    if(refs.showCutInFinalToggle) refs.showCutInFinalToggle.checked = state.filters.showCutInFinal;
  }

  function renderWizard(){
    refs.steps.forEach((step, index) => {
      step.classList.toggle('active', index === state.activeStep);
      step.disabled = !canAccessStep(index);
    });
    refs.panels.forEach((panel, index) => {
      panel.classList.toggle('active', index === state.activeStep);
    });
    if(refs.wizardProgress){
      refs.wizardProgress.style.width = `${((state.activeStep + 1) / refs.steps.length) * 100}%`;
    }
    refs.prevStepBtn.disabled = state.activeStep === 0;
    refs.nextStepBtn.disabled = !canProceedNext();
    refs.nextStepBtn.textContent = state.activeStep === 1 && !state.entries.length && state.sessionId ? 'Skript strukturieren' : (state.activeStep === refs.steps.length - 1 ? 'Fertig' : 'Weiter');
    refs.nextStepBtn.disabled = refs.nextStepBtn.disabled || state.activeStep === refs.steps.length - 1;
    if(refs.restructureBtn){
      refs.restructureBtn.textContent = state.entries.length ? 'Neu aufteilen' : 'Skript strukturieren';
      refs.restructureBtn.disabled = !state.sessionId || !confirmedRoles().length;
    }
    if(state.activeStep === 1) renderRoles();
    if(state.activeStep === 2) renderStructure();
    if(state.activeStep === 3) renderSongs();
    if(state.activeStep === 4) renderCuts();
    updateSummary();
  }

  function canAccessStep(index){
    if(index === 0) return true;
    if(index === 1) return hasRoleDraft();
    return !!state.entries.length;
  }

  function canProceedNext(){
    if(state.activeStep >= refs.steps.length - 1) return false;
    if(state.activeStep === 0) return hasRoleDraft();
    if(state.activeStep === 1) return !!state.entries.length || (!!state.sessionId && !!confirmedRoles().length);
    return !!state.entries.length;
  }

  function goToStep(index){
    if(index < 0 || index >= refs.panels.length) return;
    if(!canAccessStep(index)) return;
    state.activeStep = index;
    renderWizard();
  }

  function buildRoleFromLabel(label){
    const clean = normalize(label);
    return {
      id: `role-${slugify(clean)}`,
      label: clean,
      aliases: [],
      confirmed: true
    };
  }

  function normalizeRoles(rawRoles){
    const seen = new Set();
    const roles = [];
    (rawRoles || []).forEach(raw => {
      const label = normalize(raw.label || raw.name || raw.speaker);
      if(!label) return;
      const id = normalize(raw.id || raw.roleId) || `role-${slugify(label)}`;
      const key = id || label.toUpperCase();
      if(seen.has(key)) return;
      seen.add(key);
      roles.push({
        id,
        label,
        aliases: normalizeList(raw.aliases),
        confirmed: raw.confirmed !== false,
        description: normalize(raw.description),
        page: raw.page || '',
        confidence: normalize(raw.confidence),
        source: normalize(raw.source)
      });
    });
    return roles;
  }

  function normalizeSongs(rawSongs){
    return (rawSongs || []).map(raw => {
      const number = normalize(raw.number || raw.songNumber);
      const title = normalize(raw.title || raw.songTitle || raw.name);
      const label = normalize(raw.label || raw.songLabel || ScriptModel.formatSongLabel({ songNumber:number, songTitle:title }));
      return {
        id: normalize(raw.id || raw.songId) || `song-${slugify(number || title || label)}`,
        number,
        title: title || label,
        label: label || title || number,
        actId: normalize(raw.actId),
        sceneId: normalize(raw.sceneId),
        singerIds: normalizeList(raw.singerIds)
      };
    });
  }

  function loadRuntimeFromData(data, sourceName, options = {}){
    const runtime = ScriptModel.buildRuntimeModel(data);
    state.sourceName = sourceName || 'skript';
    state.title = runtime.canonical.title || sourceName || 'Unbenanntes Skript';
    state.sessionId = options.sessionId || state.sessionId || '';
    state.pages = Array.isArray(options.pages) ? clone(options.pages) : clone(data.pages || runtime.canonical.pages || []);
    state.canonical = runtime.canonical;
    state.runtime = runtime;
    state.entries = runtime.entries.map(entry => Object.assign({}, entry));
    state.roles = normalizeRoles(options.roleCandidates || runtime.roles);
    state.songs = normalizeSongs(options.songCandidates || runtime.songs);
    state.reviewRows = Array.isArray(options.reviewRows)
      ? options.reviewRows.map(row => Object.assign({}, row))
      : runtime.issues.map(row => Object.assign({}, row));
    resetEntryPagination();
    setNote(refs.globalStatus, `Skript geladen: ${state.title}`, true);
    goToStep(options.nextStep == null ? 1 : options.nextStep);
  }

  function loadRolePreviewFromImport(payload, sourceName){
    state.sourceName = sourceName || payload.filenameBase || 'skript';
    state.title = normalize(refs.pdfTitleInput?.value) || payload.filenameBase || 'Unbenanntes Skript';
    state.sessionId = payload.sessionId || '';
    state.pages = Array.isArray(payload.previewPages) ? clone(payload.previewPages) : [];
    state.canonical = null;
    state.runtime = null;
    state.entries = [];
    state.roles = normalizeRoles(payload.roleCandidates || []);
    state.songs = normalizeSongs(payload.songCandidates || []);
    state.reviewRows = Array.isArray(payload.reviewRows) ? payload.reviewRows.map(row => Object.assign({}, row)) : [];
    resetEntryPagination();
    setNote(refs.globalStatus, `Rollenvorschau geladen: ${state.roles.length} Vorschläge aus ${state.pages.length} Seiten.`, true);
    goToStep(1);
  }

  async function refreshBackendHealth(){
    try{
      const response = await fetch('./api/status', { cache:'no-store' });
      if(!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
      const payload = await response.json();
      state.backendStatus = payload;
      const pypdfReady = !!payload?.dependencies?.pypdf?.available;
      refs.runPdfImportBtn.disabled = !pypdfReady;
      setNote(refs.backendStatus, formatBackendStatus(payload), pypdfReady);
      return payload;
    }catch(error){
      state.backendStatus = null;
      refs.runPdfImportBtn.disabled = true;
      setNote(refs.backendStatus, `Kein lokaler Import-Server erreichbar: ${defaultLaunchCommand()}`);
      return null;
    }
  }

  async function runPdfImport(){
    const file = refs.pdfFileInput?.files && refs.pdfFileInput.files[0];
    if(!file){
      setNote(refs.backendStatus, 'Bitte PDF-Datei auswählen.');
      return;
    }
    const backend = state.backendStatus || await refreshBackendHealth();
    if(!backend || !backend?.dependencies?.pypdf?.available) return;

    const title = normalize(refs.pdfTitleInput?.value) || file.name.replace(/\.pdf$/i, '');
    const params = new URLSearchParams({
      title,
      ocrMode: refs.ocrModeSelect?.value || 'auto',
      sourceName: file.name
    });
    const originalLabel = refs.runPdfImportBtn.textContent;
    refs.runPdfImportBtn.disabled = true;
    refs.runPdfImportBtn.textContent = 'Import läuft...';
    setNote(refs.backendStatus, `Importiere ${file.name} ...`);

    try{
      const response = await fetch(`./api/import?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type':'application/pdf' },
        body: file
      });
      const payload = await response.json();
      if(!response.ok || !payload.ok) throw new Error(payload.error || response.statusText || 'Import fehlgeschlagen');
      loadRolePreviewFromImport(payload, payload.filenameBase || file.name.replace(/\.pdf$/i, ''));
      setNote(refs.backendStatus, `Rollenvorschau: ${payload.summary?.previewPages || 0} Seiten, ${payload.summary?.roleCandidates || 0} Figuren-Vorschläge.`, true);
    }catch(error){
      setNote(refs.backendStatus, `PDF-Import fehlgeschlagen: ${error.message || error}`);
    }finally{
      refs.runPdfImportBtn.textContent = originalLabel;
      refs.runPdfImportBtn.disabled = !(state.backendStatus?.dependencies?.pypdf?.available);
    }
  }

  async function restructureFromServer(nextStep){
    if(!state.sessionId){
      setNote(refs.globalStatus, 'Neuaufteilung ist nur nach PDF-Import verfügbar.');
      return;
    }
    setNote(refs.globalStatus, 'Text wird mit bestätigten Figuren neu aufgeteilt.');
    try{
      const response = await fetch('./api/structure', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          roles: state.roles,
          songs: state.songs,
          entries: state.entries.map(entry => ({
            id: entry.id,
            speakerId: entry.speakerId,
            speaker: entry.speaker,
            kind: entry.kind,
            cut: entry.cut
          })),
          cutEntryIds: state.entries.filter(entry => entry.cut).map(entry => entry.id)
        })
      });
      const payload = await response.json();
      if(!response.ok || !payload.ok) throw new Error(payload.error || response.statusText || 'Neuaufteilung fehlgeschlagen');
      loadRuntimeFromData(payload.script, state.sourceName, {
        sessionId: state.sessionId,
        roleCandidates: payload.roleCandidates,
        songCandidates: payload.songCandidates,
        reviewRows: payload.reviewRows,
        nextStep: nextStep == null ? state.activeStep : nextStep
      });
      setNote(refs.globalStatus, 'Textaufteilung aktualisiert.', true);
    }catch(error){
      setNote(refs.globalStatus, `Neuaufteilung fehlgeschlagen: ${error.message || error}`);
    }
  }

  async function loadJsonFile(file){
    const data = JSON.parse(await file.text());
    loadRuntimeFromData(data, file.name.replace(/\.json$/i, ''), { nextStep:1 });
  }

  async function loadReviewFile(file){
    state.reviewRows = parseCsv(await file.text());
    setNote(refs.globalStatus, `Review-CSV geladen: ${file.name}`, true);
    renderWizard();
  }

  async function loadJsonFromUrl(){
    const params = new URLSearchParams(location.search);
    const src = params.get('src');
    if(!src) return;
    try{
      const response = await fetch(src, { cache:'no-store' });
      if(!response.ok) throw new Error(response.statusText);
      const data = await response.json();
      const sourceName = src.split('/').pop()?.replace(/\.json$/i, '') || 'skript';
      loadRuntimeFromData(data, sourceName, { nextStep:1 });
    }catch(error){
      setNote(refs.globalStatus, `Konnte Skript nicht laden: ${error.message || error}`);
    }
  }

  function onRoleInput(event){
    const row = event.target.closest('.role-row');
    if(!row) return;
    const role = roleById(row.dataset.roleId);
    if(!role) return;
    const field = event.target.dataset.roleField;
    if(field === 'confirmed') role.confirmed = event.target.checked;
    if(field === 'label'){
      role.label = normalize(event.target.value);
      state.entries.forEach(entry => {
        if(entry.speakerId === role.id) entry.speaker = role.label;
      });
    }
    if(field === 'aliases') role.aliases = normalizeList(event.target.value);
    if(event.type === 'input' && (field === 'label' || field === 'aliases')){
      updateSummary();
      return;
    }
    renderWizard();
  }

  function onRoleClick(event){
    const action = event.target.dataset.roleAction;
    if(!action) return;
    const row = event.target.closest('.role-row');
    const role = roleById(row?.dataset.roleId);
    if(!role) return;
    if(action === 'remove'){
      state.roles = state.roles.filter(item => item.id !== role.id);
      state.entries.forEach(entry => {
        if(entry.speakerId === role.id){
          entry.speakerId = '';
          entry.speaker = '';
        }
      });
    }
    if(action === 'merge'){
      const targetId = row.querySelector('[data-role-field="mergeTarget"]')?.value;
      const target = roleById(targetId);
      if(target){
        target.aliases = normalizeList([...(target.aliases || []), role.label, ...(role.aliases || [])]);
        state.entries.forEach(entry => {
          if(entry.speakerId === role.id){
            entry.speakerId = target.id;
            entry.speaker = target.label;
          }
        });
        state.roles = state.roles.filter(item => item.id !== role.id);
      }
    }
    renderWizard();
  }

  function addRole(){
    const label = normalize(refs.newRoleInput.value);
    if(!label) return;
    const role = buildRoleFromLabel(label);
    let id = role.id;
    let suffix = 2;
    while(state.roles.some(item => item.id === id)){
      id = `${role.id}-${suffix}`;
      suffix += 1;
    }
    role.id = id;
    state.roles.push(role);
    refs.newRoleInput.value = '';
    renderWizard();
  }

  function onStructureInput(event){
    const row = event.target.closest('.structure-row');
    if(!row) return;
    const entry = state.entries.find(item => item.id === row.dataset.entryId);
    if(!entry) return;
    const field = event.target.dataset.entryField;
    if(field === 'speakerId'){
      const role = roleById(event.target.value);
      entry.speakerId = role ? role.id : '';
      entry.speaker = role ? role.label : '';
    }
    if(field === 'kind') entry.kind = event.target.value;
    if(field === 'cut') entry.cut = event.target.checked;
    renderWizard();
  }

  function onSongInput(event){
    const card = event.target.closest('.song-card');
    if(!card) return;
    const song = songById(card.dataset.songId);
    if(!song) return;
    const field = event.target.dataset.songField;
    if(field === 'number') song.number = event.target.value;
    if(field === 'title') song.title = event.target.value;
    if(event.target.dataset.singerId){
      const singerId = event.target.dataset.singerId;
      const singers = new Set(normalizeList(song.singerIds));
      if(event.target.checked) singers.add(singerId);
      else singers.delete(singerId);
      song.singerIds = Array.from(singers);
    }
    song.label = songLabel(song);
    renderWizard();
  }

  function onToggleCut(event){
    const entryId = event.target.dataset.toggleCut;
    if(!entryId) return;
    const entry = state.entries.find(item => item.id === entryId);
    if(!entry) return;
    entry.cut = !entry.cut;
    renderWizard();
  }

  function onDownloadReview(){
    const rows = state.reviewRows.length ? state.reviewRows : (state.runtime?.issues || []);
    downloadBlob(`${state.sourceName || 'skript'}_review.csv`, stringifyCsv(rows), 'text/csv;charset=utf-8');
  }

  function onDownloadJson(){
    syncRuntime();
    downloadBlob(`${state.sourceName || 'skript'}_final.json`, JSON.stringify(state.canonical, null, 2) + '\n', 'application/json;charset=utf-8');
  }

  function bindEvents(){
    refs.steps.forEach((step, index) => step.addEventListener('click', () => goToStep(index)));
    refs.prevStepBtn.addEventListener('click', () => goToStep(state.activeStep - 1));
    refs.nextStepBtn.addEventListener('click', async () => {
      if(state.activeStep === 1 && !state.entries.length && state.sessionId){
        await restructureFromServer(2);
        return;
      }
      goToStep(Math.min(state.activeStep + 1, refs.panels.length - 1));
    });
    refs.refreshBackendBtn.addEventListener('click', refreshBackendHealth);
    refs.runPdfImportBtn.addEventListener('click', runPdfImport);
    refs.restructureBtn.addEventListener('click', () => restructureFromServer(state.entries.length ? state.activeStep : 2));
    refs.addRoleBtn.addEventListener('click', addRole);
    refs.newRoleInput.addEventListener('keydown', event => {
      if(event.key === 'Enter') addRole();
    });
    refs.rolesList.addEventListener('input', onRoleInput);
    refs.rolesList.addEventListener('change', onRoleInput);
    refs.rolesList.addEventListener('click', onRoleClick);
    refs.structureTable.addEventListener('input', onStructureInput);
    refs.structureTable.addEventListener('change', onStructureInput);
    refs.structureTable.addEventListener('click', onPagerClick);
    refs.songsList.addEventListener('input', onSongInput);
    refs.songsList.addEventListener('change', onSongInput);
    refs.originalColumn.addEventListener('click', onToggleCut);
    refs.originalColumn.addEventListener('click', onPagerClick);
    refs.cutColumn.addEventListener('click', onPagerClick);
    refs.structureSceneFilter.addEventListener('change', event => {
      state.filters.structureScene = event.target.value;
      state.pagination.structurePage = 1;
      renderWizard();
    });
    refs.structureSpeakerFilter.addEventListener('change', event => {
      state.filters.structureSpeaker = event.target.value;
      state.pagination.structurePage = 1;
      renderWizard();
    });
    refs.songSceneFilter.addEventListener('change', event => {
      state.filters.songScene = event.target.value;
      renderWizard();
    });
    refs.cutSceneFilter.addEventListener('change', event => {
      state.filters.cutScene = event.target.value;
      state.pagination.cutPage = 1;
      renderWizard();
    });
    refs.cutSongFilter.addEventListener('change', event => {
      state.filters.cutSong = event.target.value;
      state.pagination.cutPage = 1;
      renderWizard();
    });
    refs.cutSpeakerFilter.addEventListener('change', event => {
      state.filters.cutSpeaker = event.target.value;
      state.pagination.cutPage = 1;
      renderWizard();
    });
    refs.showCutInFinalToggle.addEventListener('change', event => {
      state.filters.showCutInFinal = event.target.checked;
      renderCuts();
    });
    refs.pdfFileInput.addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if(file && refs.pdfTitleInput && !refs.pdfTitleInput.value.trim()){
        refs.pdfTitleInput.value = file.name.replace(/\.pdf$/i, '');
      }
    });
    refs.jsonFileInput.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if(!file) return;
      try{
        await loadJsonFile(file);
      }catch(error){
        setNote(refs.globalStatus, `JSON konnte nicht geladen werden: ${error.message || error}`);
      }
    });
    refs.reviewFileInput.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if(!file) return;
      try{
        await loadReviewFile(file);
      }catch(error){
        setNote(refs.globalStatus, `Review-CSV konnte nicht geladen werden: ${error.message || error}`);
      }
    });
    refs.downloadReviewBtn.addEventListener('click', onDownloadReview);
    refs.downloadJsonBtn.addEventListener('click', onDownloadJson);
  }

  if(!ScriptModel){
    setNote(refs.globalStatus, 'script-model.js fehlt.');
    return;
  }

  bindEvents();
  renderWizard();
  refreshBackendHealth();
  loadJsonFromUrl();
})();
