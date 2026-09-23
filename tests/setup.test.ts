import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { collectPrerequisites, supportsNode } = await import(new URL('../scripts/doctor.mjs', import.meta.url).href);
const { ensureLocalEnv, setupLocal } = await import(new URL('../scripts/setup.mjs', import.meta.url).href);
const { startupConfiguration } = await import(new URL('../scripts/start.mjs', import.meta.url).href);
const { localMifosTenant, probeMifos } = await import(new URL('../scripts/mifos-stack.mjs', import.meta.url).href);
const GiB = 1024 ** 3;

function healthyOptions() {
  return { root: '/synthetic/checkout', target: 'mifos', environment: {}, nodeVersion: '22.13.0',
    exists: () => true, disk: () => ({ bavail: 20 * GiB, bsize: 1 }), memory: () => 16 * GiB,
    command: async (_command: string, args: string[]) => ({ ok: args[0] !== 'image', stdout: args[0] === 'info' ? String(8 * GiB) : '2.39.1' }),
  };
}

test('local startup defaults to Mifos; explicit lab and web flags are preserved without mutating environment', () => {
  const inherited = { OPENAI_API_KEY: 'synthetic-key', INTERFACE_TARGET: 'mifos' };
  assert.equal(startupConfiguration([], {}).target, 'mifos');
  assert.deepEqual(startupConfiguration(['--lab', '--web'], inherited), {
    target: 'lab', web: true, environment: { OPENAI_API_KEY: 'synthetic-key', INTERFACE_TARGET: 'lab' },
  });
  assert.equal(inherited.INTERFACE_TARGET, 'mifos');
  assert.throws(() => startupConfiguration([], { INTERFACE_TARGET: 'production-bank' }), /mifos or lab/);
});

test('cached pinned images permit repeat setup with operating headroom; missing images require download headroom', async () => {
  const options = { ...healthyOptions(), disk: () => ({ bavail: 7.2 * GiB, bsize: 1 }) };
  const uncached = await collectPrerequisites(options);
  assert.equal(uncached.ok, false);
  assert.match(uncached.checks.find((check: { id: string }) => check.id === 'disk').message, /at least 8 GiB/);
  const cached = await collectPrerequisites({ ...options,
    command: async (_command: string, args: string[]) => ({ ok: true, stdout: args[0] === 'info' ? String(8 * GiB) : '' }),
  });
  assert.equal(cached.ok, true);
  assert.match(cached.checks.find((check: { id: string }) => check.id === 'disk').message, /at least 2 GiB/);
  const tooLow = await collectPrerequisites({ ...options, disk: () => ({ bavail: GiB, bsize: 1 }),
    command: async (_command: string, args: string[]) => ({ ok: true, stdout: args[0] === 'info' ? String(8 * GiB) : '' }),
  });
  assert.equal(tooLow.ok, false);
});

test('custom tenants and remote origins are rejected before the readiness probe can send credentials', async () => {
  assert.equal(localMifosTenant(), 'default');
  assert.equal(localMifosTenant(''), 'default');
  assert.throws(() => localMifosTenant('other'), /only tenant "default"/);
  const custom = await collectPrerequisites({ ...healthyOptions(), environment: { MIFOS_TENANT: 'other' } });
  assert.equal(custom.ok, false);
  assert.match(custom.checks.find((check: { id: string }) => check.id === 'mifos-target').message, /only tenant "default"/);
  let calls = 0;
  const network = async () => { calls++; throw new Error('Network must not be used'); };
  assert.equal((await probeMifos('http://127.0.0.1:4200', network, { tenant: 'other' })).ready, false);
  assert.equal((await probeMifos('https://external.example', network)).ready, false);
  assert.equal(calls, 0);
});

