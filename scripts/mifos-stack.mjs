import { spawnSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadLocalEnv, localEnvironmentPath } from './local-env.mjs';

const root = resolve(import.meta.dirname, '..');
const stack = resolve(root, 'infra/mifos');
const GiB = 1024 ** 3;

export function pinnedMifosImages() {
  const versions = JSON.parse(readFileSync(resolve(stack, 'versions.json'), 'utf8'));
  return ['webApp', 'fineract', 'postgres'].map(service => `${versions[service].image}@${versions[service].digest}`);
}

export function requiredMifosDiskGiB(imagesCached) { return imagesCached ? 2 : 8; }

export function localMifosProject(raw = 'interface-mifos') {
  const project = raw?.trim() || 'interface-mifos';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error('MIFOS_COMPOSE_PROJECT must be 1–63 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.');
  return project;
}

export function mifosFixtureDirectory(checkoutRoot, environment = {}) {
  const configured = environment.MIFOS_FIXTURE_DIR?.trim() || '.local/mifos';
  if (configured.includes('\0')) throw new Error('MIFOS_FIXTURE_DIR must be a filesystem directory path.');
  return resolve(checkoutRoot, configured);
}

export function localMifosTenant(raw = 'default') {
  if ((raw?.trim() || 'default') !== 'default') throw new Error('This local Mifos stack provisions only tenant "default". Set MIFOS_TENANT=default; custom tenants are not supported.');
  return 'default';
}

export function localMifosOrigin(raw = 'http://127.0.0.1:4200') {
  let url;
  try { url = new URL(raw); } catch { throw new Error('MIFOS_URL must be a local HTTP origin such as http://127.0.0.1:4200.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('MIFOS_URL must be a loopback HTTP origin with no path, credentials, query, or fragment.');
  }
  const port = Number(url.port || 80);
  if (port < 1024 || port > 65535) throw new Error('MIFOS_URL must use a port from 1024 through 65535.');
  return { origin: url.origin, port };
}

/** Read-only, real application checks. A synthetic lab server cannot satisfy the API check. */
export async function probeMifos(origin, fetchImpl = fetch, credentials = {}) {
  let tenant;
  try {
    origin = localMifosOrigin(origin).origin;
    tenant = localMifosTenant(credentials.tenant ?? process.env.MIFOS_TENANT ?? 'default');
  } catch (error) { return { ready: false, reason: error.message }; }
  try {
    const index = await fetchImpl(`${origin}/`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!index.ok || !/html/i.test(index.headers.get('content-type') || '')) return { ready: false, reason: 'Mifos web app is not serving HTML.' };
    const indexText = await index.text();
    if (!/mifos|mifosx|mifos-app/i.test(indexText)) return { ready: false, reason: 'The local port is not serving the expected Mifos web app.' };
    const api = await fetchImpl(`${origin}/fineract-provider/api/v1/clients?limit=1`, {
      signal: AbortSignal.timeout(10000), redirect: 'error',
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username ?? process.env.MIFOS_USERNAME ?? 'mifos'}:${credentials.password ?? process.env.MIFOS_PASSWORD ?? 'password'}`).toString('base64')}`,
        'Fineract-Platform-TenantId': tenant, Accept: 'application/json',
      },
    });
    if (!api.ok) return { ready: false, reason: `Fineract is not ready with the local test credentials (HTTP ${api.status}).` };
    const clients = await api.json();
    if (!clients || !Array.isArray(clients.pageItems) || typeof clients.totalFilteredRecords !== 'number') return { ready: false, reason: 'Fineract returned an unexpected clients response.' };
    return { ready: true, reason: 'Mifos web app and authenticated Fineract API are ready.' };
  } catch {
    return { ready: false, reason: 'The local Mifos web app or Fineract API is unavailable.' };
  }
}

function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 30000, ...options });
  if (result.error?.code === 'ENOENT') throw new Error('Docker was not found. Install Docker Desktop, start it, then retry setup.');
  if (result.error) throw new Error(`Docker command failed: ${result.error.message}`);
  return result;
}

