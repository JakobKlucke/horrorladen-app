import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const manifestPath = new URL('../private/scripts/scripts.json', import.meta.url);
const outputJsonPath = new URL('../supabase/seed/invites.json', import.meta.url);

function sql(value){
  if(value == null) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function codeForScript(scriptId){
  const randomPart = randomBytes(12).toString('base64url');
  return `STAGECUE-${String(scriptId).toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${randomPart}`;
}

async function main(){
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const scripts = Array.isArray(manifest.scripts) ? manifest.scripts : [];
  if(!scripts.length) throw new Error('private/scripts/scripts.json enthaelt keine Skripte.');

  const rows = [];
  const codes = [];
  const invites = [];
  for(const item of scripts){
    const file = item.file || item.src || item.path;
    const scriptId = item.id || String(file || '').replace(/\.[^.]+$/, '');
    if(!scriptId) throw new Error('Skript ohne id/file gefunden.');
    const code = codeForScript(scriptId);
    const hash = createHash('sha256').update(code).digest('hex');
    rows.push(`(${sql(hash)}, ${sql(scriptId)}, null, null)`);
    codes.push({ scriptId, code });
    invites.push({ code_hash: hash, script_id: scriptId, max_uses: null, expires_at: null });
  }

  const sqlText = [
    'insert into public.invite_codes(code_hash, script_id, max_uses, expires_at)',
    `values\n${rows.join(',\n')}`,
    'on conflict (code_hash) do nothing;',
    ''
  ].join('\n');

  await mkdir(dirname(outputJsonPath.pathname), { recursive: true });
  await writeFile(outputJsonPath, `${JSON.stringify({ codes, invites, sql: sqlText }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ codes, sql: sqlText }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