test('prerequisites enforce the Node minor version, Docker daemon, disk and memory before setup', async () => {
  for (const version of ['20.20.0', '22.0.0', '22.12.9', 'invalid']) assert.equal(supportsNode(version), false, version);
  for (const version of ['22.13.0', '22.14.0', '24.1.0', 'v25.2.1']) assert.equal(supportsNode(version), true, version);
  const healthy = await collectPrerequisites(healthyOptions());
  assert.equal(healthy.ok, true);
  const lowDisk = await collectPrerequisites({ ...healthyOptions(), disk: () => ({ bavail: 739 * 1024 ** 2, bsize: 1 }) });
  assert.equal(lowDisk.ok, false);
  assert.match(lowDisk.checks.find((check: { id: string }) => check.id === 'disk').message, /at least 8 GiB/);
  const lowMemory = await collectPrerequisites({ ...healthyOptions(), memory: () => 4 * GiB,
    command: async (_command: string, args: string[]) => ({ ok: true, stdout: args[0] === 'info' ? String(2 * GiB) : '2.39.1' }),
  });
  assert.equal(lowMemory.ok, false);
  assert.equal(lowMemory.checks.find((check: { id: string }) => check.id === 'docker-memory').ok, false);
  const stopped = await collectPrerequisites({ ...healthyOptions(),
    command: async (_command: string, args: string[]) => ({ ok: args[0] === 'compose', stdout: '' }),
  });
  assert.equal(stopped.ok, false);
  assert.match(stopped.checks.find((check: { id: string }) => check.id === 'daemon').message, /Start Docker Desktop/);
});

test('lab prerequisites never require or invoke Docker', async () => {
  let commands = 0;
  const report = await collectPrerequisites({ ...healthyOptions(), target: 'lab',
    command: async () => { commands++; throw new Error('Docker must not be inspected for lab mode'); },
  });
  assert.equal(report.ok, true);
  assert.equal(commands, 0);
});

test('missing Chrome, dependencies and Docker report actionable errors without echoing command output', async () => {
  const report = await collectPrerequisites({ ...healthyOptions(), exists: () => false,
    command: async () => ({ ok: false, code: 'ENOENT', stdout: '', stderr: 'synthetic-private-command-detail' }),
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((check: { id: string }) => check.id === 'chrome').message, /Install Google Chrome/);
  assert.match(report.checks.find((check: { id: string }) => check.id === 'dependencies').message, /npm ci/);
  assert.match(report.checks.find((check: { id: string }) => check.id === 'compose').message, /Install Docker Desktop/);
  assert.equal(JSON.stringify(report).includes('synthetic-private-command-detail'), false);
});

test('setup preserves existing credentials and exclusively creates a private env file on a new checkout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'interface-setup-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.env.example'), 'OPENAI_API_KEY=\nINTERFACE_TARGET=mifos\n');
  assert.equal(ensureLocalEnv(directory), 'created');
  assert.equal((await stat(join(directory, '.env'))).mode & 0o777, 0o600);
  const original = 'OPENAI_API_KEY=synthetic-existing-key\nMIFOS_PASSWORD=synthetic-local-password\n';
  await writeFile(join(directory, '.env'), original);
  assert.equal(ensureLocalEnv(directory), 'preserved');
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
});

test('setup blocks before writes or downloads when prerequisites fail', async () => {
  const actions: string[] = [];
  await assert.rejects(setupLocal({ root: '/synthetic/checkout', environment: {}, output: () => {},
    inspect: async () => ({ ok: false, target: 'mifos', checks: [] }),
    createEnv: () => { actions.push('env'); }, run: async () => { actions.push('download'); },
  }), /stopped before downloading/);
  assert.deepEqual(actions, []);
});

