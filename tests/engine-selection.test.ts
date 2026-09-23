import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from '../src/server/index.js';
import { AccountSelectionRequired } from '../src/server/targets/types.js';
import type { AccountChoice, Run } from '../src/shared/contracts.js';

test('account revalidation cannot overtake a newer owner and disappearing choices refresh without choosing for the user',{timeout:30_000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'interface-selection-race-'));
 const server=await startWorkbench({port:25417,targetPort:25418,dataPath:dir});
 const choices:AccountChoice[]=[{accountReference:'SAV-1001',product:'Everyday Savings',status:'Active'},{accountReference:'OTHER-1001',product:'Everyday Savings',status:'Active'}];
 try{
  // A test double only for the adapter's ambiguity/fresh-list boundary. The
  // browser and worker control queue are real; Mifos membership has separate E2E proof.
  server.engine.profile.resolveAccount=async()=>{throw new AccountSelectionRequired('10001',choices);};
  const create=async()=>{
    const response=await fetch(server.url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'balance',inputs:{clientReference:'10001',accountReference:''},idempotencyKey:randomUUID()})});
    assert.equal(response.status,200);const run:Run=await response.json();
    const end=Date.now()+15_000;
    while(Date.now()<end){const current=server.engine.get(run.id);if(current.status==='awaiting_human')return current;await new Promise(resolve=>setTimeout(resolve,20));}
    throw new Error('Account choice did not become available.');
  };
  const run=await create();
  let release!:(value:AccountChoice[])=>void,entered!:()=>void;
  const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
  server.engine.profile.listAccountChoices=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const epoch=run.epoch;
  const selecting=server.engine.selectAccount(run.id,{epoch,accountReference:'SAV-1001'}).then(()=>undefined,error=>error);
  await enteredPromise;
  const takeover=server.engine.control(run.id,'takeover',{epoch});
  release(choices);
  assert.equal((await selecting)?.statusCode,409);assert.equal((await takeover).owner,'human');
  assert.equal(run.resolvedInputs?.accountReference,undefined);assert.equal(run.status,'human_control');assert.equal(run.modelCalls,0);
  await server.engine.control(run.id,'stop',{epoch:run.epoch});
  const changed=await create(),oldEpoch=changed.epoch;
  server.engine.profile.listAccountChoices=async()=>[choices[1]];
  const refreshed=await server.engine.selectAccount(changed.id,{epoch:oldEpoch,accountReference:'SAV-1001'});
  assert.equal(refreshed.status,'awaiting_human');assert.equal(refreshed.owner,'none');assert.ok(refreshed.epoch>oldEpoch);
  assert.deepEqual(refreshed.intervention?.accountSelection?.choices,[choices[1]]);assert.equal(refreshed.resolvedInputs?.accountReference,undefined);
  await server.engine.control(changed.id,'stop',{epoch:changed.epoch});
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
