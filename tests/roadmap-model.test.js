const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ScriptModel = require('../script-model.js');
const RoadmapModel = require('../roadmap-model.js');
const ProfileStore = require('../profile-store.js');

function demoRuntime(){
  return ScriptModel.buildRuntimeModel({
    title: 'Demo',
    roles: [{ id:'role-gomez', label:'GOMEZ' }],
    entries: [
      { id:'e1', order:1, kind:'dialogue', speakerId:'role-gomez', speaker:'GOMEZ', text:'A', actLabel:'Akt I', sceneId:'scene-1', sceneLabel:'Erste Szene' },
      { id:'e2', order:2, kind:'dialogue', speakerId:'role-gomez', speaker:'GOMEZ', text:'B', actLabel:'Akt I', sceneId:'scene-1', sceneLabel:'Erste Szene' },
      { id:'e3', order:3, kind:'dialogue', speakerId:'role-gomez', speaker:'GOMEZ', text:'C', actLabel:'Akt I', sceneId:'scene-2', sceneLabel:'Zweite Szene' },
      { id:'e4', order:4, kind:'dialogue', speakerId:'role-gomez', speaker:'GOMEZ', text:'D', actLabel:'Akt I', sceneId:'scene-2', sceneLabel:'Zweite Szene' }
    ]
  });
}

test('buildRoadmap creates role chapters and valid mission entry ids', () => {
  const runtime = demoRuntime();
  const roadmap = RoadmapModel.buildRoadmap(runtime, { scriptId:'demo' });
  const validation = RoadmapModel.validateRoadmap(roadmap, runtime);

  assert.equal(validation.ok, true);
  assert.equal(roadmap.roles.length, 1);
  assert.equal(roadmap.roles[0].roleId, 'role-gomez');
  assert.equal(roadmap.roles[0].chapters.length, 2);
  assert.ok(RoadmapModel.flattenAllMissions(roadmap).length >= 6);
  RoadmapModel.flattenAllMissions(roadmap).forEach(mission => {
    assert.ok(mission.entryIds.length > 0);
    mission.entryIds.forEach(id => assert.ok(runtime.entries.some(entry => entry.id === id)));
  });
});

test('addams roadmap creates Gomez missions across known scenes', () => {
  const file = path.join(__dirname, '../private/scripts/addams_family.json');
  const runtime = ScriptModel.buildRuntimeModel(JSON.parse(fs.readFileSync(file, 'utf8')));
  const roadmap = RoadmapModel.buildRoadmap(runtime, { scriptId:'addams-family' });
  const gomez = RoadmapModel.getRoleRoadmap(roadmap, 'role-gomez');
  const validation = RoadmapModel.validateRoadmap(roadmap, runtime);

  assert.equal(validation.ok, true);
  assert.ok(gomez);
  assert.ok(gomez.profile.lineCount >= 300);
  assert.ok(gomez.chapters.length >= 8);
  assert.ok(RoadmapModel.flattenMissions(gomez).some(mission => mission.missionType === 'boss_scene'));
});

test('unlock logic opens first chapter and locks later chapter until prerequisites', () => {
  const roadmap = RoadmapModel.buildRoadmap(demoRuntime(), { scriptId:'demo' });
  const role = roadmap.roles[0];
  const progress = RoadmapModel.createDefaultProgress({ profileId:'p1', scriptId:'demo', roleId:'role-gomez' });

  assert.equal(RoadmapModel.isUnlocked(progress, role.chapters[0]), true);
  assert.equal(RoadmapModel.isUnlocked(progress, role.chapters[1]), false);

  const required = role.chapters[0].requiredMissionIds[0];
  progress.missions[required] = { status:'completed', stars:1 };
  assert.equal(RoadmapModel.isUnlocked(progress, role.chapters[1]), true);
});

test('completeMission updates stars xp streak and review date deterministically', () => {
  const roadmap = RoadmapModel.buildRoadmap(demoRuntime(), { scriptId:'demo' });
  const mission = RoadmapModel.flattenMissions(roadmap.roles[0])[0];
  const start = RoadmapModel.createDefaultProgress({ profileId:'p1', scriptId:'demo', roleId:'role-gomez' });
  const first = RoadmapModel.completeMission(start, mission, { accuracy:0.92, hintsUsed:1 }, new Date('2026-05-10T10:00:00.000Z'));
  const second = RoadmapModel.completeMission(first, mission, { accuracy:0.99, hintsUsed:0 }, new Date('2026-05-11T10:00:00.000Z'));

  assert.equal(first.missions[mission.id].stars, 2);
  assert.equal(first.streakDays, 1);
  assert.ok(first.xp > 0);
  assert.equal(second.missions[mission.id].stars, 3);
  assert.equal(second.streakDays, 2);
  assert.ok(second.xp > first.xp);
});

test('profile store round-trips local profiles and progress without browser services', async () => {
  const store = ProfileStore.createStore({});
  const profile = ProfileStore.createDefaultProfile({ displayName:'Jakob', scriptId:'demo', roleId:'role-gomez' });
  await store.upsertProfile(profile);
  await store.setActiveProfile(profile.id);
  const progress = RoadmapModel.createDefaultProgress({ profileId:profile.id, scriptId:'demo', roleId:'role-gomez' });
  progress.xp = 120;
  await store.saveProgress(progress);

  const state = await store.loadState();
  const savedProgress = await store.getProgress(profile.id, 'demo', 'role-gomez');

  assert.equal(state.activeProfileId, profile.id);
  assert.equal(state.profiles[0].displayName, 'Jakob');
  assert.equal(savedProgress.xp, 120);
});
