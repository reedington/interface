import { spawn } from 'node:child_process';
import { chmodSync, constants, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPrerequisites, printPrerequisites, selectedTarget } from './doctor.mjs';
import { loadLocalEnv, localEnvironmentPath } from './local-env.mjs';

/** Exclusive creation preserves an existing .env byte-for-byte, including keys. */
export function ensureLocalEnv(root, copy = copyFileSync, environment = {}) {
  const path = localEnvironmentPath(root, environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { copy(resolve(root, '.env.example'), path, constants.COPYFILE_EXCL); chmodSync(path, 0o600); return 'created'; }
  catch (error) { if (error.code === 'EEXIST') return 'preserved'; throw error; }
}

export function runChild(command, args, { root, environment = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolveResult() : reject(new Error(`Local setup command ${signal ? `was stopped (${signal})` : `failed (exit ${code})`}. Resolve the error above and rerun npm run setup.`)));
  });
}

export async function setupLocal({ root = resolve(import.meta.dirname, '..'), args = [], environment = process.env,
  inspect = collectPrerequisites, run = runChild, createEnv = ensureLocalEnv, output = console.log } = {}) {
  const target = selectedTarget(args, environment);
  const report = await inspect({ root, target, environment });
  printPrerequisites(report, output);
  if (!report.ok) throw new Error('Setup stopped before downloading or starting containers. Resolve the prerequisite failures above, then rerun npm run setup.');
  const envState = createEnv(root, undefined, environment);
  output(envState === 'created' ? 'Created local environment configuration from .env.example. Add a model key when you want discovery.' : 'Existing local environment configuration preserved. No credentials were replaced.');
  // Electron 44 installs its executable lazily. Provision it during setup so
  // the first desktop launch does not need another network download.
  output('Preparing the desktop runtime. The official Electron installer reuses an existing matching binary.');
  await run(process.execPath, [resolve(root, 'node_modules/electron/install.js')], { root, environment });
  if (target === 'mifos') {
    output('Preparing the pinned local Mifos stack. The first run downloads container images and can take several minutes.');
    const childOptions = { root, environment: { ...environment, INTERFACE_TARGET: 'mifos' } };
    await run(process.execPath, [resolve(root, 'scripts/mifos-stack.mjs'), 'up'], childOptions);
    await run(process.execPath, [resolve(root, 'scripts/mifos-seed.mjs')], childOptions);
    output('Local Mifos readiness and fixture setup passed. Run npm start to open Interface.');
  } else {
    output('The synthetic lab is ready. Run npm run start:lab to open it.');
  }
  return { target, envState };
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  loadLocalEnv(localEnvironmentPath(root));
  await setupLocal({ root, args: process.argv.slice(2) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
