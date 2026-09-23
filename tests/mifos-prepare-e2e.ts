import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from '../src/server/index.js';
import type { Run } from '../src/shared/contracts.js';

// No provider calls or business writes: qualify the reported request and review-only path.
const {loadLocalEnv,localEnvironmentPath}=await import(new URL('../scripts/local-env.mjs',import.meta.url).href);
loadLocalEnv(localEnvironmentPath(resolve('.')));
const {createFineractApi}=await import(new URL('../scripts/mifos-seed.mjs',import.meta.url).href);
const api=createFineractApi({origin:process.env.MIFOS_URL||'http://127.0.0.1:4200',username:process.env.MIFOS_USERNAME,password:process.env.MIFOS_PASSWORD});
const dataPath=await mkdtemp(join(tmpdir(),'interface-mifos-prepare-'));
const server=await startWorkbench({port:27317,target:'mifos',dataPath});
const request=async(path:string,body:unknown)=>{
  const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
};
const settle=async(id:string):Promise<Run>=>{
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){const run=server.engine.get(id);if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Mifos preparation did not settle');
};
try{
  const before=await api('/savingsaccounts?limit=200');
  for(const member of ['167874','10001','10002']){
    const goal=`Prepare a new Everyday Savings sub-account for member ${member} and stop at review`;
    const plan=await request('/api/goals/resolve',{goal});assert.equal(plan.status,'ready');assert.equal(plan.task,'prepare');
    const run=await settle((await request('/api/runs',{mode:'replay',replayPurpose:'validation',task:plan.task,capabilityId:plan.capabilityId,goal,goalReviewed:true,inputs:plan.inputs,idempotencyKey:randomUUID()})).id);
    assert.equal(run.effect,'none');assert.equal(run.modelCalls,0);assert.ok(!run.events.some(event=>event.kind==='commit_sent'));
    assert.ok(!run.steps.some(step=>step.state==='running'||step.state==='waiting'));
    if(member==='167874'){assert.equal(run.outcomeCode,'NOT_FOUND');assert.match(run.error||'',/External Id/);}
    else{assert.equal(run.result,'succeeded',JSON.stringify({status:run.status,error:run.error,intervention:run.intervention}));assert.equal(run.output?.clientReference,member);assert.equal(run.output?.product,'Everyday Savings');assert.equal(await server.engine.profile.atCheckpoint(server.engine.sessions.get(run.id)!.page,'preview'),true);}
    console.log(JSON.stringify({member,result:run.result,outcome:run.outcomeCode,effect:run.effect,modelCalls:run.modelCalls}));
  }
  const after=await api('/savingsaccounts?limit=200');assert.deepEqual(after,before,'Review-only runs changed savings records');
  console.log('Mifos prepare regression passed: missing reference explained; both seeded members stop at review; savings records unchanged.');
}finally{await server.close();await rm(dataPath,{recursive:true,force:true});}
