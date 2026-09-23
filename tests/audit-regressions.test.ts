import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capabilitySchema, createRunSchema, type Run } from '../src/shared/contracts.js';
import { Store } from '../src/server/store.js';
import { Engine } from '../src/server/engine.js';
import { authoredCapabilities, digest, makeRecord } from '../src/server/capabilities.js';
import { startWorkbench } from '../src/server/index.js';

test('replay rejects stale, invalid, unreviewed and draft execution artifacts before starting a session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'interface-admission-'));
  const store=new Store(dir),engine=new Engine(store,'http://127.0.0.1:26318');
  try{
    const original=authoredCapabilities()[0];
    const attempt=()=>engine.create(createRunSchema.parse({capabilityId:original.id,idempotencyKey:randomUUID()}));
    const extra=structuredClone(original);extra.steps.push({id:'extra',label:'Extra action',action:'press',effect:'read',target:{kind:'css',value:'body',exact:true},value:{source:'literal',value:'Tab'}});
    store.saveCapability(extra);await assert.rejects(attempt,/recorded digest/);
    const invalid={...original,steps:[]};store.saveCapability(invalid);await assert.rejects(attempt,/recorded digest/);
    store.saveCapability({...original,approvalReview:{at:new Date().toISOString(),digest:digest('stale'),replayRunIds:[]}});
    await assert.rejects(attempt,/approved review digest/);
    store.saveCapability({...original,status:'draft'});await assert.rejects(attempt,/explicit validation replay/);
    store.saveCapability(makeRecord(capabilitySchema.parse({...original,provenance:{kind:'discovered',runId:'source'}}),'approved'));
    await assert.rejects(attempt,/no approval review/);
    assert.equal(engine.sessions.size,0);assert.equal(store.runs().length,0);
  }finally{await engine.close();await rm(dir,{recursive:true,force:true});}
});

test('hidden form tampering and missing or throwing validators cannot write an application',{timeout:120_000},async()=>{
  const dataPath=await mkdtemp(join(tmpdir(),'interface-commit-binding-'));
  const server=await startWorkbench({port:26317,targetPort:26318,dataPath});
  const inputs={clientReference:'10001',product:'Everyday Savings',externalReference:'BINDING-TEST'};
  const validator=server.engine.profile.validateCommit;
  const settle=async(id:string):Promise<Run>=>{
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline){const r=server.engine.get(id);if(['completed','awaiting_approval','awaiting_human'].includes(r.status))return r;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error('Run did not settle');
  };
  try{
    for(const fault of ['clientReference','product','externalReference','duplicate','missing-validator','throwing-validator']){
      const r=await settle((await server.engine.create(createRunSchema.parse({task:'submit',inputs,idempotencyKey:randomUUID()}))).id);
      assert.equal(r.status,'awaiting_approval');
      const page=server.engine.sessions.get(r.id)!.page;
      if(fault==='missing-validator')server.engine.profile.validateCommit=undefined as never;
      else if(fault==='throwing-validator')server.engine.profile.validateCommit=()=>{throw new Error('Broken adapter');};
      else if(fault==='duplicate')await page.locator('input[name="clientReference"]').evaluate(el=>el.after(el.cloneNode(true)));
      else await page.locator(`input[name="${fault}"]`).evaluate((el,value)=>(el as HTMLInputElement).value=value,fault==='clientReference'?'10002':fault==='product'?'Growth Savings':'ALTERED');
      await server.engine.control(r.id,'approve',{epoch:r.epoch,approvalId:r.approval!.id});
      const result=await settle(r.id);
      assert.equal(result.effect,'none',fault);
      assert.ok(result.events.some(event=>event.kind==='policy'&&event.message.includes('Blocked submission')),fault);
      assert.ok(!result.events.some(event=>event.kind==='commit_sent'),fault);
      const records=JSON.parse(await readFile(join(dataPath,'banking-lab/applications.json'),'utf8').catch(()=>'[]'));
      assert.equal(records.length,0,fault);
      if(result.status!=='completed')await server.engine.control(result.id,'stop',{epoch:result.epoch});
      server.engine.profile.validateCommit=validator;
    }
    // An explicitly requested draft validation still works, but never submits.
    const cap=server.store.capability('lab-prepare-us-v1')!;cap.status='draft';server.store.saveCapability(cap);
    const prepared=await settle((await server.engine.create(createRunSchema.parse({task:'prepare',replayPurpose:'validation',inputs,idempotencyKey:randomUUID()}))).id);
    assert.equal(prepared.result,'succeeded');assert.equal(prepared.replayPurpose,'validation');assert.equal(prepared.effect,'none');
  }finally{await server.close();await rm(dataPath,{recursive:true,force:true});}
});
