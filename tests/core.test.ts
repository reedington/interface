import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { authoredCapabilities, digest } from '../src/server/capabilities.js';
import { createRunSchema, capabilitySchema, type Run } from '../src/shared/contracts.js';
import { interpolate } from '../src/server/surface.js';

test('authored contracts terminate at the correct business checkpoint and separate commit permission',()=>{
  const caps=authoredCapabilities();
  for(const cap of caps)capabilitySchema.parse(cap);
  assert.equal(caps.find(c=>c.task==='prepare')!.steps.at(-1)?.checkpoint,'preview');
  assert.equal(caps.find(c=>c.task==='balance')!.steps.at(-1)?.checkpoint,'account');
  assert.equal(caps.find(c=>c.task==='submit')!.steps.filter(s=>s.effect==='commit').length,1);
  assert.equal(caps.find(c=>c.task==='prepare')!.steps.filter(s=>s.effect==='commit').length,0);
  const input=createRunSchema.parse({idempotencyKey:'unit-test',inputs:{clientReference:'00123'}}).inputs;
  assert.equal(interpolate('Open client {{clientReference}}',input),'Open client 00123');
  assert.notEqual(digest(caps[0]),digest({...caps[0],steps:[]}));
});

test('worker restart retains unknown intent and does not resume unfinished browser actions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'interface-store-'));
  try {
    let store=new Store(dir);
    const r:Run={id:'recovery-test',mode:'replay',task:'submit',goal:'Submit synthetic application',status:'running',effect:'unknown',inputs:createRunSchema.parse({idempotencyKey:'unit-test'}).inputs,scenario:'normal',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sessionId:'old-session',owner:'automation',epoch:4,stepIndex:8,steps:[],events:[],frameRevision:1,viewport:{width:1120,height:760},modelCalls:0};
    r.steps=[{id:'submit',label:'Submit',state:'running'}];
    store.saveRun(r);
    for(let i=0;i<105;i++)store.saveRun({...r,id:`completed-${i}`,status:'completed',owner:'none',effect:'none'});
    store.close();store=new Store(dir);
    assert.equal(store.runs().length,100);
    assert.ok(!store.runs().some(run=>run.id===r.id));
    const recovered=store.run(r.id)!;assert.equal(recovered.status,'completed');assert.equal(recovered.effect,'unknown');assert.equal(recovered.outcomeCode,'OUTCOME_UNKNOWN');assert.equal(recovered.owner,'none');assert.equal(recovered.epoch,5);assert.equal(recovered.events.at(-1)?.kind,'recovery');assert.equal(recovered.steps[0].state,'failed');store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
