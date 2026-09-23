import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from '../src/server/index.js';
import type { Run } from '../src/shared/contracts.js';

test('worker validates terminal output before success and preserves unknown writes when output/reconciliation fails',{timeout:60_000},async()=>{
 const dataPath=await mkdtemp(join(tmpdir(),'interface-output-gate-'));
 const server=await startWorkbench({port:25317,targetPort:25318,dataPath});
 try{
  const checkpoint=server.engine.profile.checkpoint.bind(server.engine.profile);
  let corrupt:'account'|'submitted'|undefined='account';
  server.engine.profile.checkpoint=async(...args)=>{
    const data=await checkpoint(...args);
    if(args[1]===corrupt)return {...data,clientReference:'99999999'};
    return data;
  };
  const request=async(path:string,body?:unknown,expected=200)=>{
    const response=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
  };
  const settle=async(id:string):Promise<Run>=>{
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline){const run:Run=await request(`/api/runs/${id}`);if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error('The output gate check did not settle.');
  };
  const first=await settle((await request('/api/runs',{task:'balance',idempotencyKey:randomUUID()})).id);
  assert.equal(first.status,'awaiting_human');assert.equal(first.intervention?.code,'OUTPUT_CONTRACT_INVALID');assert.equal(first.effect,'none');assert.notEqual(first.result,'succeeded');
  const audit=await request(`/api/runs/${first.id}/audit`);assert.equal(audit.inputs.clientReference,'[redacted]');assert.ok(!JSON.stringify(audit).includes('99999999'));
  await request(`/api/runs/${first.id}/stop`,{epoch:first.epoch});
  corrupt='submitted';
  let writes=0;const policy=server.engine.profile.networkPolicy;
  server.engine.profile.networkPolicy=request=>{const result=policy(request);if(result==='commit')writes++;return result;};
  const pending=await settle((await request('/api/runs',{task:'submit',inputs:{externalReference:'OUTPUT-GATE-TEST'},idempotencyKey:randomUUID()})).id);
  assert.equal(pending.status,'awaiting_approval');assert.equal(writes,0);
  await request(`/api/runs/${pending.id}/approve`,{epoch:pending.epoch,approvalId:pending.approval!.id});
  const uncertain=await settle(pending.id);
  assert.equal(uncertain.status,'completed');assert.equal(uncertain.result,'failed');assert.equal(uncertain.effect,'unknown');assert.equal(uncertain.outcomeCode,'OUTCOME_UNKNOWN');assert.equal(writes,1);
  const reconcile=server.engine.profile.reconcile.bind(server.engine.profile);
  server.engine.profile.reconcile=async(...args)=>({...await reconcile(...args),clientReference:'99999999'});
  const rejected=await request(`/api/runs/${uncertain.id}/reconcile`,{epoch:uncertain.epoch},500);
  assert.ok(!JSON.stringify(rejected).includes('99999999'));
  assert.equal(server.engine.get(uncertain.id).effect,'unknown');assert.equal(server.engine.get(uncertain.id).result,'failed');assert.equal(writes,1);
  server.engine.profile.reconcile=reconcile;
  const verified:Run=await request(`/api/runs/${uncertain.id}/reconcile`,{epoch:uncertain.epoch});
  assert.equal(verified.effect,'verified');assert.equal(verified.outcomeCode,'RECONCILED');assert.equal(verified.output?.clientReference,'10001');assert.equal(writes,1);
 }finally{await server.close();await rm(dataPath,{recursive:true,force:true});}
});