function requireLocalDocker(checkResources = false) {
  // A globally selected remote Docker context must never turn "local setup" into a deployment.
  let endpoint = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
  if (!endpoint) {
    const context = runDocker(['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}']);
    if (context.status !== 0) throw new Error('Cannot inspect the Docker context. Start Docker Desktop and select its local context.');
    try { endpoint = JSON.parse(context.stdout.trim()); } catch { throw new Error('Cannot determine whether the selected Docker context is local.'); }
  }
  if (typeof endpoint !== 'string' || !(/^(unix|npipe):/.test(endpoint) || /^tcp:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint))) {
    throw new Error('The selected Docker endpoint is remote. Select a local Docker Desktop context; this command does not deploy to remote hosts.');
  }
  const info = runDocker(['info', '--format', '{{json .}}']);
  if (info.status !== 0) throw new Error('Docker is installed but its local engine is not running. Open Docker Desktop and wait until it is ready.');
  let details;
  try { details = JSON.parse(info.stdout); } catch { throw new Error('Docker engine information could not be read.'); }
  if (details.OSType !== 'linux') throw new Error('Mifos needs Linux containers. Switch Docker Desktop to Linux containers/WSL2.');
  if (checkResources && Number(details.MemTotal) < 4 * GiB) throw new Error('Assign at least 4 GiB of memory to Docker Desktop, then retry setup.');
  if (runDocker(['compose', 'version']).status !== 0) throw new Error('Docker Compose v2 is required. Update Docker Desktop.');
}

export async function main(argv = process.argv.slice(2)) {
  const [command = 'status', ...extra] = argv;
  if (!['up', 'down', 'status', 'logs', 'config'].includes(command) || extra.length) {
    throw new Error('Usage: node scripts/mifos-stack.mjs up|down|status|logs|config');
  }
  loadLocalEnv(localEnvironmentPath(root));
  if (!['down', 'logs'].includes(command)) localMifosTenant(process.env.MIFOS_TENANT ?? 'default');
  const { origin, port } = localMifosOrigin(process.env.MIFOS_URL || undefined);
  const project = localMifosProject(process.env.MIFOS_COMPOSE_PROJECT);
  const compose = ['compose', '--project-name', project, '--env-file', resolve(stack, 'compose.env'), '--file', resolve(stack, 'compose.yaml')];
  const env = { ...process.env, MIFOS_PORT: String(port), MIFOS_ORIGIN: origin };
  const execute = (args, timeout = 30000) => {
    const result = runDocker([...compose, ...args], { stdio: 'inherit', env, timeout });
    if (result.status !== 0) throw new Error(`Mifos Compose ${args[0]} failed. Run "node scripts/mifos-stack.mjs logs" for startup details.`);
  };
  if (command === 'config') { execute(['config', '--quiet']); console.log('Pinned local Mifos Compose configuration is valid.'); return; }
  if (command === 'status') {
    const status = await probeMifos(origin);
    console.log(`${status.reason} ${origin}`);
    if (!status.ready) process.exitCode = 1;
    return;
  }
  requireLocalDocker(command === 'up');
  if (command === 'logs') { execute(['logs', '--tail', '100', '--no-color']); return; }
  if (command === 'down') { execute(['down'], 120000); console.log('Local Mifos stopped. Its named database volume is retained.'); return; }

  const fs = statfsSync(root);
  const available = fs.bavail * fs.bsize;
  const imagesCached = runDocker(['image', 'inspect', ...pinnedMifosImages()], { stdio: 'ignore' }).status === 0;
  const requiredGiB = requiredMifosDiskGiB(imagesCached);
  if (available < requiredGiB * GiB) throw new Error(`Only ${(available / GiB).toFixed(1)} GiB is free on this filesystem. Free at least ${requiredGiB} GiB ${imagesCached ? 'for the local stack' : 'before pulling Mifos images'}. Nothing was downloaded.`);
  console.log(`Starting local Mifos project ${project} at ${origin}. Initial download and migrations can take several minutes.`);
  execute(['up', '-d', '--quiet-pull', '--wait', '--wait-timeout', '600'], 15 * 60000);
  const deadline = Date.now() + 5 * 60000;
  let lastReason = '';
  while (Date.now() < deadline) {
    const status = await probeMifos(origin);
    if (status.ready) { console.log(`${status.reason} Open ${origin}. Local login defaults are documented in infra/mifos/NOTICE.md.`); return; }
    if (status.reason !== lastReason) { console.log(status.reason); lastReason = status.reason; }
    await delay(3000);
  }
  throw new Error('Mifos did not become ready within the startup deadline. Inspect "node scripts/mifos-stack.mjs logs". Containers and data were retained for diagnosis.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Mifos: ${error.message}`); process.exitCode = 1; });
}
