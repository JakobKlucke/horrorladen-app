import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ScriptModel from '../script-model.js';
import RoadmapModel from '../roadmap-model.js';
import ProfileStore from '../profile-store.js';
import * as StageCueCore from '../src/stagecue-core.mjs';
import {
  createLocalAuthProfile,
  firstAvailableMission,
  isAdminEmail,
  isAuthGateRequired,
  isStartCenteredTabOrder,
  leaderboardSummary,
  progressSummary,
  resolveScriptSource,
  sceneProgress,
  scriptIdFromSource
} from '../src/stagecue-core.mjs';

const addams = JSON.parse(await readFile(new URL('../private/scripts/addams_family.json', import.meta.url), 'utf8'));

function buildAddamsRole(){
  const runtime = ScriptModel.buildRuntimeModel(ScriptModel.normalizeScriptData(addams));
  const roadmap = RoadmapModel.buildRoadmap(runtime, { scriptId:'addams_family' });
  const role = RoadmapModel.getRoleRoadmap(roadmap, 'role-gomez');
  const progress = RoadmapModel.createDefaultProgress({
    profileId: 'profile-test',
    scriptId: 'addams_family',
    roleId: role.roleId
  });
  return { runtime, roadmap, role, progress };
}

test('resolveScriptSource keeps stored valid source and falls back to first script', () => {
  const manifest = { scripts: [{ file:'a.json', label:'A' }, { src:'b.json', title:'B' }, { id:'secure-script', title:'Secure' }] };
  assert.equal(resolveScriptSource(manifest, 'b.json'), 'b.json');
  assert.equal(resolveScriptSource(manifest, 'secure-script'), 'secure-script');
  assert.equal(resolveScriptSource(manifest, 'missing.json'), 'a.json');
});

test('scriptIdFromSource creates stable ids from json paths', () => {
  assert.equal(scriptIdFromSource('/scripts/addams_family.json'), 'addams_family');
  assert.equal(scriptIdFromSource('horrorladen_final_with_acts.json?x=1'), 'horrorladen_final_with_acts');
});

test('progressSummary and sceneProgress derive mobile dashboard values', () => {
  const { role, progress } = buildAddamsRole();
  const summary = progressSummary(role, progress, RoadmapModel);
  assert.ok(summary.missions > 0);
  assert.equal(summary.completed, 0);
  assert.equal(summary.percent, 0);

  const scenes = sceneProgress(role, progress);
  assert.ok(scenes.length > 1);
  assert.ok(scenes.every(scene => scene.total > 0));
});

test('firstAvailableMission returns an unlocked deterministic mission', () => {
  const { role, progress } = buildAddamsRole();
  const mission = firstAvailableMission(role, progress, RoadmapModel);
  assert.ok(mission);
  assert.equal(RoadmapModel.isUnlocked(progress, mission), true);
  assert.ok(mission.entryIds.length > 0);
});

test('mobile navigation keeps Start as centered primary tab', () => {
  assert.equal(isStartCenteredTabOrder(), true);
});

test('app shell exposes RoleQuest branding', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.equal(StageCueCore.APP_BRAND?.name, 'RoleQuest');
  assert.equal(StageCueCore.APP_BRAND?.slogan, 'Deine Rolle. Deine Quest.');
  assert.match(html, /<title>RoleQuest<\/title>/);
  assert.match(html, /RoleQuest/);
  assert.match(html, /Deine Rolle\. Deine Quest\./);
});

test('auth gate only appears when no local profiles exist', () => {
  assert.equal(isAuthGateRequired({ profiles: [] }), true);
  assert.equal(isAuthGateRequired({ profiles: [{ id: 'profile-1' }] }), false);
});

test('local auth profile preserves profile compatibility and optional pin marker', () => {
  const profile = createLocalAuthProfile(ProfileStore, {
    displayName: 'Jakob',
    pin: '1234',
    scriptId: 'addams_family',
    roleId: 'role-gomez'
  });

  assert.equal(profile.displayName, 'Jakob');
  assert.equal(profile.scriptId, 'addams_family');
  assert.equal(profile.roleId, 'role-gomez');
  assert.equal(profile.localAuth.type, 'local');
  assert.equal(profile.localAuth.hasPin, true);
  assert.equal(profile.localAuth.pin, '1234');
});

test('admin email gate accepts only the configured admin address', () => {
  assert.equal(isAdminEmail('kontakt@jakobklucke.de'), true);
  assert.equal(isAdminEmail(' Kontakt@JakobKlucke.de '), true);
  assert.equal(isAdminEmail('jakob@example.com'), false);
  assert.equal(isAdminEmail(''), false);
});

test('leaderboardSummary derives aggregated ranking fields from local progress', () => {
  const { role, progress } = buildAddamsRole();
  const firstMission = firstAvailableMission(role, progress, RoadmapModel);
  const completed = RoadmapModel.completeMission(
    progress,
    firstMission,
    { accuracy: 0.99, hintsUsed: 0 },
    new Date('2026-05-11T10:00:00.000Z')
  );

  const summary = leaderboardSummary({
    profile: { displayName: 'Jakob' },
    progress: completed,
    roleRoadmap: role,
    RoadmapModel
  });

  assert.equal(summary.displayName, 'Jakob');
  assert.equal(summary.scriptId, completed.scriptId);
  assert.equal(summary.roleId, completed.roleId);
  assert.equal(summary.xp, completed.xp);
  assert.equal(summary.streakDays, completed.streakDays);
  assert.equal(summary.completedMissions, 1);
  assert.equal(summary.stars, completed.missions[firstMission.id].stars);
});
