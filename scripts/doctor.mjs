import { spawn } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv, localEnvironmentPath } from './local-env.mjs';
import { localMifosOrigin, localMifosTenant, localMifosProject, mifosFixtureDirectory, pinnedMifosImages, requiredMifosDiskGiB } from './mifos-stack.mjs';

const GiB = 1024 ** 3;
export const minimumResources = Object.freeze({ diskGiB: 8, hostMemoryGiB: 8, dockerMemoryGiB: 4 });

export function supportsNode(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && (major > 22 || (major === 22 && minor >= 13));
}

/** Commands use argument arrays, never a shell; captured output is not echoed. */
export function checkCommand(command, args, { timeoutMs = 10_000 } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', ended = false;
    const finish = result => { if (ended) return; ended = true; clearTimeout(timer); resolveResult(result); };
    child.stdout.on('data', chunk => { if (stdout.length < 64_000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 64_000) stderr += chunk; });
    child.on('error', error => finish({ ok: false, code: error.code, stdout: '', stderr: '' }));
    child.on('exit', code => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, code: 'TIMEOUT', stdout: '', stderr: '' }); }, timeoutMs);
  });
}

export function selectedTarget(args = [], environment = process.env) {
  if (args.includes('--lab')) return 'lab';
  const target = environment.INTERFACE_TARGET?.trim() || 'mifos';
  if (!['lab', 'mifos'].includes(target)) throw new Error('INTERFACE_TARGET must be mifos or lab. Use --lab for the synthetic fixture.');
  return target;
}

export function chromeCandidates(environment = process.env) {
  return [environment.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    environment.LOCALAPPDATA && `${environment.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    environment.PROGRAMFILES && `${environment.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
  ].filter(Boolean);
}

/** Read-only checks; dependency injection keeps tests independent of Docker/keys. */
export async function collectPrerequisites({ root = resolve(import.meta.dirname, '..'), target = 'mifos', environment = process.env,
  nodeVersion = process.versions.node, exists = existsSync, disk = statfsSync, memory = totalmem,
  command = checkCommand } = {}) {
  const checks = [];
  const add = (id, label, ok, message, required = true) => checks.push({ id, label, ok, message, required });
  add('node', 'Node.js', supportsNode(nodeVersion), supportsNode(nodeVersion) ? `${nodeVersion}` : `Found ${nodeVersion}; install Node.js 22.13 or newer, then rerun npm ci.`);
  const chrome = chromeCandidates(environment).find(path => exists(path));
  add('chrome', 'Chromium', Boolean(chrome), chrome || 'Install Google Chrome, or set CHROME_PATH to an installed Chromium executable.');
  const dependencies = ['tsx', 'vite', 'electron'].every(name => exists(resolve(root, 'node_modules', name)));
  add('dependencies', 'Project dependencies', dependencies, dependencies ? 'Installed' : 'Run npm ci from this checkout, then rerun npm run setup.');
  let imagesCached = false;
  if (target === 'mifos') {
    try {
      localMifosTenant(environment.MIFOS_TENANT);
      localMifosOrigin(environment.MIFOS_URL || undefined);
      const project = localMifosProject(environment.MIFOS_COMPOSE_PROJECT);
      mifosFixtureDirectory(root, environment);
      add('mifos-target', 'Mifos target', true, `Local HTTP origin, default tenant, Compose project ${project}.`);
    } catch (error) { add('mifos-target', 'Mifos target', false, error.message); }
    const hostGiB = memory() / GiB;
    add('memory', 'Host memory', hostGiB >= minimumResources.hostMemoryGiB,
      `${hostGiB.toFixed(1)} GiB installed; 8 GiB minimum, 16 GiB recommended for Docker, Chrome and the workbench together.`);
    const compose = await command('docker', ['compose', 'version', '--short']);
    add('compose', 'Docker Compose', compose.ok, compose.ok ? 'Docker Compose v2 is available.' : 'Install Docker Desktop with the Compose v2 plugin, open it, and wait until its engine is running.');
    if (compose.ok) {
      const daemon = await command('docker', ['info', '--format', '{{.MemTotal}}']);
      add('daemon', 'Docker engine', daemon.ok, daemon.ok ? 'Running' : 'Start Docker Desktop and wait for the engine. If it is already open, verify docker context show points to the local desktop engine.');
      if (daemon.ok) {
        const dockerGiB = Number(daemon.stdout) / GiB;
        add('docker-memory', 'Docker memory', Number.isFinite(dockerGiB) && dockerGiB >= minimumResources.dockerMemoryGiB,
          Number.isFinite(dockerGiB) ? `${dockerGiB.toFixed(1)} GiB allocated; assign at least 4 GiB in Docker Desktop → Settings → Resources (8 GiB recommended).` : 'Could not read the Docker memory allocation. Assign at least 4 GiB in Docker Desktop → Settings → Resources.');
        imagesCached = (await command('docker', ['image', 'inspect', ...pinnedMifosImages()])).ok;
      }
    }
  }
  try {
    const space = disk(root), freeGiB = Number(space.bavail) * Number(space.bsize) / GiB;
    const required = target === 'mifos', requiredGiB = requiredMifosDiskGiB(imagesCached);
    add('disk', 'Available disk', freeGiB >= (required ? requiredGiB : 0.5),
      `${freeGiB.toFixed(1)} GiB free${required ? `; at least ${requiredGiB} GiB required ${imagesCached ? 'for the cached local stack' : 'before pulling Mifos images'}. Also check free space in Docker Desktop’s disk allocation.` : '; the lab does not pull Docker images.'}`, required);
  } catch {
    add('disk', 'Available disk', false, 'Could not inspect this checkout’s filesystem. Verify free space before setting up Mifos.', target === 'mifos');
  }
  return { target, checks, ok: checks.every(check => check.ok || !check.required) };
}

export function printPrerequisites(report, output = console.log) {
  output(`Interface local prerequisites — ${report.target === 'mifos' ? 'Mifos X desktop target' : 'synthetic credit-union lab'}`);
  for (const check of report.checks) output(`${check.ok ? 'OK' : check.required ? 'NEEDS ACTION' : 'NOTE'}  ${check.label}: ${check.message}`);
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  loadLocalEnv(localEnvironmentPath(root));
  const target = selectedTarget(process.argv.slice(2));
  const report = await collectPrerequisites({ root, target });
  printPrerequisites(report);
  for (const [name, keys] of [['OpenAI', ['OPENAI_API_KEY']], ['Anthropic', ['ANTHROPIC_API_KEY']], ['Google', ['GOOGLE_API_KEY', 'GEMINI_API_KEY']]]) {
    console.log(`${name} discovery: ${keys.some(key => process.env[key]?.trim()) ? 'configured locally' : 'optional; add a key in Settings or .env for discovery'}`);
  }
  console.log(target === 'mifos' ? 'No cloud deployment is used. After these checks pass, run npm run setup to prepare the local Mifos stack.' : 'Lab mode uses only local Node services and installed Chrome; Docker is not required.');
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
