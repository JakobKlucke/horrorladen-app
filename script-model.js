(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.ScriptModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const CANONICAL_VERSION = 2;
  const LEARNABLE_KINDS = new Set(['dialogue', 'lyric']);
  const STRUCTURAL_CHILD_KEYS = ['segments', 'children', 'parts', 'items'];
  const RESOLVED_ISSUE_STATUSES = new Set(['accepted', 'apply', 'approved', 'done', 'yes', 'true', '1', 'resolved']);
  const NON_PENDING_ISSUE_STATUSES = new Set(['rejected', 'skip', 'skipped', 'info']);

  function asArray(value){
    return Array.isArray(value) ? value : [];
  }

  function isObject(value){
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function firstString(values){
    for(const value of values){
      if(typeof value === 'string' && value.trim()) return value.trim();
      if(typeof value === 'number') return String(value);
    }
    return '';
  }

  function normalizeWhitespace(value){
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u00ad/g, '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeStringList(value){
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    const seen = new Set();
    const out = [];
    values.forEach(item => {
      const clean = normalizeWhitespace(item);
      const key = clean.toUpperCase();
      if(!clean || seen.has(key)) return;
      seen.add(key);
      out.push(clean);
    });
    return out;
  }

  function lowerType(value){
    return String((value && value.type) || '').trim().toLowerCase();
  }

  function slugify(value){
    const input = normalizeWhitespace(value).toLowerCase();
    const base = input
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || 'item';
  }

  function stableEntryId(index){
    return `entry-${String(index + 1).padStart(5, '0')}`;
  }

  function normalizeKind(value){
    const kind = String(value || '').trim().toLowerCase();
    if(kind === 'line') return 'dialogue';
    if(kind === 'dialogue') return 'dialogue';
    if(kind === 'lyric') return 'lyric';
    if(kind === 'stage_direction') return 'stage_direction';
    if(kind === 'narration') return 'narration';
    return '';
  }

  function isLearnableKind(kind){
    return LEARNABLE_KINDS.has(kind);
  }

  function formatSongLabel(songLike){
    const number = firstString([
      songLike && songLike.songNumber,
      songLike && songLike.number
    ]);
    const title = firstString([
      songLike && songLike.songTitle,
      songLike && songLike.title,
      songLike && songLike.songLabel,
      songLike && songLike.label
    ]);
    if(number && title) return `${number} - ${title}`;
    return number || title || '';
  }

  function extractSongParts(value){
    if(!value) return { songId:'', songNumber:'', songTitle:'', songLabel:'' };
    if(typeof value === 'string'){
      return { songId:'', songNumber:'', songTitle:value.trim(), songLabel:value.trim() };
    }
    if(typeof value === 'number'){
      const asString = String(value);
      return { songId:'', songNumber:asString, songTitle:'', songLabel:asString };
    }
    const songId = firstString([value.songId, value.id]);
    const songNumber = firstString([value.songNumber, value.number, value.nr, value.no]);
    const songTitle = firstString([value.songTitle, value.title, value.name]);
    const songLabel = firstString([value.songLabel, value.label, formatSongLabel({ songNumber, songTitle })]);
    return { songId, songNumber, songTitle, songLabel };
  }

  function extractLabelParts(prefix, value){
    if(!value) return { [`${prefix}Id`]:'', [`${prefix}Label`]:'' };
    if(typeof value === 'string'){
      return { [`${prefix}Id`]:'', [`${prefix}Label`]:value.trim() };
    }
    if(typeof value === 'number'){
      const asString = String(value);
      return { [`${prefix}Id`]:'', [`${prefix}Label`]:asString };
    }
    return {
      [`${prefix}Id`]: firstString([value[`${prefix}Id`], value.id]),
      [`${prefix}Label`]: firstString([value[`${prefix}Label`], value.label, value.title, value.name, value.id])
    };
  }

  function makeIdFactory(prefix){
    const counters = new Map();
    return function(seed){
      const slug = slugify(seed || prefix);
      const base = `${prefix}-${slug}`;
      const count = (counters.get(base) || 0) + 1;
      counters.set(base, count);
      return count === 1 ? base : `${base}-${count}`;
    };
  }

  function createCatalogBuilder(){
    const roleIdFactory = makeIdFactory('role');
    const actIdFactory = makeIdFactory('act');
    const sceneIdFactory = makeIdFactory('scene');
    const songIdFactory = makeIdFactory('song');

    const roles = [];
    const acts = [];
    const scenes = [];
    const songs = [];

    const rolesById = new Map();
    const rolesByLabel = new Map();
    const actsById = new Map();
    const actsByLabel = new Map();
    const scenesById = new Map();
    const scenesByKey = new Map();
    const songsById = new Map();
    const songsByKey = new Map();

    function ensureRole(roleId, label){
      const cleanLabel = firstString([label]);
      const requestedId = firstString([roleId]);
      if(requestedId && rolesById.has(requestedId)) return rolesById.get(requestedId);
      if(cleanLabel){
        const byLabel = rolesByLabel.get(cleanLabel.toUpperCase());
        if(byLabel){
          if(requestedId && !byLabel.id) byLabel.id = requestedId;
          if(requestedId) rolesById.set(requestedId, byLabel);
          return byLabel;
        }
      }
      if(!cleanLabel && !requestedId) return { id:'', label:'' };
      const item = {
        id: requestedId || roleIdFactory(cleanLabel || 'role'),
        label: cleanLabel || requestedId,
        aliases: []
      };
      roles.push(item);
      rolesById.set(item.id, item);
      rolesByLabel.set(item.label.toUpperCase(), item);
      return item;
    }

    function ensureAct(actId, label){
      const cleanLabel = firstString([label]);
      const requestedId = firstString([actId]);
      if(requestedId && actsById.has(requestedId)) return actsById.get(requestedId);
      if(cleanLabel){
        const byLabel = actsByLabel.get(cleanLabel.toUpperCase());
        if(byLabel){
          if(requestedId) actsById.set(requestedId, byLabel);
          return byLabel;
        }
      }
      if(!cleanLabel && !requestedId) return { id:'', label:'' };
      const item = {
        id: requestedId || actIdFactory(cleanLabel || 'act'),
        label: cleanLabel || requestedId
      };
      acts.push(item);
      actsById.set(item.id, item);
      actsByLabel.set(item.label.toUpperCase(), item);
      return item;
    }

    function ensureScene(sceneId, label, actRef){
      const cleanLabel = firstString([label]);
      const requestedId = firstString([sceneId]);
      if(requestedId && scenesById.has(requestedId)) return scenesById.get(requestedId);
      const actId = firstString([actRef && actRef.id]);
      const key = `${actId}::${cleanLabel.toUpperCase()}`;
      if(cleanLabel && scenesByKey.has(key)){
        const existing = scenesByKey.get(key);
        if(requestedId) scenesById.set(requestedId, existing);
        return existing;
      }
      if(!cleanLabel && !requestedId) return { id:'', label:'', actId };
      const item = {
        id: requestedId || sceneIdFactory(`${actId || 'global'}-${cleanLabel || 'scene'}`),
        label: cleanLabel || requestedId,
        actId
      };
      scenes.push(item);
      scenesById.set(item.id, item);
      if(cleanLabel) scenesByKey.set(key, item);
      return item;
    }

    function ensureSong(parts, actRef, sceneRef){
      const requestedId = firstString([parts.songId]);
      if(requestedId && songsById.has(requestedId)) return songsById.get(requestedId);
      const songNumber = firstString([parts.songNumber]);
      const songTitle = firstString([parts.songTitle]);
      const songLabel = firstString([parts.songLabel, formatSongLabel({ songNumber, songTitle })]);
      const actId = firstString([actRef && actRef.id]);
      const sceneId = firstString([sceneRef && sceneRef.id]);
      const key = `${sceneId || actId || 'global'}::${songNumber}::${songTitle || songLabel}`;
      if((songNumber || songTitle || songLabel) && songsByKey.has(key)){
        const existing = songsByKey.get(key);
        if(requestedId) songsById.set(requestedId, existing);
        return existing;
      }
      if(!requestedId && !songNumber && !songTitle && !songLabel){
        return { id:'', label:'', number:'', title:'', actId, sceneId };
      }
      const item = {
        id: requestedId || songIdFactory(`${sceneId || actId || 'global'}-${songNumber || songTitle || songLabel || 'song'}`),
        number: songNumber,
        title: songTitle || songLabel,
        label: songLabel || songTitle || requestedId,
        actId,
        sceneId
      };
      songs.push(item);
      songsById.set(item.id, item);
      songsByKey.set(key, item);
      return item;
    }

    function ensureRefs(raw){
      const roleRef = ensureRole(raw.speakerId, raw.speaker);
      const actRef = ensureAct(raw.actId, raw.actLabel);
      const sceneRef = ensureScene(raw.sceneId, raw.sceneLabel, actRef);
      const songRef = ensureSong({
        songId: raw.songId,
        songNumber: raw.songNumber,
        songTitle: raw.songTitle,
        songLabel: raw.songLabel
      }, actRef, sceneRef);
      return {
        speakerId: roleRef.id || '',
        speaker: roleRef.label || '',
        actId: actRef.id || '',
        actLabel: actRef.label || '',
        sceneId: sceneRef.id || '',
        sceneLabel: sceneRef.label || '',
        songId: songRef.id || '',
        songNumber: songRef.number || '',
        songTitle: songRef.title || '',
        songLabel: songRef.label || ''
      };
    }

    function snapshot(){
      return {
        roles: roles.map(item => ({ id:item.id, label:item.label, aliases:normalizeStringList(item.aliases) })),
        acts: acts.map(item => ({ id:item.id, label:item.label })),
        scenes: scenes.map(item => ({ id:item.id, label:item.label, actId:item.actId || '' })),
        songs: songs.map(item => ({
          id:item.id,
          label:item.label,
          number:item.number || '',
          title:item.title || '',
          actId:item.actId || '',
          sceneId:item.sceneId || '',
          singerIds: normalizeStringList(item.singerIds)
        }))
      };
    }

    return {
      ensureRefs,
      snapshot
    };
  }

  function buildActsTree(acts, scenes, songs){
    const scenesByAct = new Map();
    acts.forEach(act => scenesByAct.set(act.id, []));
    const sceneNodes = new Map();
    scenes.forEach(scene => {
      const node = { id:scene.id, label:scene.label, actId:scene.actId || '', songs:[] };
      sceneNodes.set(scene.id, node);
      if(scene.actId && scenesByAct.has(scene.actId)) scenesByAct.get(scene.actId).push(node);
    });
    songs.forEach(song => {
      if(song.sceneId && sceneNodes.has(song.sceneId)){
        sceneNodes.get(song.sceneId).songs.push({
          id:song.id,
          label:song.label,
          number:song.number || '',
          title:song.title || '',
          singerIds: normalizeStringList(song.singerIds)
        });
      }
    });
    return acts.map(act => ({
      id: act.id,
      label: act.label,
      scenes: scenesByAct.get(act.id) || []
    }));
  }

  function normalizeCanonicalScript(data){
    const builder = createCatalogBuilder();
    const entries = [];
    const seenEntryIds = new Set();
    asArray(data && data.entries).forEach((entry, index) => {
      if(!isObject(entry)) return;
      const kind = normalizeKind(entry.kind || entry.type);
      const text = normalizeWhitespace(entry.text || '');
      if(!kind || !text) return;

      const actParts = extractLabelParts('act', entry.act || { id:entry.actId, label:entry.actLabel });
      const sceneParts = extractLabelParts('scene', entry.scene || { id:entry.sceneId, label:entry.sceneLabel });
      const songParts = extractSongParts(entry.song || {
        songId: entry.songId,
        songNumber: entry.songNumber,
        songTitle: entry.songTitle,
        songLabel: entry.songLabel
      });
      const refs = builder.ensureRefs({
        speakerId: firstString([entry.speakerId]),
        speaker: firstString([entry.speaker, entry.speakerLabel, entry.role]),
        actId: actParts.actId,
        actLabel: actParts.actLabel,
        sceneId: sceneParts.sceneId,
        sceneLabel: sceneParts.sceneLabel,
        songId: songParts.songId,
        songNumber: songParts.songNumber,
        songTitle: songParts.songTitle,
        songLabel: songParts.songLabel
      });
      let entryId = firstString([entry.id]);
      if(!entryId || seenEntryIds.has(entryId)) entryId = stableEntryId(index);
      seenEntryIds.add(entryId);

      entries.push({
        id: entryId,
        order: Number.isFinite(entry.order) ? Number(entry.order) : index + 1,
        kind,
        text,
        cut: !!entry.cut,
        page: Number.isFinite(entry.page) ? Number(entry.page) : null,
        speakerId: refs.speakerId || '',
        speaker: refs.speaker || '',
        actId: refs.actId || '',
        actLabel: refs.actLabel || '',
        sceneId: refs.sceneId || '',
        sceneLabel: refs.sceneLabel || '',
        songId: refs.songId || '',
        songNumber: refs.songNumber || '',
        songTitle: refs.songTitle || '',
        songLabel: refs.songLabel || '',
        contextBefore: normalizeWhitespace(entry.contextBefore || entry.context_before || ''),
        source: isObject(entry.source) ? entry.source : null
      });
    });

    entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const snapshot = mergeCatalogMetadata(builder.snapshot(), data);
    return {
      schemaVersion: CANONICAL_VERSION,
      title: firstString([data && data.title, data && data.name, 'Unbenanntes Skript']),
      sourceFormat: firstString([data && data.sourceFormat, 'canonical']),
      sourceFile: firstString([data && data.sourceFile]),
      pages: asArray(data && data.pages).map(page => Object.assign({}, page)),
      entries,
      roles: snapshot.roles,
      acts: buildActsTree(snapshot.acts, snapshot.scenes, snapshot.songs),
      scenes: snapshot.scenes,
      songs: snapshot.songs,
      issues: asArray(data && data.issues).map(issue => Object.assign({}, issue))
    };
  }

  function mergeCatalogMetadata(snapshot, data){
    const sourceRoles = asArray(data && data.roles);
    const sourceSongs = asArray(data && data.songs);
    const rolesById = new Map(snapshot.roles.map(role => [role.id, role]));
    const rolesByLabel = new Map(snapshot.roles.map(role => [String(role.label || '').toUpperCase(), role]));
    sourceRoles.forEach(raw => {
      if(!isObject(raw)) return;
      const id = firstString([raw.id, raw.roleId]);
      const label = firstString([raw.label, raw.name, raw.speaker]);
      const aliases = normalizeStringList(raw.aliases);
      let role = (id && rolesById.get(id)) || (label && rolesByLabel.get(label.toUpperCase()));
      if(!role && (id || label)){
        role = { id:id || `role-${slugify(label)}`, label:label || id, aliases:[] };
        snapshot.roles.push(role);
      }
      if(!role) return;
      if(id) role.id = id;
      if(label) role.label = label;
      role.aliases = normalizeStringList([...(role.aliases || []), ...aliases]);
      rolesById.set(role.id, role);
      rolesByLabel.set(String(role.label || '').toUpperCase(), role);
    });

    const songsById = new Map(snapshot.songs.map(song => [song.id, song]));
    const songsByKey = new Map(snapshot.songs.map(song => [`${song.number || ''}::${song.title || song.label || ''}`.toUpperCase(), song]));
    sourceSongs.forEach(raw => {
      if(!isObject(raw)) return;
      const id = firstString([raw.id, raw.songId]);
      const number = firstString([raw.number, raw.songNumber]);
      const title = firstString([raw.title, raw.songTitle, raw.name]);
      const label = firstString([raw.label, raw.songLabel, formatSongLabel({ songNumber:number, songTitle:title })]);
      const key = `${number || ''}::${title || label || ''}`.toUpperCase();
      let song = (id && songsById.get(id)) || (key && songsByKey.get(key));
      if(!song && (id || number || title || label)){
        song = {
          id:id || `song-${slugify(number || title || label)}`,
          label:label || title || id,
          number,
          title:title || label,
          actId:firstString([raw.actId]),
          sceneId:firstString([raw.sceneId]),
          singerIds:[]
        };
        snapshot.songs.push(song);
      }
      if(!song) return;
      if(id) song.id = id;
      if(number) song.number = number;
      if(title) song.title = title;
      if(label) song.label = label;
      if(firstString([raw.actId])) song.actId = firstString([raw.actId]);
      if(firstString([raw.sceneId])) song.sceneId = firstString([raw.sceneId]);
      song.singerIds = normalizeStringList(raw.singerIds);
      songsById.set(song.id, song);
      songsByKey.set(`${song.number || ''}::${song.title || song.label || ''}`.toUpperCase(), song);
    });
    return snapshot;
  }

  function normalizeLegacyScript(data){
    const builder = createCatalogBuilder();
    const entries = [];
    let nextOrder = 1;

    function pushEntry(raw, kind, text, ctx, speaker){
      const cleanText = normalizeWhitespace(text);
      const normalizedKind = normalizeKind(kind);
      if(!cleanText || !normalizedKind) return;
      const refs = builder.ensureRefs({
        speakerId: '',
        speaker: firstString([speaker]),
        actId: firstString([ctx.actId]),
        actLabel: firstString([ctx.actLabel]),
        sceneId: firstString([ctx.sceneId]),
        sceneLabel: firstString([ctx.sceneLabel]),
        songId: firstString([ctx.songId]),
        songNumber: firstString([ctx.songNumber]),
        songTitle: firstString([ctx.songTitle]),
        songLabel: firstString([ctx.songLabel])
      });
      entries.push({
        id: stableEntryId(nextOrder - 1),
        order: nextOrder,
        kind: normalizedKind,
        text: cleanText,
        cut: !!raw.cut,
        page: Number.isFinite(raw.page) ? Number(raw.page) : null,
        speakerId: refs.speakerId || '',
        speaker: refs.speaker || '',
        actId: refs.actId || '',
        actLabel: refs.actLabel || '',
        sceneId: refs.sceneId || '',
        sceneLabel: refs.sceneLabel || '',
        songId: refs.songId || '',
        songNumber: refs.songNumber || '',
        songTitle: refs.songTitle || '',
        songLabel: refs.songLabel || '',
        contextBefore: normalizeWhitespace(raw.context_before || raw.contextBefore || ctx.contextBefore || ''),
        source: null
      });
      nextOrder += 1;
    }

    function nextContext(current, node){
      const out = Object.assign({}, current);
      const actParts = extractLabelParts('act', Object.prototype.hasOwnProperty.call(node, 'act') ? node.act : null);
      const sceneParts = extractLabelParts('scene', Object.prototype.hasOwnProperty.call(node, 'scene') ? node.scene : null);
      const songParts = extractSongParts(Object.prototype.hasOwnProperty.call(node, 'song') ? node.song : null);
      if(actParts.actId || actParts.actLabel){
        out.actId = actParts.actId;
        out.actLabel = actParts.actLabel;
      }
      if(sceneParts.sceneId || sceneParts.sceneLabel){
        out.sceneId = sceneParts.sceneId;
        out.sceneLabel = sceneParts.sceneLabel;
      }
      if(songParts.songId || songParts.songNumber || songParts.songTitle || songParts.songLabel){
        out.songId = songParts.songId;
        out.songNumber = songParts.songNumber;
        out.songTitle = songParts.songTitle;
        out.songLabel = songParts.songLabel || formatSongLabel(songParts);
      }
      const contextBefore = normalizeWhitespace(node.context_before || node.contextBefore || '');
      if(contextBefore) out.contextBefore = contextBefore;
      return out;
    }

    function walk(node, ctx){
      if(node == null) return;
      if(Array.isArray(node)){
        node.forEach(child => walk(child, ctx));
        return;
      }
      if(!isObject(node)) return;

      const kind = lowerType(node);
      const scopedCtx = nextContext(ctx, node);

      if(kind === 'speaker_block'){
        const speaker = firstString([node.speaker, node.speakerLabel, node.role]);
        const content = asArray(node.content);
        if(content.length){
          content.forEach(item => {
            const itemKind = normalizeKind(item && item.type) || (speaker ? 'dialogue' : 'narration');
            pushEntry(Object.assign({}, node, item), itemKind, item && item.text, scopedCtx, speaker || item.speaker);
          });
        }else if(node.text){
          pushEntry(node, speaker && scopedCtx.songId ? 'lyric' : 'dialogue', node.text, scopedCtx, speaker);
        }
      }else if(kind === 'stage_direction' || kind === 'narration'){
        const content = asArray(node.content);
        if(content.length){
          content.forEach(item => pushEntry(Object.assign({}, node, item), normalizeKind(item && item.type) || kind, item && item.text, scopedCtx, item && item.speaker));
        }else if(node.text){
          pushEntry(node, kind, node.text, scopedCtx, node.speaker);
        }
      }else{
        const directKind = normalizeKind(kind);
        if(directKind && node.text){
          pushEntry(node, directKind, node.text, scopedCtx, node.speaker);
        }
      }

      STRUCTURAL_CHILD_KEYS.forEach(key => {
        asArray(node[key]).forEach(child => walk(child, scopedCtx));
      });
    }

    if(Array.isArray(data)) walk({ segments:data }, {});
    else walk(data || {}, {});

    const snapshot = builder.snapshot();
    return {
      schemaVersion: CANONICAL_VERSION,
      title: firstString([data && data.title, data && data.name, 'Unbenanntes Skript']),
      sourceFormat: 'legacy',
      sourceFile: firstString([data && data.sourceFile]),
      pages: asArray(data && data.pages).map(page => Object.assign({}, page)),
      entries,
      roles: snapshot.roles,
      acts: buildActsTree(snapshot.acts, snapshot.scenes, snapshot.songs),
      scenes: snapshot.scenes,
      songs: snapshot.songs,
      issues: []
    };
  }

  function isCanonicalScript(data){
    return !!(data && typeof data === 'object' && Array.isArray(data.entries));
  }

  function normalizeScriptData(data){
    return isCanonicalScript(data) ? normalizeCanonicalScript(data) : normalizeLegacyScript(data);
  }

  function buildRuntimeModel(data){
    const canonical = isCanonicalScript(data) && Number(data.schemaVersion) === CANONICAL_VERSION
      ? normalizeCanonicalScript(data)
      : normalizeScriptData(data);

    const entries = canonical.entries.slice();
    const roles = canonical.roles.slice();
    const acts = canonical.acts.map(act => ({
      id: act.id,
      label: act.label,
      scenes: asArray(act.scenes).map(scene => ({
        id: scene.id,
        label: scene.label,
        actId: scene.actId || '',
        songs: asArray(scene.songs).map(song => ({
          id: song.id,
          label: song.label,
          number: song.number || '',
          title: song.title || '',
          singerIds: normalizeStringList(song.singerIds)
        }))
      }))
    }));
    const scenes = canonical.scenes.slice();
    const songs = canonical.songs.slice();

    const learnableEntries = entries
      .filter(entry => isLearnableKind(entry.kind) && !entry.cut)
      .map(entry => ({
        id: entry.id,
        order: entry.order,
        speaker: entry.speaker || '',
        speakerId: entry.speakerId || '',
        text: entry.text,
        kind: entry.kind === 'dialogue' ? 'line' : 'lyric',
        meta: {
          actId: entry.actId || '',
          actLabel: entry.actLabel || '',
          sceneId: entry.sceneId || '',
          sceneLabel: entry.sceneLabel || '',
          songId: entry.songId || '',
          songNumber: entry.songNumber || '',
          songTitle: entry.songTitle || '',
          songLabel: entry.songLabel || ''
        }
      }));

    return {
      canonical,
      entries,
      roles,
      acts,
      scenes,
      songs,
      learnableEntries,
      issues: canonical.issues.slice()
    };
  }

  function getScenesForAct(runtime, actId){
    if(!runtime || !Array.isArray(runtime.scenes)) return [];
    if(!actId) return runtime.scenes.slice();
    return runtime.scenes.filter(scene => scene.actId === actId);
  }

  function getSongsForFilters(runtime, filters){
    if(!runtime || !Array.isArray(runtime.songs)) return [];
    const actId = firstString([filters && filters.actId]);
    const sceneId = firstString([filters && filters.sceneId]);
    return runtime.songs.filter(song => {
      if(actId && song.actId !== actId) return false;
      if(sceneId && song.sceneId !== sceneId) return false;
      return true;
    });
  }

  function filterLearnableEntries(entries, options){
    const role = firstString([options && options.role]);
    const actId = firstString([options && options.actId]);
    const sceneId = firstString([options && options.sceneId]);
    const songId = firstString([options && options.songId]);
    const lyricsOnly = !!(options && options.lyricsOnly);
    const normalizeSpeaker = (options && options.normalizeSpeaker) || (value => firstString([value]).toUpperCase());

    return asArray(entries).filter(entry => {
      if(role){
        const entrySpeaker = normalizeSpeaker(entry && entry.speaker);
        if(!entrySpeaker) return false;
        if(entrySpeaker !== 'ALLE' && entrySpeaker !== normalizeSpeaker(role)) return false;
      }
      if(actId && firstString([entry && entry.meta && entry.meta.actId]) !== actId) return false;
      if(sceneId && firstString([entry && entry.meta && entry.meta.sceneId]) !== sceneId) return false;
      if(songId && firstString([entry && entry.meta && entry.meta.songId]) !== songId) return false;
      if(lyricsOnly && entry.kind !== 'lyric') return false;
      return true;
    });
  }

  function findEntryIndex(sequence, entryId){
    return asArray(sequence).findIndex(entry => entry && entry.id === entryId);
  }

  function sameLyricBlock(a, b){
    if(!a || !b) return false;
    if(a.kind !== 'lyric' || b.kind !== 'lyric') return false;
    return firstString([a.meta && a.meta.songId]) === firstString([b.meta && b.meta.songId]) &&
      firstString([a.meta && a.meta.sceneId]) === firstString([b.meta && b.meta.sceneId]) &&
      firstString([a.meta && a.meta.actId]) === firstString([b.meta && b.meta.actId]);
  }

  function getContextForEntry(sequence, entryId, options){
    const items = asArray(sequence);
    const index = findEntryIndex(items, entryId);
    if(index < 0) return { prev:null, next:null, index:-1 };

    const role = firstString([options && options.role]);
    const onlySameSong = !!(options && options.onlySameSong);
    const normalizeSpeaker = (options && options.normalizeSpeaker) || (value => firstString([value]).toUpperCase());
    const roleKey = normalizeSpeaker(role);
    const current = items[index];

    let prev = null;
    for(let i = index - 1; i >= 0; i -= 1){
      const candidate = items[i];
      if(roleKey && normalizeSpeaker(candidate.speaker) === roleKey) continue;
      if(onlySameSong && firstString([candidate.meta && candidate.meta.songId]) !== firstString([current.meta && current.meta.songId])) continue;
      prev = candidate;
      break;
    }

    let next = null;
    for(let i = index + 1; i < items.length; i += 1){
      const candidate = items[i];
      if(roleKey && normalizeSpeaker(candidate.speaker) === roleKey) continue;
      if(onlySameSong && firstString([candidate.meta && candidate.meta.songId]) !== firstString([current.meta && current.meta.songId])) continue;
      next = candidate;
      break;
    }

    return { prev, next, index };
  }

  function getLyricBlockContext(sequence, entryId){
    const items = asArray(sequence);
    const index = findEntryIndex(items, entryId);
    if(index < 0) return { index:-1, startIndex:-1, endIndex:-1, prev:null, next:null };

    let startIndex = index;
    while(startIndex > 0 && sameLyricBlock(items[startIndex - 1], items[index])) startIndex -= 1;

    let endIndex = index;
    while(endIndex + 1 < items.length && sameLyricBlock(items[endIndex + 1], items[index])) endIndex += 1;

    return {
      index,
      startIndex,
      endIndex,
      prev: items[startIndex - 1] || null,
      next: items[endIndex + 1] || null
    };
  }

  function normalizeIssueStatus(value){
    return firstString([value]).toLowerCase();
  }

  function isPendingIssue(issue){
    const status = normalizeIssueStatus(issue && issue.status);
    if(!status) return true;
    if(RESOLVED_ISSUE_STATUSES.has(status)) return false;
    if(NON_PENDING_ISSUE_STATUSES.has(status)) return false;
    return true;
  }

  function countPendingIssues(issues){
    return asArray(issues).filter(isPendingIssue).length;
  }

  function parseBoolean(value){
    const normalized = firstString([value]).toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'ja' || normalized === 'y' || normalized === 'cut';
  }

  function cloneJson(value){
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function applyCutToEntryIds(entries, entryIds, cut){
    const ids = new Set(asArray(entryIds).map(id => firstString([id])).filter(Boolean));
    return asArray(entries).map(entry => {
      if(!isObject(entry)) return entry;
      const next = Object.assign({}, entry);
      if(ids.has(firstString([entry.id]))) next.cut = !!cut;
      return next;
    });
  }

  function splitEntryForCut(entry, startOffset, endOffset){
    if(!isObject(entry)) return [];
    const text = normalizeWhitespace(entry.text || '');
    const start = Math.max(0, Math.min(Number(startOffset) || 0, text.length));
    const end = Math.max(start, Math.min(Number(endOffset) || 0, text.length));
    if(start === end) return [Object.assign({}, entry)];

    const baseId = firstString([entry.id]) || 'entry';
    const baseOrder = Number.isFinite(entry.order) ? Number(entry.order) : 0;
    const source = cloneJson(entry.source);
    const chunks = [
      { suffix:'', text:text.slice(0, start), cut:false },
      { suffix:'cut-1', text:text.slice(start, end), cut:true },
      { suffix:'after-1', text:text.slice(end), cut:false }
    ].filter(chunk => normalizeWhitespace(chunk.text));

    return chunks.map((chunk, index) => {
      const next = Object.assign({}, entry);
      next.id = chunk.suffix ? `${baseId}-${chunk.suffix}` : baseId;
      next.order = baseOrder + (index * 0.001);
      next.text = normalizeWhitespace(chunk.text);
      next.cut = chunk.cut;
      next.source = cloneJson(source);
      return next;
    });
  }

  function applyReviewRows(data, rows){
    const base = isCanonicalScript(data) ? normalizeCanonicalScript(data) : normalizeScriptData(data);
    const nextEntries = base.entries.map(entry => Object.assign({}, entry));
    const entryIndex = new Map(nextEntries.map((entry, index) => [entry.id, index]));
    const nextRows = asArray(rows).map(row => Object.assign({}, row));

    nextRows.forEach(row => {
      if(!RESOLVED_ISSUE_STATUSES.has(normalizeIssueStatus(row.status))) return;
      const startId = firstString([row.start_entry_id, row.startEntryId]);
      const endId = firstString([row.end_entry_id, row.endEntryId, startId]);
      const field = firstString([row.field]);
      if(!startId || !endId || !field || !entryIndex.has(startId) || !entryIndex.has(endId)) return;

      const startIndex = entryIndex.get(startId);
      const endIndex = entryIndex.get(endId);
      const rangeStart = Math.min(startIndex, endIndex);
      const rangeEnd = Math.max(startIndex, endIndex);
      for(let i = rangeStart; i <= rangeEnd; i += 1){
        const entry = nextEntries[i];
        const value = row.value;
        if(field === 'speaker'){
          entry.speaker = firstString([value]);
          entry.speakerId = '';
        }else if(field === 'kind'){
          const kind = normalizeKind(value);
          if(kind) entry.kind = kind;
        }else if(field === 'cut'){
          entry.cut = parseBoolean(value);
        }else if(field === 'actId' || field === 'actLabel' || field === 'sceneId' || field === 'sceneLabel' || field === 'songId' || field === 'songNumber' || field === 'songTitle' || field === 'songLabel'){
          entry[field] = firstString([value]);
        }
      }
    });

    return normalizeCanonicalScript({
      schemaVersion: CANONICAL_VERSION,
      title: base.title,
      sourceFormat: base.sourceFormat || 'canonical',
      sourceFile: base.sourceFile || '',
      pages: asArray(base.pages).map(page => Object.assign({}, page)),
      roles: base.roles,
      songs: base.songs,
      entries: nextEntries,
      issues: nextRows
    });
  }

  return {
    CANONICAL_VERSION,
    formatSongLabel,
    isCanonicalScript,
    isLearnableKind,
    normalizeScriptData,
    buildRuntimeModel,
    getScenesForAct,
    getSongsForFilters,
    filterLearnableEntries,
    getContextForEntry,
    getLyricBlockContext,
    sameLyricBlock,
    normalizeIssueStatus,
    normalizeStringList,
    isPendingIssue,
    countPendingIssues,
    applyCutToEntryIds,
    splitEntryForCut,
    applyReviewRows
  };
});
