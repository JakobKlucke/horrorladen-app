const test = require('node:test');
const assert = require('node:assert/strict');
const ScriptModel = require('../script-model.js');

const upper = value => String(value || '').trim().toUpperCase();

test('buildRuntimeModel keeps same-title songs distinct when numbers differ', () => {
  const runtime = ScriptModel.buildRuntimeModel({
    title: 'Songs',
    entries: [
      { id:'a1', order:1, kind:'dialogue', speaker:'SEYMOUR', text:'Hallo', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'REPRISE' },
      { id:'a2', order:2, kind:'dialogue', speaker:'AUDREY', text:'Welt', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 2', songTitle:'REPRISE' }
    ]
  });

  assert.equal(runtime.songs.length, 2);
  assert.notEqual(runtime.songs[0].id, runtime.songs[1].id);
  assert.equal(ScriptModel.formatSongLabel(runtime.songs[0]), 'Nr. 1 - REPRISE');
  assert.equal(ScriptModel.formatSongLabel(runtime.songs[1]), 'Nr. 2 - REPRISE');
});

test('context lookup uses stable entry ids for repeated identical lines', () => {
  const runtime = ScriptModel.buildRuntimeModel({
    title: 'Kontext',
    entries: [
      { id:'l1', order:1, kind:'dialogue', speaker:'ROLLE A', text:'Intro', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'OPENER' },
      { id:'l2', order:2, kind:'dialogue', speaker:'ROLLE B', text:'Wiederholt', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'OPENER' },
      { id:'l3', order:3, kind:'dialogue', speaker:'ROLLE C', text:'Bridge', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'OPENER' },
      { id:'l4', order:4, kind:'dialogue', speaker:'ROLLE B', text:'Wiederholt', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'OPENER' },
      { id:'l5', order:5, kind:'dialogue', speaker:'ROLLE D', text:'Outro', actLabel:'Erster Akt', sceneLabel:'1. Szene', songNumber:'Nr. 1', songTitle:'OPENER' }
    ]
  });

  const items = runtime.learnableEntries;
  const firstContext = ScriptModel.getContextForEntry(items, 'l2', { role:'ROLLE B', onlySameSong:true, normalizeSpeaker:upper });
  const secondContext = ScriptModel.getContextForEntry(items, 'l4', { role:'ROLLE B', onlySameSong:true, normalizeSpeaker:upper });

  assert.equal(firstContext.prev.text, 'Intro');
  assert.equal(firstContext.next.text, 'Bridge');
  assert.equal(secondContext.prev.text, 'Bridge');
  assert.equal(secondContext.next.text, 'Outro');
});

test('derived acts and scenes work without a separate acts tree', () => {
  const runtime = ScriptModel.buildRuntimeModel({
    title: 'Ohne Acts-Liste',
    entries: [
      { order:1, kind:'dialogue', speaker:'A', text:'x', actLabel:'Erster Akt', sceneLabel:'1. Szene' },
      { order:2, kind:'dialogue', speaker:'B', text:'y', actLabel:'Erster Akt', sceneLabel:'2. Szene' },
      { order:3, kind:'dialogue', speaker:'C', text:'z', actLabel:'Zweiter Akt', sceneLabel:'1. Szene' }
    ]
  });

  assert.equal(runtime.acts.length, 2);
  const firstActId = runtime.acts[0].id;
  const secondActId = runtime.acts[1].id;
  assert.deepEqual(
    ScriptModel.getScenesForAct(runtime, firstActId).map(scene => scene.label),
    ['1. Szene', '2. Szene']
  );
  assert.deepEqual(
    ScriptModel.getScenesForAct(runtime, secondActId).map(scene => scene.label),
    ['1. Szene']
  );
});

test('learnable entries exclude stage directions, narration and cuts', () => {
  const runtime = ScriptModel.buildRuntimeModel({
    title: 'Kinds',
    entries: [
      { order:1, kind:'stage_direction', text:'Licht aus', actLabel:'Erster Akt', sceneLabel:'1. Szene' },
      { order:2, kind:'narration', text:'Off-Text', actLabel:'Erster Akt', sceneLabel:'1. Szene' },
      { order:3, kind:'dialogue', speaker:'SEYMOUR', text:'Bleibt', actLabel:'Erster Akt', sceneLabel:'1. Szene' },
      { order:4, kind:'lyric', speaker:'AUDREY', text:'Auch', actLabel:'Erster Akt', sceneLabel:'1. Szene', cut:true }
    ]
  });

  assert.equal(runtime.learnableEntries.length, 1);
  assert.equal(runtime.learnableEntries[0].text, 'Bleibt');
});

test('countPendingIssues only counts unresolved review rows', () => {
  const issues = [
    { status:'pending' },
    { status:'accepted' },
    { status:'info' },
    { status:'' }
  ];

  assert.equal(ScriptModel.countPendingIssues(issues), 2);
});

test('applyReviewRows updates canonical entries and keeps resolved issues', () => {
  const updated = ScriptModel.applyReviewRows({
    title: 'Review',
    entries: [
      { id:'e1', order:1, kind:'dialogue', speaker:'SEYMOUR', text:'Hallo', actLabel:'Erster Akt', sceneLabel:'1. Szene' },
      { id:'e2', order:2, kind:'dialogue', speaker:'AUDREY', text:'Welt', actLabel:'Erster Akt', sceneLabel:'1. Szene' }
    ],
    issues: []
  }, [
    {
      issue_id:'scene-1',
      start_entry_id:'e1',
      end_entry_id:'e2',
      field:'sceneLabel',
      value:'2. Szene',
      status:'accepted'
    },
    {
      issue_id:'cut-1',
      start_entry_id:'e2',
      end_entry_id:'e2',
      field:'cut',
      value:'true',
      status:'accepted'
    }
  ]);

  assert.equal(updated.entries[0].sceneLabel, '2. Szene');
  assert.equal(updated.entries[1].cut, true);
  assert.equal(ScriptModel.countPendingIssues(updated.issues), 0);
});

test('role aliases and song singer ids survive normalization and export', () => {
  const runtime = ScriptModel.buildRuntimeModel({
    title: 'Metadaten',
    roles: [
      { id:'role-gomez', label:'GOMEZ', aliases:['Gomez Addams', 'Herr Addams'] }
    ],
    songs: [
      { id:'song-opening', number:'Nr. 1', title:'Opening', label:'Nr. 1 - Opening', singerIds:['role-gomez'] }
    ],
    entries: [
      {
        id:'e1',
        order:1,
        kind:'lyric',
        speakerId:'role-gomez',
        speaker:'GOMEZ',
        text:'Willkommen',
        songId:'song-opening',
        songNumber:'Nr. 1',
        songTitle:'Opening'
      }
    ]
  });

  assert.deepEqual(runtime.roles[0].aliases, ['Gomez Addams', 'Herr Addams']);
  assert.deepEqual(runtime.songs[0].singerIds, ['role-gomez']);

  const exported = ScriptModel.applyReviewRows(runtime.canonical, []);
  assert.deepEqual(exported.roles[0].aliases, ['Gomez Addams', 'Herr Addams']);
  assert.deepEqual(exported.songs[0].singerIds, ['role-gomez']);
});

test('applyCutToEntryIds toggles cut flags deterministically', () => {
  const entries = [
    { id:'e1', text:'A', cut:false },
    { id:'e2', text:'B', cut:false },
    { id:'e3', text:'C', cut:true }
  ];

  const updated = ScriptModel.applyCutToEntryIds(entries, ['e1', 'e3'], true);

  assert.equal(updated[0].cut, true);
  assert.equal(updated[1].cut, false);
  assert.equal(updated[2].cut, true);
  assert.equal(entries[0].cut, false);
});

test('splitEntryForCut cuts a selected text passage without losing original text', () => {
  const entry = {
    id:'e1',
    order:1,
    kind:'dialogue',
    speaker:'GOMEZ',
    text:'A B C',
    cut:false,
    source:{ styleHints:{ italic:false } }
  };

  const parts = ScriptModel.splitEntryForCut(entry, 2, 3);

  assert.deepEqual(parts.map(part => part.text), ['A', 'B', 'C']);
  assert.deepEqual(parts.map(part => part.cut), [false, true, false]);
  assert.equal(parts[1].id, 'e1-cut-1');
  assert.equal(parts[1].speaker, 'GOMEZ');
  assert.deepEqual(parts[1].source.styleHints, { italic:false });

  const runtime = ScriptModel.buildRuntimeModel({ title:'Cuts', entries:parts });
  assert.deepEqual(runtime.learnableEntries.map(item => item.text), ['A', 'C']);
});