test('setup provisions Electron before the stack and fixtures, preserving keys without printing them', async () => {
  const commands: string[][] = [], output: string[] = [];
  const environment = { OPENAI_API_KEY: 'synthetic-secret-do-not-print' };
  const result = await setupLocal({ root: '/synthetic/checkout', environment, output: (message: string) => output.push(message),
    inspect: async () => ({ ok: true, target: 'mifos', checks: [] }), createEnv: () => 'preserved',
    run: async (_command: string, args: string[], options: { environment: Record<string, string> }) => {
      commands.push(args); if(args[0].includes('mifos-'))assert.equal(options.environment.INTERFACE_TARGET, 'mifos');
      assert.equal(options.environment.OPENAI_API_KEY, environment.OPENAI_API_KEY);
    },
  });
  assert.equal(result.target, 'mifos');
  assert.deepEqual(commands, [['/synthetic/checkout/node_modules/electron/install.js'], ['/synthetic/checkout/scripts/mifos-stack.mjs', 'up'], ['/synthetic/checkout/scripts/mifos-seed.mjs']]);
  assert.equal(output.join('\n').includes(environment.OPENAI_API_KEY), false);
  assert.equal(Object.hasOwn(environment, 'INTERFACE_TARGET'), false);
});

test('setup cannot report ready or seed fixtures if stack readiness fails; lab still provisions Electron without containers', async () => {
  let calls = 0;
  const output: string[] = [];
  await assert.rejects(setupLocal({ root: '/synthetic/checkout', environment: {}, output: (message: string) => output.push(message),
    inspect: async () => ({ ok: true, target: 'mifos', checks: [] }), createEnv: () => 'preserved',
    run: async (_command: string, args: string[]) => { calls++; if(args[0].includes('mifos-stack'))throw new Error('Mifos not ready'); },
  }), /Mifos not ready/);
  assert.equal(calls, 2);
  assert.equal(output.some(message => message.includes('setup passed')), false);
  await setupLocal({ root: '/synthetic/checkout', args: ['--lab'], environment: {}, output: () => {},
    inspect: async ({ target }: { target: string }) => { assert.equal(target, 'lab'); return { ok: true, target, checks: [] }; },
    createEnv: () => 'preserved', run: async (_command: string, args: string[]) => { assert.deepEqual(args,['/synthetic/checkout/node_modules/electron/install.js']); },
  });
});

test('a desktop-runtime download failure blocks setup before containers or fixtures can start', async () => {
  const commands: string[][] = [], output: string[] = [];
  await assert.rejects(setupLocal({ root: '/synthetic/checkout', environment: {}, output: (message: string) => output.push(message),
    inspect: async () => ({ ok: true, target: 'mifos', checks: [] }), createEnv: () => 'preserved',
    run: async (_command: string, args: string[]) => { commands.push(args); throw new Error('Electron download failed'); },
  }), /Electron download failed/);
  assert.deepEqual(commands,[['/synthetic/checkout/node_modules/electron/install.js']]);
  assert.equal(output.some(message=>message.includes('setup passed')),false);
});

test('isolated Compose projects and fixture directories are validated without broadening env imports', async () => {
  const { localMifosProject, mifosFixtureDirectory } = await import(new URL('../scripts/mifos-stack.mjs', import.meta.url).href);
  assert.equal(localMifosProject(), 'interface-mifos');
  assert.equal(localMifosProject('interface-assessment-20260923'), 'interface-assessment-20260923');
  for (const invalid of ['../existing', '-existing', 'UPPERCASE', 'one two', 'x'.repeat(64), 'one;docker']) assert.throws(() => localMifosProject(invalid), /MIFOS_COMPOSE_PROJECT/);
  assert.equal(mifosFixtureDirectory('/checkout', { MIFOS_FIXTURE_DIR: '.local/separate' }), '/checkout/.local/separate');
  assert.throws(() => mifosFixtureDirectory('/checkout', { MIFOS_FIXTURE_DIR: 'bad\0path' }), /filesystem directory/);
  const rejected = await collectPrerequisites({ ...healthyOptions(), environment: { MIFOS_COMPOSE_PROJECT: '../existing' } });
  assert.equal(rejected.ok, false);
});
