import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticFiles } from '../vite.config.js';

const publicScriptFiles = new Set([
  'scripts.json',
  'horrorladen_final_with_acts.json',
  'addams_family.json',
  'addams_family_szenentext.json'
]);

test('vite static copy list does not publish plaintext script manifests or books', () => {
  for(const file of staticFiles){
    assert.equal(publicScriptFiles.has(file), false, `${file} must not be copied to dist`);
  }
});
