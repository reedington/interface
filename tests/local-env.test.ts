import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const { loadLocalEnv } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href);

async function fixture(t: TestContext, contents?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interface-env-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

test('explicit project provider and app settings override inherited values', async t => {
  const path = await fixture(t, 'OPENAI_API_KEY="synthetic-project-key#quoted"\nOPENAI_MODEL=gpt-4.1\nWORKBENCH_PORT=12317\nGEMINI_MODEL=synthetic-model\n');
  const environment: Record<string, string> = {
    OPENAI_API_KEY: 'synthetic-inherited-key', OPENAI_MODEL: 'inherited-model',
    WORKBENCH_PORT: '4317', GEMINI_MODEL: 'inherited-alias-model',
    ANTHROPIC_API_KEY: 'synthetic-inherited-anthropic-key',
  };
  assert.equal(loadLocalEnv(path, environment), true);
  assert.deepEqual(environment, {
    OPENAI_API_KEY: 'synthetic-project-key#quoted', OPENAI_MODEL: 'gpt-4.1',
    WORKBENCH_PORT: '12317', GEMINI_MODEL: 'synthetic-model',
    ANTHROPIC_API_KEY: 'synthetic-inherited-anthropic-key',
  });
});

test('a missing project file preserves the inherited environment', async t => {
  const path = await fixture(t);
  const environment = { OPENAI_API_KEY: 'synthetic-inherited-key', PATH: '/synthetic/bin' };
  const before = { ...environment };
  assert.equal(loadLocalEnv(path, environment), false);
  assert.deepEqual(environment, before);
});

test('explicit empty values clear inherited settings without clearing omitted entries', async t => {
  const path = await fixture(t, 'OPENAI_API_KEY=\nOPENAI_MODEL=""\nOPENAI_BASE_URL=\n# ANTHROPIC_API_KEY=\n');
  const environment = {
    OPENAI_API_KEY: 'synthetic-inherited-key', OPENAI_MODEL: 'inherited-model',
    OPENAI_BASE_URL: 'https://inherited.example/v1', ANTHROPIC_API_KEY: 'synthetic-fallback-key',
  };
  loadLocalEnv(path, environment);
  assert.deepEqual(environment, {
    OPENAI_API_KEY: '', OPENAI_MODEL: '', OPENAI_BASE_URL: '',
    ANTHROPIC_API_KEY: 'synthetic-fallback-key',
  });
});

test('project files cannot inject shell, Node or arbitrary child-process variables', async t => {
  const path = await fixture(t, 'PATH=/untrusted/bin\nNODE_OPTIONS="--require /untrusted/module.cjs"\nELECTRON_RUN_AS_NODE=1\nHOME=/untrusted/home\nUNRELATED_API_KEY=synthetic-unrelated-key\nCHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\nWORKBENCH_DATA_DIR=.local/test-data\n');
  const environment: Record<string, string> = { PATH: '/synthetic/bin', NODE_OPTIONS: '--trace-warnings' };
  loadLocalEnv(path, environment);
  assert.deepEqual(environment, {
    PATH: '/synthetic/bin', NODE_OPTIONS: '--trace-warnings',
    CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    WORKBENCH_DATA_DIR: '.local/test-data',
  });
});

test('only explicit Mifos application settings are loaded for the local target', async t => {
  const path = await fixture(t, 'INTERFACE_TARGET=mifos\nMIFOS_URL=http://127.0.0.1:4200\nMIFOS_USERNAME=synthetic-operator\nMIFOS_PASSWORD=synthetic-password\nMIFOS_TENANT=default\nDOCKER_HOST=tcp://untrusted.example:2375\nCOMPOSE_FILE=/untrusted/compose.yaml\n');
  const environment: Record<string, string> = { MIFOS_PASSWORD: 'synthetic-inherited-password' };
  loadLocalEnv(path, environment);
  assert.deepEqual(environment, {
    INTERFACE_TARGET: 'mifos', MIFOS_URL: 'http://127.0.0.1:4200',
    MIFOS_USERNAME: 'synthetic-operator', MIFOS_PASSWORD: 'synthetic-password', MIFOS_TENANT: 'default',
  });
});

test('explicit isolated-stack settings override inherited defaults', async t => {
  const path = await fixture(t, 'MIFOS_COMPOSE_PROJECT=interface-assessment-test\nMIFOS_FIXTURE_DIR=.local/assessment-fixtures\n');
  const environment: Record<string, string> = { MIFOS_COMPOSE_PROJECT: 'interface-mifos', MIFOS_FIXTURE_DIR: '.local/mifos' };
  loadLocalEnv(path, environment);
  assert.deepEqual(environment, { MIFOS_COMPOSE_PROJECT: 'interface-assessment-test', MIFOS_FIXTURE_DIR: '.local/assessment-fixtures' });
});

test('explicit env-file selection is not overridden by file contents and fails closed when missing', async t => {
  const { localEnvironmentPath } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href);
  const path = await fixture(t, 'INTERFACE_ENV_FILE=/untrusted/redirect.env\nMIFOS_URL=http://127.0.0.1:4201\n');
  const environment: Record<string,string> = { INTERFACE_ENV_FILE: path };
  assert.equal(localEnvironmentPath('/checkout', environment), path);
  assert.equal(loadLocalEnv(path, environment), true);
  assert.equal(environment.INTERFACE_ENV_FILE, path);
  assert.equal(environment.MIFOS_URL, 'http://127.0.0.1:4201');
  const missing = path + '-missing';
  assert.throws(() => loadLocalEnv(missing, { INTERFACE_ENV_FILE: missing }), /No default configuration was substituted/);
});
