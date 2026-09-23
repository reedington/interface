import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { acquireWorkerLock, WorkerAlreadyRunningError } from '../src/server/worker-lock.js';
import { startWorkbench } from '../src/server/index.js';
import { createMifosProfile } from '../src/server/targets/mifos.js';
import { createRunSchema, type Run } from '../src/shared/contracts.js';

async function directory(t:TestContext){
  const path=await mkdtemp(join(tmpdir(),'interface-worker-lock-'));
  t.after(()=>rm(path,{recursive:true,force:true}));return path;
}
const profile=()=>createMifosProfile({baseUrl:'http://127.0.0.1:27718'});

test('worker data lock excludes another owner and releases idempotently',async t=>{
  const path=await directory(t),owner=acquireWorkerLock(path);
  try{
    assert.throws(()=>acquireWorkerLock(path),WorkerAlreadyRunningError);
    assert.equal((await stat(join(path,'.worker-lock.sqlite'))).mode&0o777,0o600);
  }finally{owner.release();owner.release();}
  const next=acquireWorkerLock(path);next.release();
});

test('a crashed lockholder is recovered through OS locking without deleting files or signaling unrelated processes', {timeout:15_000},async t=>{
  const path=await directory(t),module=pathToFileURL(resolve('src/server/worker-lock.ts')).href;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',
    `import{acquireWorkerLock}from${JSON.stringify(module)};acquireWorkerLock(process.argv[1]);process.stdout.write('locked\\n');setInterval(()=>{},1000);`,path],
  {stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}});
  await new Promise<void>((resolveReady,reject)=>{
    let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('locked'))resolveReady();});
    child.once('error',reject);child.once('exit',code=>reject(new Error(`Lock test child exited before readiness (${code})`)));
  });
  assert.throws(()=>acquireWorkerLock(path),WorkerAlreadyRunningError);
  child.kill('SIGKILL');await once(child,'exit');
  assert.equal(existsSync(join(path,'.worker-lock.sqlite')),true);
  const recovered=acquireWorkerLock(path);recovered.release();
});

test('a second worker on another port cannot mark the active owner’s run as session-lost',async t=>{
  const path=await directory(t);
  let first:Awaited<ReturnType<typeof startWorkbench>>|undefined;
  let next:Awaited<ReturnType<typeof startWorkbench>>|undefined;
  try{
    first=await startWorkbench({port:27717,dataPath:path,profile:profile()});
    const at=new Date().toISOString();
    const run:Run={id:'active-owner-run',targetId:'mifos-x',mode:'replay',task:'submit',goal:'Synthetic active history fixture',
      status:'awaiting_approval',effect:'none',inputs:createRunSchema.parse({idempotencyKey:'worker-lock-fixture'}).inputs,
      scenario:'normal',createdAt:at,updatedAt:at,sessionId:'synthetic-owner-session',owner:'none',epoch:7,
      stepIndex:1,steps:[],events:[],frameRevision:0,viewport:{width:1120,height:760},modelCalls:0};
    first.store.saveRun(run);first.engine.runs.set(run.id,run);
    await assert.rejects(startWorkbench({port:27727,dataPath:path,profile:profile()}),WorkerAlreadyRunningError);
    assert.deepEqual(first.store.run(run.id),run,'A rejected duplicate launch must not execute Store recovery');
    assert.equal(first.engine.get(run.id).status,'awaiting_approval');
    await first.close();first=undefined;
    next=await startWorkbench({port:27717,dataPath:path,profile:profile()});
    assert.equal(next.store.run(run.id)?.outcomeCode,'SESSION_LOST','Recovery is valid only after the old worker has released ownership');
    assert.equal(next.store.run(run.id)?.epoch,8);
  }finally{await first?.close();await next?.close();}
});

test('startup failure releases ownership and closes partial resources',async t=>{
  const path=await directory(t),invalid=profile();
  invalid.capabilities=()=>{throw new Error('Synthetic capability initialization failure');};
  await assert.rejects(startWorkbench({port:27737,dataPath:path,profile:invalid}),/Synthetic capability initialization failure/);
  const acquired=acquireWorkerLock(path);acquired.release();
  const occupied=createServer((_request,response)=>response.end('occupied'));
  await new Promise<void>((resolveListening,reject)=>{occupied.once('error',reject);occupied.listen(27737,'127.0.0.1',resolveListening);});
  try{
    await assert.rejects(startWorkbench({port:27737,dataPath:path,profile:profile()}),/EADDRINUSE/);
    const afterListenFailure=acquireWorkerLock(path);afterListenFailure.release();
  }finally{await new Promise<void>((resolveClose,reject)=>occupied.close(error=>error?reject(error):resolveClose()));}
});

test('missing Mifos fixtures fail before creating or holding a worker lock',async t=>{
  const empty=await directory(t),previous=process.cwd(),dataPath=join(empty,'worker-data');
  try{
    process.chdir(empty);
    await assert.rejects(startWorkbench({port:27747,dataPath,target:'mifos'}),/fixtures are missing/);
    assert.equal(existsSync(dataPath),false);
  }finally{process.chdir(previous);}
});
