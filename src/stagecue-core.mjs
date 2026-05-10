export const TAB_ITEMS = [
  { id: 'start', label: 'Start' },
  { id: 'journey', label: 'Journey' },
  { id: 'library', label: 'Bibliothek' },
  { id: 'stats', label: 'Statistiken' },
  { id: 'profile', label: 'Profil' }
];

export const LEGACY_MODES = [
  { id: 'classic', label: 'Classic', description: 'Zeilen mit Kontext ueben' },
  { id: 'flash', label: 'Flashcards', description: 'Karteikarten fuer schnelle Wiederholung' },
  { id: 'cloze', label: 'Cloze', description: 'Fehlende Woerter ergaenzen' },
  { id: 'viewer', label: 'Viewer', description: 'Skript chronologisch ansehen' },
  { id: 'survival', label: 'Survival', description: 'Herzsystem und Textsicherheit' }
];

export function clean(value){
  return String(value || '').trim();
}

export function percent(value, max){
  if(!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

export function formatNumber(value){
  return new Intl.NumberFormat('de-DE').format(Number(value || 0));
}

export function stars(count){
  const safe = Math.max(0, Math.min(3, Number(count || 0)));
  return '★'.repeat(safe) + '☆'.repeat(3 - safe);
}

export function flattenMissions(roleRoadmap, RoadmapModel){
  if(!roleRoadmap || !RoadmapModel) return [];
  return RoadmapModel.flattenMissions(roleRoadmap);
}

export function getMissionProgress(progress, missionId){
  return progress?.missions?.[missionId] || null;
}

export function progressSummary(roleRoadmap, progress, RoadmapModel){
  const missions = flattenMissions(roleRoadmap, RoadmapModel);
  const completed = missions.filter(mission => Number(getMissionProgress(progress, mission.id)?.stars || 0) > 0);
  const starCount = missions.reduce((sum, mission) => sum + Number(getMissionProgress(progress, mission.id)?.stars || 0), 0);
  return {
    missions: missions.length,
    completed: completed.length,
    percent: percent(completed.length, missions.length),
    stars: starCount,
    maxStars: missions.length * 3
  };
}

export function firstAvailableMission(roleRoadmap, progress, RoadmapModel){
  const due = RoadmapModel?.dueMissions?.(roleRoadmap, progress) || [];
  if(due.length) return due[0];
  return flattenMissions(roleRoadmap, RoadmapModel).find(mission => RoadmapModel.isUnlocked(progress, mission)) || null;
}

export function sceneProgress(roleRoadmap, progress){
  const chapters = roleRoadmap?.chapters || [];
  return chapters.map(chapter => {
    const missions = chapter.missions || [];
    const completed = missions.filter(mission => Number(progress?.missions?.[mission.id]?.stars || 0) > 0).length;
    return {
      id: chapter.id,
      title: chapter.title,
      completed,
      total: missions.length,
      percent: percent(completed, missions.length)
    };
  });
}

export function badgeLabel(id){
  const labels = {
    'cue-meister': 'Cue-Meister',
    'szene-sitzt': 'Szene sitzt',
    'text-ohne-netz': 'Text ohne Netz',
    'streak-5': 'Streak 5'
  };
  return labels[id] || id;
}

export function estimateAccuracy(progress){
  const values = Object.values(progress?.missions || {})
    .map(item => Number(item.bestAccuracy || 0))
    .filter(Boolean);
  if(!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100);
}

export function nextReviews(roleRoadmap, progress, limit = 3){
  return flattenMissions(roleRoadmap, { flattenMissions: role => role?.chapters?.flatMap(chapter => chapter.missions || []) || [] })
    .map(mission => ({ mission, progress: getMissionProgress(progress, mission.id) }))
    .filter(item => item.progress?.nextReviewAt)
    .sort((a, b) => new Date(a.progress.nextReviewAt) - new Date(b.progress.nextReviewAt))
    .slice(0, limit);
}

export function buildEntryMap(runtime){
  return new Map((runtime?.learnableEntries || []).map(entry => [entry.id, entry]));
}

export function scriptIdFromSource(value){
  const source = clean(value).split('?')[0].split('/').pop() || 'script';
  return source.replace(/\.[^.]+$/, '') || 'script';
}

export function resolveScriptSource(manifest, storedSource){
  const scripts = Array.isArray(manifest?.scripts) ? manifest.scripts : [];
  const sources = scripts.map(scriptOptionSource).filter(Boolean);
  if(storedSource && sources.includes(storedSource)) return storedSource;
  return sources[0] || '';
}

export function scriptOptionSource(item){
  return clean(item?.src || item?.file || item?.path);
}

export function scriptOptionLabel(item){
  return clean(item?.title || item?.label || item?.name || scriptOptionSource(item));
}
