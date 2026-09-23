import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPrerequisites, printPrerequisites } from './doctor.mjs';
import { createFineractApi } from './mifos-seed.mjs';
import { localMifosProject, localMifosOrigin, mifosFixtureDirectory } from './mifos-stack.mjs';

const sourceRoot = resolve(import.meta.dirname, '..');
const publicEntries = ['package.json', 'package-lock.json', '.env.example', '.gitignore', 'index.html', 'tsconfig.json', 'vite.config.ts', 'README.md', 'src', 'scripts', 'infra', 'tests', 'public', 'docs'];
const forbiddenEntries = new Set(['.env', '.local', '.git', 'node_modules', 'dist', '.codex', '.agents']);

/** Deliberate allowlist: never inherit model/cloud credentials or executable Node hooks. */
export function assessmentEnvironment(source = process.env) {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CHROME_PATH'];
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

export function qualificationOptions(args = [], timestamp = Date.now()) {
  const settings = { project: `interface-assessment-${timestamp}`, port: 4201, workbenchPort: 14317 };
  for (const argument of args) {
    const match = argument.match(/^--(port|workbench-port)=(\d+)$/);
    if (!match) throw new Error('Usage: npm run test:setup:fresh -- [--port=4201] [--workbench-port=14317]');
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Qualification ports must be from 1024 through 65535.');
    settings[match[1] === 'port' ? 'port' : 'workbenchPort'] = value;
  }
  if (settings.port === 4200 || settings.workbenchPort === 4317 || settings.port === settings.workbenchPort) throw new Error('Qualification must use separate ports, not the normal Mifos 4200 or workbench 4317 ports.');
  localMifosProject(settings.project);
  return settings;
}

/** A clean public-source copy, never an existing setup journal, key file or build. */
export async function copyPublicSource(from, to) {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of publicEntries) {
    const path = resolve(from, entry);
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await cp(path, resolve(to, entry), { recursive: true, errorOnExist: true, force: false,
      filter: async candidate => {
        if (forbiddenEntries.has(basename(candidate))) return false;
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`Public source contains a symbolic link: ${candidate}. Qualification will not follow links into private files.`);
        return true;
      },
    });
  }
}

