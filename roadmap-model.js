(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.RoadmapModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const SCHEMA_VERSION = 1;
  const MISSION_LABELS = {
    cue_catch: 'Cue Catch',
    line_recall: 'Line Recall',
    scene_run: 'Scene Run',
    cold_start: 'Cold Start',
    speed_run: 'Speed Run',
    boss_scene: 'Boss Scene'
  };

  function asArray(value){
    return Array.isArray(value) ? value : [];
  }

  function clean(value){
    return String(value || '').trim();
  }

  function slugify(value){
    return clean(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  }

  function todayKey(date = new Date()){
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, days){
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next.toISOString();
  }

  function wordCount(text){
    return clean(text).split(/\s+/).filter(Boolean).length;
  }

  function roleKeyFromEntry(entry){
    return clean(entry && entry.speakerId) || `role-${slugify(entry && entry.speaker)}`;
  }

  function roleLabelFromEntry(entry){
    return clean(entry && entry.speaker) || 'Ohne Rolle';
  }

  function metaValue(entry, key){
    return clean((entry && entry[key]) || (entry && entry.meta && entry.meta[key]));
  }

  function difficultyFor(lines, words){
    if(lines >= 28 || words >= 220) return 'hard';
    if(lines >= 10 || words >= 80) return 'medium';
    return 'easy';
  }

  function rewardFor(difficulty, missionType){
    if(missionType === 'boss_scene') return 200;
    if(difficulty === 'hard') return 120;
    if(difficulty === 'medium') return 80;
    return 40;
  }

  function minutesFor(lines, difficulty, missionType){
    const base = missionType === 'boss_scene' ? 8 : 4;
    const lineFactor = Math.ceil(Math.max(1, lines) / (difficulty === 'hard' ? 4 : 6));
    return Math.max(4, Math.min(20, base + lineFactor));
  }

  function successCriteriaFor(missionType){
    if(missionType === 'boss_scene'){
      return { minAccuracy:0.9, maxHints:1, requiredStars:1 };
    }
    if(missionType === 'speed_run'){
      return { minAccuracy:0.85, maxHints:0, requiredStars:1 };
    }
    return { minAccuracy:0.8, maxHints:2, requiredStars:1 };
  }

  function createMission({ roleId, chapterId, type, title, goal, entries, sceneId, songId, difficulty, unlockAfter = [] }){
    const entryIds = entries.map(entry => entry.id).filter(Boolean);
    return {
      id: `mission-${slugify(roleId)}-${slugify(chapterId)}-${slugify(type)}`,
      missionType: type,
      roleId,
      chapterId,
      title,
      goal,
      entryIds,
      sceneId: sceneId || '',
      songId: songId || '',
      difficulty,
      estimatedMinutes: minutesFor(entryIds.length, difficulty, type),
      unlockAfter: unlockAfter.slice(),
      successCriteria: successCriteriaFor(type),
      rewards: {
        xp: rewardFor(difficulty, type),
        badges: type === 'boss_scene' ? ['szene-sitzt'] : []
      }
    };
  }

  function groupEntriesByRole(runtime){
    const roleMap = new Map();
    const rolesById = new Map(asArray(runtime && runtime.roles).map(role => [role.id, role]));
    asArray(runtime && runtime.learnableEntries).forEach(entry => {
      if(!entry || entry.cut) return;
      const roleId = roleKeyFromEntry(entry);
      const label = clean((rolesById.get(roleId) || {}).label) || roleLabelFromEntry(entry);
      if(!roleMap.has(roleId)){
        roleMap.set(roleId, {
          roleId,
          label,
          entries: []
        });
      }
      roleMap.get(roleId).entries.push(entry);
    });
    return Array.from(roleMap.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  function groupEntriesByScene(entries){
    const sceneMap = new Map();
    entries.forEach(entry => {
      const sceneId = metaValue(entry, 'sceneId') || `scene-${slugify(metaValue(entry, 'actLabel'))}-${slugify(metaValue(entry, 'sceneLabel'))}`;
      const key = sceneId || 'scene-global';
      if(!sceneMap.has(key)){
        sceneMap.set(key, {
          sceneId: key,
          sceneLabel: metaValue(entry, 'sceneLabel') || 'Ohne Szene',
          actLabel: metaValue(entry, 'actLabel'),
          songId: metaValue(entry, 'songId'),
          firstOrder: Number(entry.order || 0),
          entries: []
        });
      }
      const item = sceneMap.get(key);
      item.entries.push(entry);
      item.firstOrder = Math.min(item.firstOrder, Number(entry.order || item.firstOrder || 0));
      if(!item.songId && metaValue(entry, 'songId')) item.songId = metaValue(entry, 'songId');
    });
    return Array.from(sceneMap.values()).sort((a, b) => a.firstOrder - b.firstOrder);
  }

  function buildChapter(role, scene, index, unlockAfter){
    const lines = scene.entries.length;
    const words = scene.entries.reduce((sum, entry) => sum + wordCount(entry.text), 0);
    const difficulty = difficultyFor(lines, words);
    const chapterId = `chapter-${slugify(role.roleId)}-${slugify(scene.sceneId || scene.sceneLabel || index + 1)}`;
    const titleParts = [scene.actLabel, scene.sceneLabel].filter(Boolean);
    const title = titleParts.length ? titleParts.join(' - ') : `Abschnitt ${index + 1}`;
    const starterEntries = scene.entries.slice(0, Math.min(8, scene.entries.length));
    const coreEntries = scene.entries.slice(0, Math.min(16, scene.entries.length));
    const missions = [];

    const lineRecall = createMission({
      roleId: role.roleId,
      chapterId,
      type: 'line_recall',
      title: `${title}: Textanker`,
      goal: 'Erinnere die wichtigsten eigenen Zeilen einzeln.',
      entries: starterEntries,
      sceneId: scene.sceneId,
      songId: scene.songId,
      difficulty
    });
    missions.push(lineRecall);

    const cueCatch = createMission({
      roleId: role.roleId,
      chapterId,
      type: 'cue_catch',
      title: `${title}: Stichworte`,
      goal: 'Reagiere auf Vorzeilen und finde deine Einsaetze.',
      entries: starterEntries,
      sceneId: scene.sceneId,
      songId: scene.songId,
      difficulty,
      unlockAfter: [lineRecall.id]
    });
    missions.push(cueCatch);

    const sceneRun = createMission({
      roleId: role.roleId,
      chapterId,
      type: 'scene_run',
      title: `${title}: Durchlauf`,
      goal: 'Spiele deine Zeilen in Szenenreihenfolge durch.',
      entries: coreEntries,
      sceneId: scene.sceneId,
      songId: scene.songId,
      difficulty,
      unlockAfter: [cueCatch.id]
    });
    missions.push(sceneRun);

    if(lines >= 5){
      missions.push(createMission({
        roleId: role.roleId,
        chapterId,
        type: 'cold_start',
        title: `${title}: Kaltstart`,
        goal: 'Starte ohne sichtbaren Kontext und decke Hilfen erst bei Bedarf auf.',
        entries: starterEntries.slice(0, Math.min(6, starterEntries.length)),
        sceneId: scene.sceneId,
        songId: scene.songId,
        difficulty,
        unlockAfter: [lineRecall.id]
      }));
    }

    if(lines >= 8){
      missions.push(createMission({
        roleId: role.roleId,
        chapterId,
        type: 'speed_run',
        title: `${title}: Speed Run`,
        goal: 'Wiederhole sichere Zeilen schnell und ohne Zoegern.',
        entries: starterEntries,
        sceneId: scene.sceneId,
        songId: scene.songId,
        difficulty,
        unlockAfter: [sceneRun.id]
      }));
    }

    if(lines >= 10 || words >= 80){
      missions.push(createMission({
        roleId: role.roleId,
        chapterId,
        type: 'boss_scene',
        title: `${title}: Boss`,
        goal: 'Bestehe den Abschnitt mit Herzen, Quote und moeglichst wenigen Hilfen.',
        entries: scene.entries,
        sceneId: scene.sceneId,
        songId: scene.songId,
        difficulty,
        unlockAfter: [sceneRun.id]
      }));
    }

    return {
      id: chapterId,
      roleId: role.roleId,
      title,
      sceneIds: [scene.sceneId].filter(Boolean),
      position: index + 1,
      difficulty,
      unlockAfter: asArray(unlockAfter),
      requiredMissionIds: missions
        .filter(mission => mission.missionType === 'scene_run' || mission.missionType === 'boss_scene')
        .map(mission => mission.id),
      metrics: { lineCount: lines, wordCount: words },
      missions
    };
  }

  function buildRoleRoadmap(role){
    const scenes = groupEntriesByScene(role.entries);
    let previousUnlockIds = [];
    const chapters = scenes.map((scene, index) => {
      const chapter = buildChapter(role, scene, index, previousUnlockIds);
      previousUnlockIds = chapter.requiredMissionIds.length
        ? chapter.requiredMissionIds.slice()
        : chapter.missions.slice(-1).map(mission => mission.id);
      return chapter;
    });
    const lineCount = role.entries.length;
    const wordTotal = role.entries.reduce((sum, entry) => sum + wordCount(entry.text), 0);
    const difficulty = difficultyFor(lineCount, wordTotal);
    const riskNotes = [];
    if(chapters.length >= 8) riskNotes.push('Viele Szenenwechsel');
    if(lineCount >= 120) riskNotes.push('Hoher Textumfang');
    if(chapters.some(chapter => chapter.difficulty === 'hard')) riskNotes.push('Mindestens ein schwerer Szenenblock');
    if(!riskNotes.length) riskNotes.push('Gut in kurze Missionen aufteilbar');

    return {
      roleId: role.roleId,
      label: role.label,
      profile: {
        lineCount,
        wordCount: wordTotal,
        sceneCount: scenes.length,
        difficulty,
        riskNotes
      },
      chapters
    };
  }

  function buildRoadmap(runtime, options = {}){
    const scriptTitle = clean(runtime && runtime.canonical && runtime.canonical.title) || clean(options.scriptTitle) || 'Skript';
    const scriptId = clean(options.scriptId) || `script-${slugify(scriptTitle)}`;
    const roles = groupEntriesByRole(runtime).map(buildRoleRoadmap).filter(role => role.chapters.length);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: `roadmap-${slugify(scriptId)}-v1`,
      scriptId,
      title: `${scriptTitle} Game Roadmap`,
      generatedAt: new Date().toISOString(),
      source: {
        type: 'deterministic-browser',
        inputEntryCount: asArray(runtime && runtime.learnableEntries).length
      },
      roles
    };
  }

  function flattenMissions(roleRoadmap){
    return asArray(roleRoadmap && roleRoadmap.chapters).flatMap(chapter => asArray(chapter.missions));
  }

  function flattenAllMissions(roadmap){
    return asArray(roadmap && roadmap.roles).flatMap(flattenMissions);
  }

  function getRoleRoadmap(roadmap, roleId){
    return asArray(roadmap && roadmap.roles).find(role => role.roleId === roleId) || null;
  }

  function validateRoadmap(roadmap, runtime){
    const entryIds = new Set(asArray(runtime && runtime.entries).map(entry => entry.id));
    const roleIds = new Set(asArray(runtime && runtime.roles).map(role => role.id));
    asArray(runtime && runtime.learnableEntries).forEach(entry => roleIds.add(roleKeyFromEntry(entry)));
    const sceneIds = new Set(asArray(runtime && runtime.scenes).map(scene => scene.id));
    const songIds = new Set(asArray(runtime && runtime.songs).map(song => song.id).filter(Boolean));
    const errors = [];
    const validRoles = [];

    asArray(roadmap && roadmap.roles).forEach(role => {
      if(!roleIds.has(role.roleId)){
        errors.push(`Unknown roleId: ${role.roleId}`);
        return;
      }
      const nextRole = Object.assign({}, role, { chapters: [] });
      asArray(role.chapters).forEach(chapter => {
        const validSceneIds = asArray(chapter.sceneIds).filter(id => !id || sceneIds.has(id));
        if(asArray(chapter.sceneIds).length && !validSceneIds.length){
          errors.push(`Chapter ${chapter.id} has no valid sceneIds`);
          return;
        }
        const nextChapter = Object.assign({}, chapter, {
          sceneIds: validSceneIds,
          missions: []
        });
        asArray(chapter.missions).forEach(mission => {
          const validEntryIds = asArray(mission.entryIds).filter(id => entryIds.has(id));
          if(!validEntryIds.length){
            errors.push(`Mission ${mission.id} has no valid entryIds`);
            return;
          }
          if(mission.sceneId && !sceneIds.has(mission.sceneId)){
            errors.push(`Mission ${mission.id} has unknown sceneId`);
            return;
          }
          if(mission.songId && songIds.size && !songIds.has(mission.songId)){
            errors.push(`Mission ${mission.id} has unknown songId`);
            return;
          }
          nextChapter.missions.push(Object.assign({}, mission, { entryIds: validEntryIds }));
        });
        if(nextChapter.missions.length) nextRole.chapters.push(nextChapter);
      });
      if(nextRole.chapters.length) validRoles.push(nextRole);
    });

    return {
      ok: errors.length === 0,
      errors,
      roadmap: Object.assign({}, roadmap, { roles: validRoles })
    };
  }

  function completed(progress, id){
    const item = progress && progress.missions && progress.missions[id];
    return !!item && item.status === 'completed' && Number(item.stars || 0) >= 1;
  }

  function isUnlocked(progress, item){
    return asArray(item && item.unlockAfter).every(id => completed(progress, id));
  }

  function computeStars({ accuracy = 1, hintsUsed = 0, attempts = 1 } = {}){
    if(accuracy >= 0.97 && hintsUsed === 0 && attempts >= 2) return 3;
    if(accuracy >= 0.9 && hintsUsed <= 2) return 2;
    if(accuracy >= 0.75) return 1;
    return 0;
  }

  function createDefaultProgress({ profileId = 'local-profile', scriptId = '', roleId = '' } = {}){
    return {
      profileId,
      scriptId,
      roleId,
      xp: 0,
      streakDays: 0,
      lastPracticeDate: '',
      badges: [],
      missions: {}
    };
  }

  function updateStreak(progress, date = new Date()){
    const today = todayKey(date);
    const last = progress.lastPracticeDate;
    if(last === today) return progress.streakDays || 1;
    const yesterday = new Date(date);
    yesterday.setDate(yesterday.getDate() - 1);
    return last === todayKey(yesterday) ? Number(progress.streakDays || 0) + 1 : 1;
  }

  function completeMission(progress, mission, result = {}, date = new Date()){
    const next = Object.assign(createDefaultProgress(progress || {}), progress || {});
    next.missions = Object.assign({}, next.missions || {});
    const previous = next.missions[mission.id] || {};
    const attempts = Number(previous.attempts || 0) + 1;
    const accuracy = Number(result.accuracy == null ? 1 : result.accuracy);
    const hintsUsed = Number(result.hintsUsed || 0);
    const stars = computeStars({ accuracy, hintsUsed, attempts });
    const previousStars = Number(previous.stars || 0);
    const earnedStars = Math.max(previousStars, stars);
    const xp = Number(mission.rewards && mission.rewards.xp || 0);
    const bonus = Math.max(0, earnedStars - previousStars) * Math.round(xp / 3);
    const practicedAt = date.toISOString();

    next.streakDays = updateStreak(next, date);
    next.lastPracticeDate = todayKey(date);
    next.xp = Number(next.xp || 0) + bonus;
    next.missions[mission.id] = {
      status: earnedStars > 0 ? 'completed' : 'in_progress',
      stars: earnedStars,
      bestAccuracy: Math.max(Number(previous.bestAccuracy || 0), accuracy),
      attempts,
      lastPracticedAt: practicedAt,
      nextReviewAt: addDays(date, earnedStars >= 3 ? 7 : earnedStars >= 2 ? 3 : 1),
      hintsUsed: Math.min(Number(previous.hintsUsed == null ? hintsUsed : previous.hintsUsed), hintsUsed)
    };

    const badges = new Set(asArray(next.badges));
    if(mission.missionType === 'cue_catch' && earnedStars >= 2) badges.add('cue-meister');
    if(mission.missionType === 'boss_scene' && earnedStars >= 1) badges.add('szene-sitzt');
    if(earnedStars >= 3) badges.add('text-ohne-netz');
    if(Number(next.streakDays || 0) >= 5) badges.add('streak-5');
    next.badges = Array.from(badges);
    return next;
  }

  function dueMissions(roleRoadmap, progress, date = new Date()){
    const now = date.getTime();
    return flattenMissions(roleRoadmap).filter(mission => {
      const item = progress && progress.missions && progress.missions[mission.id];
      if(!item || item.status !== 'completed') return isUnlocked(progress, mission);
      return item.nextReviewAt && new Date(item.nextReviewAt).getTime() <= now;
    });
  }

  return {
    SCHEMA_VERSION,
    MISSION_LABELS,
    buildRoadmap,
    validateRoadmap,
    getRoleRoadmap,
    flattenMissions,
    flattenAllMissions,
    isUnlocked,
    computeStars,
    createDefaultProgress,
    completeMission,
    dueMissions,
    todayKey
  };
});
