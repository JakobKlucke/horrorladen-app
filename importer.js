(function(){
  'use strict';

  const ScriptModel = window.ScriptModel;
  const state = {
    sourceName: '',
    canonical: null,
    runtime: null,
    reviewRows: [],
    selectedRowIndex: -1,
    backendStatus: null
  };

  const pdfFileInput = document.getElementById('pdfFileInput');
  const pdfTitleInput = document.getElementById('pdfTitleInput');
  const ocrModeSelect = document.getElementById('ocrModeSelect');
  const runPdfImportBtn = document.getElementById('runPdfImportBtn');
  const refreshBackendBtn = document.getElementById('refreshBackendBtn');
  const backendStatus = document.getElementById('backendStatus');
  const jsonFileInput = document.getElementById('jsonFileInput');
  const reviewFileInput = document.getElementById('reviewFileInput');
  const useEmbeddedIssuesBtn = document.getElementById('useEmbeddedIssuesBtn');
  const downloadReviewBtn = document.getElementById('downloadReviewBtn');
  const downloadJsonBtn = document.getElementById('downloadJsonBtn');
  const studioStatus = document.getElementById('studioStatus');
  const summaryTitle = document.getElementById('summaryTitle');
  const summaryEntries = document.getElementById('summaryEntries');
  const summaryLearnable = document.getElementById('summaryLearnable');
  const summaryIssues = document.getElementById('summaryIssues');
  const reviewList = document.getElementById('reviewList');
  const previewTitle = document.getElementById('previewTitle');
  const previewMeta = document.getElementById('previewMeta');
  const previewEntries = document.getElementById('previewEntries');

  function escapeHtml(value){
    return String(value || '').replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[char]));
  }

  function csvNeedsQuotes(value){
    return /[",\n]/.test(String(value || ''));
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

  function defaultReviewFilename(){
    return `${state.sourceName || 'skript'}_review.csv`;
  }

  function defaultJsonFilename(){
    return `${state.sourceName || 'skript'}_final.json`;
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
      if(char === '"'){
        inQuotes = true;
      }else if(char === ','){
        values.push(current);
        current = '';
      }else if(char === '\n'){
        values.push(current.replace(/\r$/, ''));
        rows.push(values.splice(0, values.length));
        current = '';
      }else{
        current += char;
      }
    }
    if(current.length || values.length){
      values.push(current.replace(/\r$/, ''));
      rows.push(values.splice(0, values.length));
    }
    if(!rows.length) return [];
    const headers = rows.shift().map(value => value.trim());
    return rows
      .filter(row => row.some(value => String(value || '').trim()))
      .map(row => {
        const item = {};
        headers.forEach((header, index) => {
          item[header] = row[index] != null ? row[index] : '';
        });
        return item;
      });
  }

  function updateStatus(message,{ok=false}={}){
    if(!studioStatus) return;
    studioStatus.textContent = message;
    studioStatus.classList.toggle('review-note--ok', !!ok);
  }

  function setBackendStatus(message,{ok=false}={}){
    if(!backendStatus) return;
    backendStatus.textContent = message;
    backendStatus.classList.toggle('review-note--ok', !!ok);
  }

  function defaultLaunchCommand(){
    return 'python3 tools/import_studio_server.py';
  }

  function formatBackendStatus(payload){
    const deps = payload?.dependencies || {};
    const pypdfReady = !!deps?.pypdf?.available;
    const ocrReady = !!deps?.ocr?.available;
    const parts = [];
    parts.push(pypdfReady ? 'PDF-Import bereit.' : `pypdf fehlt. Installiere es mit: ${deps?.pypdf?.installHint || 'python3 -m pip install pypdf'}`);
    parts.push(ocrReady ? 'OCR verfügbar.' : 'OCR nicht komplett verfügbar, eingebetteter PDF-Text funktioniert trotzdem.');
    const langs = Array.isArray(deps?.ocr?.languages) && deps.ocr.languages.length ? `Tesseract-Sprachen: ${deps.ocr.languages.join(', ')}` : '';
    if(langs) parts.push(langs);
    return parts.join(' ');
  }

  function ensureReviewRows(){
    if(state.reviewRows.length) return;
    state.reviewRows = Array.isArray(state.runtime?.issues)
      ? state.runtime.issues.map(row => Object.assign({}, row))
      : [];
  }

  function updateSummary(){
    const runtime = state.runtime;
    if(!runtime){
      summaryTitle.textContent = '—';
      summaryEntries.textContent = '0 Einträge';
      summaryLearnable.textContent = '0 lernbar';
      summaryIssues.textContent = '0 Hinweise';
      return;
    }
    const totalIssues = state.reviewRows.length;
    const pendingIssues = ScriptModel.countPendingIssues(state.reviewRows);
    summaryTitle.textContent = runtime.canonical.title || 'Unbenanntes Skript';
    summaryEntries.textContent = `${runtime.entries.length} Einträge`;
    summaryLearnable.textContent = `${runtime.learnableEntries.length} lernbar`;
    summaryIssues.textContent = totalIssues ? `${pendingIssues}/${totalIssues} offen` : '0 Hinweise';
  }

  function issueRangeEntries(row){
    if(!state.runtime) return [];
    const startId = row?.start_entry_id || row?.startEntryId || '';
    const endId = row?.end_entry_id || row?.endEntryId || startId;
    const entries = state.runtime.entries || [];
    if(!startId || !endId) return [];
    const startIndex = entries.findIndex(entry => entry.id === startId);
    const endIndex = entries.findIndex(entry => entry.id === endId);
    if(startIndex < 0 || endIndex < 0) return [];
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    return entries.slice(from, to + 1);
  }

  function renderPreview(){
    if(state.selectedRowIndex < 0 || state.selectedRowIndex >= state.reviewRows.length){
      previewTitle.textContent = 'Keine Auswahl';
      previewMeta.textContent = '—';
      previewEntries.innerHTML = '<div class="faded">Wähle links einen Review-Eintrag.</div>';
      return;
    }

    const row = state.reviewRows[state.selectedRowIndex];
    const entries = issueRangeEntries(row);
    previewTitle.textContent = `${row.issue_id || 'Issue'} · ${row.field || 'Feld'}`;
    previewMeta.textContent = `${row.start_entry_id || '—'} → ${row.end_entry_id || row.start_entry_id || '—'} · Status: ${row.status || 'pending'}`;

    if(!entries.length){
      previewEntries.innerHTML = '<div class="faded">Für diesen Eintrag gibt es keinen direkten Bereichsvorschau.</div>';
      return;
    }

    previewEntries.innerHTML = entries.map(entry => {
      const songLabel = ScriptModel.formatSongLabel({
        songNumber: entry.songNumber,
        songTitle: entry.songTitle,
        label: entry.songLabel
      }) || entry.songLabel || '—';
      return `
        <article class="review-entry-card">
          <div class="review-entry-card__meta">
            <span class="meta-chip">Seite ${entry.page || '—'}</span>
            <span class="meta-chip">${escapeHtml(entry.kind)}</span>
            <span class="meta-chip">${escapeHtml(entry.actLabel || '—')}</span>
            <span class="meta-chip">${escapeHtml(entry.sceneLabel || '—')}</span>
            <span class="meta-chip">${escapeHtml(songLabel)}</span>
          </div>
          <div class="review-entry-card__speaker">${escapeHtml(entry.speaker || 'Ohne Sprecher')}</div>
          <div class="review-entry-card__text">${escapeHtml(entry.text)}</div>
        </article>
      `;
    }).join('');
  }

  function renderReviewList(){
    if(!reviewList) return;
    if(!state.runtime){
      reviewList.innerHTML = '<div class="faded">Noch kein Skript geladen.</div>';
      renderPreview();
      return;
    }
    if(!state.reviewRows.length){
      reviewList.innerHTML = '<div class="faded">Keine Review-Einträge vorhanden. Du kannst direkt das finale JSON herunterladen.</div>';
      state.selectedRowIndex = -1;
      renderPreview();
      return;
    }

    reviewList.innerHTML = state.reviewRows.map((row, index) => {
      const pending = ScriptModel.isPendingIssue(row);
      const active = index === state.selectedRowIndex;
      return `
        <article class="review-item ${active ? 'active' : ''} ${pending ? 'review-item--pending' : 'review-item--done'}" data-row-index="${index}">
          <div class="review-item__top">
            <strong>${escapeHtml(row.issue_id || `Issue ${index + 1}`)}</strong>
            <span class="meta-chip">${escapeHtml(row.field || 'field')}</span>
            <span class="meta-chip">${escapeHtml(row.page || '—')}</span>
          </div>
          <label>Status
            <select data-field="status" data-row-index="${index}">
              ${['pending', 'accepted', 'rejected', 'info'].map(status => `<option value="${status}" ${String(row.status || 'pending') === status ? 'selected' : ''}>${status}</option>`).join('')}
            </select>
          </label>
          <label>Wert
            <input type="text" value="${escapeHtml(row.value || '')}" data-field="value" data-row-index="${index}">
          </label>
          <div class="faded">${escapeHtml(row.reason || '')}</div>
        </article>
      `;
    }).join('');

    reviewList.querySelectorAll('.review-item').forEach(node => {
      node.addEventListener('click', event => {
        if(event.target.closest('input,select')) return;
        state.selectedRowIndex = Number(node.dataset.rowIndex);
        renderReviewList();
      });
    });
    reviewList.querySelectorAll('input[data-row-index], select[data-row-index]').forEach(node => {
      node.addEventListener('input', () => {
        const rowIndex = Number(node.dataset.rowIndex);
        const field = node.dataset.field;
        state.reviewRows[rowIndex][field] = node.value;
        updateSummary();
        renderPreview();
      });
    });

    if(state.selectedRowIndex < 0) state.selectedRowIndex = 0;
    renderPreview();
  }

  function refreshUi(){
    const ready = !!state.runtime;
    useEmbeddedIssuesBtn.disabled = !ready || !(state.runtime?.issues?.length);
    downloadReviewBtn.disabled = !ready;
    downloadJsonBtn.disabled = !ready;
    updateSummary();
    renderReviewList();
  }

  function loadRuntimeFromData(data, sourceName, options = {}){
    const runtime = ScriptModel.buildRuntimeModel(data);
    state.sourceName = sourceName || 'skript';
    state.canonical = runtime.canonical;
    state.runtime = runtime;
    const reviewRows = Array.isArray(options.reviewRows)
      ? options.reviewRows
      : (Array.isArray(runtime.issues) ? runtime.issues : []);
    state.reviewRows = reviewRows.map(row => Object.assign({}, row));
    state.selectedRowIndex = state.reviewRows.length ? 0 : -1;
    refreshUi();
    updateStatus(`Skript geladen: ${runtime.canonical.title || state.sourceName}`, { ok:true });
  }

  async function readFileAsText(file){
    return await file.text();
  }

  async function loadJsonFile(file){
    const text = await readFileAsText(file);
    const data = JSON.parse(text);
    loadRuntimeFromData(data, file.name.replace(/\.json$/i, ''));
  }

  async function loadReviewFile(file){
    const rows = parseCsv(await readFileAsText(file));
    state.reviewRows = rows;
    state.selectedRowIndex = rows.length ? 0 : -1;
    refreshUi();
    updateStatus(`Review geladen: ${file.name}`, { ok:true });
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
      loadRuntimeFromData(data, sourceName);
      updateStatus(`Skript aus Haupt-App geladen: ${sourceName}`, { ok:true });
    }catch(error){
      updateStatus(`Konnte Skript aus URL nicht laden: ${error.message || error}`);
    }
  }

  async function refreshBackendHealth(){
    try{
      const response = await fetch('./api/status', { cache:'no-store' });
      if(!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
      const payload = await response.json();
      state.backendStatus = payload;
      const pypdfReady = !!payload?.dependencies?.pypdf?.available;
      if(runPdfImportBtn) runPdfImportBtn.disabled = !pypdfReady;
      setBackendStatus(formatBackendStatus(payload), { ok:pypdfReady });
      return payload;
    }catch(error){
      state.backendStatus = null;
      if(runPdfImportBtn) runPdfImportBtn.disabled = true;
      setBackendStatus(
        `Kein lokaler Import-Server erreichbar. Starte im Projektordner: ${defaultLaunchCommand()}`,
        { ok:false }
      );
      return null;
    }
  }

  async function runPdfImport(){
    const file = pdfFileInput?.files && pdfFileInput.files[0];
    if(!file){
      setBackendStatus('Bitte zuerst eine PDF-Datei auswählen.');
      return;
    }
    const backend = state.backendStatus || await refreshBackendHealth();
    if(!backend || !backend?.dependencies?.pypdf?.available){
      return;
    }

    const title = (pdfTitleInput?.value || '').trim() || file.name.replace(/\.pdf$/i, '');
    const ocrMode = ocrModeSelect?.value || 'auto';
    const params = new URLSearchParams({
      title,
      ocrMode,
      sourceName: file.name
    });

    const originalLabel = runPdfImportBtn.textContent;
    runPdfImportBtn.disabled = true;
    runPdfImportBtn.textContent = 'Import läuft...';
    setBackendStatus(`Importiere ${file.name} ...`);

    try{
      const response = await fetch(`./api/import?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: file
      });
      const payload = await response.json();
      if(!response.ok || !payload?.ok){
        const errorMessage = payload?.error || response.statusText || 'Unbekannter Fehler';
        const statusMessage = payload?.status ? formatBackendStatus(payload.status) : '';
        throw new Error(statusMessage ? `${errorMessage} ${statusMessage}` : errorMessage);
      }

      loadRuntimeFromData(payload.script, payload.filenameBase || file.name.replace(/\.pdf$/i, ''), {
        reviewRows: Array.isArray(payload.reviewRows) ? payload.reviewRows : []
      });
      setBackendStatus(
        `PDF importiert: ${payload.summary?.pages || 0} Seiten, ${payload.summary?.entries || 0} Einträge, ${payload.summary?.issues || 0} Hinweise.`,
        { ok:true }
      );
    }catch(error){
      setBackendStatus(`PDF-Import fehlgeschlagen: ${error.message || error}`);
    }finally{
      runPdfImportBtn.textContent = originalLabel;
      runPdfImportBtn.disabled = !(state.backendStatus?.dependencies?.pypdf?.available);
    }
  }

  function onUseEmbeddedIssues(){
    ensureReviewRows();
    state.reviewRows = Array.isArray(state.runtime?.issues) ? state.runtime.issues.map(row => Object.assign({}, row)) : [];
    state.selectedRowIndex = state.reviewRows.length ? 0 : -1;
    refreshUi();
    updateStatus('Review-Einträge aus dem JSON übernommen.', { ok:true });
  }

  function onDownloadReview(){
    ensureReviewRows();
    downloadBlob(defaultReviewFilename(), stringifyCsv(state.reviewRows), 'text/csv;charset=utf-8');
  }

  function onDownloadJson(){
    const finalScript = ScriptModel.applyReviewRows(state.canonical, state.reviewRows);
    downloadBlob(defaultJsonFilename(), JSON.stringify(finalScript, null, 2) + '\n', 'application/json;charset=utf-8');
  }

  if(jsonFileInput){
    jsonFileInput.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if(!file) return;
      try{
        await loadJsonFile(file);
      }catch(error){
        updateStatus(`JSON konnte nicht geladen werden: ${error.message || error}`);
      }
    });
  }

  if(pdfFileInput){
    pdfFileInput.addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if(!file || !pdfTitleInput || pdfTitleInput.value.trim()) return;
      pdfTitleInput.value = file.name.replace(/\.pdf$/i, '');
    });
  }

  if(reviewFileInput){
    reviewFileInput.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if(!file) return;
      try{
        await loadReviewFile(file);
      }catch(error){
        updateStatus(`Review-CSV konnte nicht geladen werden: ${error.message || error}`);
      }
    });
  }

  if(useEmbeddedIssuesBtn) useEmbeddedIssuesBtn.addEventListener('click', onUseEmbeddedIssues);
  if(downloadReviewBtn) downloadReviewBtn.addEventListener('click', onDownloadReview);
  if(downloadJsonBtn) downloadJsonBtn.addEventListener('click', onDownloadJson);
  if(runPdfImportBtn) runPdfImportBtn.addEventListener('click', runPdfImport);
  if(refreshBackendBtn) refreshBackendBtn.addEventListener('click', refreshBackendHealth);

  if(!ScriptModel){
    updateStatus('script-model.js fehlt. Das Studio kann ohne dieses Modul nicht starten.');
    return;
  }

  refreshUi();
  refreshBackendHealth();
  loadJsonFromUrl();
})();