async function publicSourceSnapshot(checkout) {
  const files = [];
  async function visit(path) {
    if (forbiddenEntries.has(basename(path))) return;
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) { for (const entry of (await readdir(path)).sort()) await visit(resolve(path, entry)); }
    else if (info.isFile()) files.push({ path: relative(checkout, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    else throw new Error('Qualification source snapshot contains a non-regular file.');
  }
  for (const entry of publicEntries) await visit(resolve(checkout, entry));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

async function freePort(port) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already occupied. Choose another qualification port; no existing service was changed.`)));
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

export async function qualifyFreshSetup({ root = sourceRoot, args = process.argv.slice(2), output = console.log } = {}) {
  const options = qualificationOptions(args);
  const environment = assessmentEnvironment();
  const origin = localMifosOrigin(`http://127.0.0.1:${options.port}`).origin;
  const directory = resolve(root, '.local/validation', options.project);
  const checkout = resolve(directory, 'checkout');
  const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', project: options.project, origin, checkout,
    workbenchPort: options.workbenchPort, commands: [], providerKeysCopied: false, existingStackChanged: false };
  const command = async (name, program, commandArgs, cwd = root, live = true) => {
    const started = Date.now();
    let stdout = '', stderr = '';
    const result = await new Promise((done, reject) => {
      const child = spawn(program, commandArgs, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20 * 60_000);
      child.stdout.on('data', chunk => { stdout += chunk; if (live) process.stdout.write(chunk); });
      child.stderr.on('data', chunk => { stderr += chunk; if (live) process.stderr.write(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    });
    await writeFile(resolve(directory, `${name}.log`), stdout + stderr, { mode: 0o600 });
    evidence.commands.push({ name, exitCode: result.code, signal: result.signal, durationMs: Date.now() - started });
    if (result.code !== 0) throw new Error(`Qualification command ${name} failed (exit ${result.code ?? result.signal}). Its log and isolated containers are retained for diagnosis.`);
    return stdout;
  };
  const saveEvidence = () => writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await mkdir(resolve(root, '.local/validation'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    const report = await collectPrerequisites({ root, target: 'mifos', environment });
    evidence.prerequisites = report;
    printPrerequisites(report, output);
    if (!report.ok) throw new Error('Qualification preflight failed before copying or starting containers.');
    await freePort(options.port); await freePort(options.workbenchPort);
    const projectFilter = `label=com.docker.compose.project=${options.project}`;
    const initial = {};
    for (const kind of ['container', 'volume', 'network']) {
      const names = await command(`initial-${kind}`, 'docker', [kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--filter', projectFilter, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}'], root, false);
      assert.equal(names.trim(), '', `Qualification namespace already has ${kind} resources.`);
      initial[kind] = [];
    }
    evidence.initialDockerResources = initial;
    await copyPublicSource(root, checkout);
    for (const entry of ['.env', '.local', 'node_modules', 'dist']) {
      await assert.rejects(lstat(resolve(checkout, entry)), { code: 'ENOENT' });
    }
    evidence.cleanSourceVerified = true;
    const sourceSnapshot = await publicSourceSnapshot(checkout);
    evidence.sourceSnapshotSha256 = sourceSnapshot.sha256;
    evidence.sourceFileCount = sourceSnapshot.files.length;
    await writeFile(resolve(directory, 'source-files.json'), JSON.stringify(sourceSnapshot, null, 2) + '\n', { mode: 0o600 });
    evidence.lockfileSha256 = createHash('sha256').update(await readFile(resolve(checkout, 'package-lock.json'))).digest('hex');
    // This is a newly authored local-test configuration, never copied from the user's .env.
    const fixtureDirectory = resolve(checkout, '.local/fixtures');
    const localConfiguration = `INTERFACE_TARGET=mifos\nMIFOS_COMPOSE_PROJECT=${options.project}\nMIFOS_URL=${origin}\nMIFOS_TENANT=default\nMIFOS_USERNAME=mifos\nMIFOS_PASSWORD=password\nMIFOS_FIXTURE_DIR=${fixtureDirectory}\nWORKBENCH_PORT=${options.workbenchPort}\nWORKBENCH_DATA_DIR=${resolve(checkout, '.local/data')}\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\nGOOGLE_API_KEY=\nGEMINI_API_KEY=\n`;
    await writeFile(resolve(checkout, '.env'), localConfiguration, { mode: 0o600, flag: 'wx' });
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run this qualification through npm run test:setup:fresh so the exact npm CLI can be invoked portably.');
    const npm = (name, npmArgs) => command(name, process.execPath, [npmCli, ...npmArgs], checkout);
    output(`Qualification source: ${checkout}\nIsolated Compose project: ${options.project}\nMifos origin: ${origin}`);
    await npm('npm-ci', ['ci']);
    await npm('typecheck', ['run', 'typecheck']);
    await npm('build', ['run', 'build']);
    const firstSetupOutput = await npm('setup-first', ['run', 'setup']);
    evidence.firstSetupApiWrites = Number(firstSetupOutput.match(/Fixture API writes: (\d+)\./)?.[1]);
    assert.ok(evidence.firstSetupApiWrites > 0);
    const manifestPath = resolve(mifosFixtureDirectory(checkout, { MIFOS_FIXTURE_DIR: fixtureDirectory }), 'fixtures.json');
    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(firstManifest.initialRecordCounts, { members: 0, savingsAccounts: 0, savingsProducts: 0 });
    assert.equal(firstManifest.composeProject, options.project);
    assert.equal(firstManifest.origin, origin);
    const api = createFineractApi({ origin });
    const snapshot = async () => {
      const clients = await api('/clients?limit=200');
      const products = await api('/savingsproducts');
      const accounts = await api('/savingsaccounts?limit=200');
      const accountDetails = [];
      for (const account of accounts.pageItems) {
        const detail = await api(`/savingsaccounts/${account.id}?associations=transactions`);
        accountDetails.push({ id: detail.id, clientId: detail.clientId, reference: detail.accountNo, status: detail.status.id,
          balance: detail.summary.accountBalance, transactions: (detail.transactions || []).map(transaction => ({ id: transaction.id, amount: transaction.amount, reversed: transaction.reversed || false })) });
      }
      return { memberCount: clients.totalFilteredRecords, memberIds: clients.pageItems.map(client => client.id).sort((a,b)=>a-b),
        products: products.map(product => ({ id: product.id, name: product.name })), accountCount: accounts.totalFilteredRecords, accounts: accountDetails };
    };
    const before = await snapshot();
    assert.equal(before.memberCount, 2); assert.equal(before.accountCount, 2);
    assert.deepEqual(before.accounts.map(account => [account.reference, account.balance, account.transactions.length]), [['SAV-1001',12540.75,1],['SAV-1002',840,1]]);
    const repeatedOutput = await npm('setup-repeat', ['run', 'setup']);
    assert.match(repeatedOutput, /Fixture API writes: 0\./);
    const after = await snapshot();
    assert.deepEqual(after, before, 'Repeated setup changed live business records.');
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), firstManifest, 'Repeated setup changed the fixture manifest.');
    const health = await command('stack-status', process.execPath, ['scripts/mifos-stack.mjs', 'status'], checkout);
    assert.match(health, /are ready/);
    evidence.status = 'passed'; evidence.completedAt = new Date().toISOString(); evidence.manifestPath = manifestPath;
    evidence.initialRecordCounts = firstManifest.initialRecordCounts; evidence.seededRecords = before;
    evidence.repeatedSetup = { apiWrites: 0, recordsUnchanged: true, manifestUnchanged: true };
    evidence.environmentFile = resolve(checkout, '.env'); evidence.workbenchDataDirectory = resolve(checkout, '.local/data');
    await saveEvidence();
    output(`Fresh-database qualification passed. Evidence: ${resolve(directory, 'evidence.json')}\nThe isolated stack remains running for additional assessment tests. No existing database volume was removed or reused.`);
    return evidence;
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message; evidence.completedAt = new Date().toISOString();
    await saveEvidence(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualifyFreshSetup().catch(error => { console.error(error.message); process.exitCode = 1; });
}
