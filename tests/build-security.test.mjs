import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { staticFiles } from '../vite.config.js';
import vercelConfig from '../vercel.json' with { type: 'json' };

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

test('vercel routing returns 404 before SPA fallback for private source paths', () => {
  const routes = vercelConfig.routes ?? [];
  const routeSignatures = routes.map(route => `${route.src ?? route.handle}:${route.status ?? route.dest ?? ''}`);

  assert.deepEqual(routeSignatures.slice(0, 3), [
    '/scripts\\.json:404',
    '/private/(.*):404',
    '/supabase/(.*):404'
  ]);
  assert.equal(routeSignatures.at(-1), '/.*:/index.html');
});

test('legacy and importer pages copy their static runtime dependencies', async () => {
  const availableInDist = new Set(['index.html', ...staticFiles]);
  const pages = ['legacy.html', 'importer.html'];

  for(const page of pages){
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    const localReferences = Array.from(html.matchAll(/\b(?:src|href)=["']\.\/([^"'?#]+)(?:[?#][^"']*)?["']/g))
      .map(match => match[1])
      .filter(file => !file.startsWith('src/'));

    for(const file of localReferences){
      assert.equal(availableInDist.has(file), true, `${page} references ${file}, but vite.config.js does not copy it to dist`);
    }
  }
});
