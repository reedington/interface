import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const { assessmentEnvironment, qualificationOptions, copyPublicSource } = await import(new URL('../scripts/qualify-fresh-setup.mjs', import.meta.url).href);

test('fresh qualification refuses normal application ports and strips inherited model credentials/hooks', () => {
  assert.equal(qualificationOptions([], 123).project, 'interface-assessment-123');
  assert.throws(() => qualificationOptions(['--port=4200']), /separate ports/);
  assert.throws(() => qualificationOptions(['--workbench-port=4317']), /separate ports/);
  assert.throws(() => qualificationOptions(['--port=4201', '--workbench-port=4201']), /separate ports/);
  assert.throws(() => qualificationOptions(['--port=65536']), /1024/);
  assert.throws(() => qualificationOptions(['--project=interface-mifos']), /Usage/);
  assert.deepEqual(assessmentEnvironment({ PATH: '/bin', HOME: '/home/synthetic', OPENAI_API_KEY: 'not-copied', AWS_SECRET_ACCESS_KEY: 'not-copied', NODE_OPTIONS: '--require secret.js', MIFOS_URL: 'http://127.0.0.1:4200', ELECTRON_RUN_AS_NODE: '1' }), { PATH: '/bin', HOME: '/home/synthetic' });
});

test('fresh source copying excludes credentials, local state, dependencies, builds and arbitrary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'interface-copy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'copy');
  await mkdir(join(source, 'src'), { recursive: true });
  for (const [file, data] of Object.entries({ 'package.json': '{}', '.env.example': 'OPENAI_API_KEY=\n', '.env': 'not-copied', 'private.txt': 'not-copied', 'src/code.ts': 'export {};', 'src/.env': 'nested-not-copied' })) await writeFile(join(source, file), data);
  for (const directory of ['.local', 'node_modules', 'dist']) { await mkdir(join(source, directory)); await writeFile(join(source, directory, 'private.txt'), 'not-copied'); }
  await copyPublicSource(source, destination);
  assert.equal(await readFile(join(destination, 'src/code.ts'), 'utf8'), 'export {};');
  assert.equal(await readFile(join(destination, '.env.example'), 'utf8'), 'OPENAI_API_KEY=\n');
  for (const file of ['.env', '.local', 'node_modules', 'dist', 'private.txt', 'src/.env']) await assert.rejects(stat(join(destination, file)), { code: 'ENOENT' });
});

test('fresh source copying refuses symbolic links into private files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'interface-copy-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source/src'), { recursive: true });
  await writeFile(join(root, 'secret.txt'), 'not-copied');
  await symlink(join(root, 'secret.txt'), join(root, 'source/src/link.txt'));
  await assert.rejects(copyPublicSource(join(root, 'source'), join(root, 'copy')), /symbolic link/);
});
