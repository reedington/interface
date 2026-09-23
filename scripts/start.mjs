import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { collectPrerequisites, printPrerequisites, selectedTarget } from './doctor.mjs';
import { loadLocalEnv, localEnvironmentPath } from './local-env.mjs';

export function startupConfiguration(args = [], environment = process.env) {
  const target = selectedTarget(args, environment);
  return { target, web: args.includes('--web'), environment: { ...environment, INTERFACE_TARGET: target } };
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  process.chdir(root);
  loadLocalEnv(localEnvironmentPath(root));
  const { target, web, environment } = startupConfiguration(process.argv.slice(2));
  const port=Number(environment.WORKBENCH_PORT||4317);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('WORKBENCH_PORT must be an integer between 1024 and 65535.');
  await new Promise((resolveReady,reject)=>{
    const probe=createServer();
    probe.once('error',()=>reject(new Error(`Port ${port} is already in use or unavailable. Close the existing Interface process or set WORKBENCH_PORT before starting another.`)));
    probe.listen(port,'127.0.0.1',()=>probe.close(resolveReady));
  });
  // Image-download headroom and Docker sizing are setup checks. Reopening an
  // already-running stack only requires its health check plus app prerequisites.
  const prerequisites = await collectPrerequisites({ root, target: 'lab', environment });
  if (!prerequisites.ok) { printPrerequisites(prerequisites); throw new Error('Resolve the app prerequisites above before starting Interface.'); }
  const child = (command, args, extra = {}) => spawn(command, args, { cwd: root, stdio: 'inherit', env: environment, shell: false, ...extra });
  async function run(command, args) {
    const processChild = child(command, args);
    const code = await new Promise((resolveExit, reject) => { processChild.on('error', reject); processChild.on('exit', resolveExit); });
    if (code !== 0) throw new Error('A startup command failed. Resolve the error above and try again.');
  }
  if (target === 'mifos') {
    try { await run(process.execPath, ['scripts/mifos-stack.mjs', 'status']); }
    catch { throw new Error('The local Mifos stack is not ready. Open Docker Desktop, then run npm run setup. Use npm run start:lab only when you want the separate synthetic fixture.'); }
  }
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  const server = child(process.execPath, ['--import', 'tsx', 'src/server/index.ts']);
  let desktop, closing = false;
  function shutdown() { if (closing) return; closing = true; desktop?.kill('SIGTERM'); server.kill('SIGTERM'); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  server.on('error', error => { console.error(`Could not start the local worker: ${error.message}`); process.exitCode = 1; shutdown(); });
  server.on('exit', code => { shutdown(); process.exitCode ||= code || 0; });
  const url = `http://127.0.0.1:${environment.WORKBENCH_PORT || 4317}`;
  let ready = false;
  for (let i = 0; i < 60 && !closing; i++) {
    try { const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  if (!ready) {
    console.error('The local workbench did not become ready. Check the error above; make sure its port is not already in use.');
    process.exitCode = 1; shutdown();
  } else if (!web) {
    const env = { ...environment }; delete env.ELECTRON_RUN_AS_NODE;
    desktop = child(process.execPath, ['node_modules/electron/cli.js', 'src/desktop/main.cjs'], { env });
    desktop.on('error', error => { console.error(`Could not open the desktop app: ${error.message}`); process.exitCode = 1; shutdown(); });
    desktop.on('exit', code => { if (code) process.exitCode = code; shutdown(); });
  } else {
    console.log(`Open ${url} in your browser. Press Ctrl+C here to stop the workbench${target === 'lab' ? ' and synthetic target' : ''}.`);
  }
  if (ready && target === 'mifos') console.log('Mifos containers keep their data and remain running after Interface closes. Stop them with node scripts/mifos-stack.mjs down.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
