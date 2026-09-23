import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from '../src/server/index.js';
import type { Run, Scenario, TaskKind } from '../src/shared/contracts.js';

const dataPath=await mkdtemp(join(tmpdir(),'interface-e2e-'));
let server=await startWorkbench({port:14317,targetPort:14318,dataPath});
let checks=0;
async function request(path:string,body?:unknown,expected=200) {
  const res=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await res.json();assert.equal(res.status,expected,JSON.stringify(result));return result;
}
async function create(task:TaskKind='balance',scenario:Scenario='normal',inputs:Record<string,string>={}):Promise<Run> {
  return request('/api/runs',{mode:'replay',task,scenario,inputs:{externalReference:`TEST-${randomUUID().slice(0,8)}`,...inputs},idempotencyKey:randomUUID()});
}
async function wait(id:string,predicate:(r:Run)=>boolean,timeout=25000):Promise<Run> {
  const start=Date.now();while(Date.now()-start<timeout){const r:Run=await request(`/api/runs/${id}`);if(predicate(r))return r;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+JSON.stringify(await request(`/api/runs/${id}`)));
}
const done=(id:string)=>wait(id,r=>r.status==='completed'||r.status==='awaiting_human');
const records=async()=>JSON.parse(await readFile(join(dataPath,'banking-lab/applications.json'),'utf8').catch(()=>'[]')) as Array<Record<string,string>>;
function pass(message:string){checks++;console.log(`✓ ${message}`);}
try {
  const goal='Look up member 10002 and read their current savings balance';
  const plan=await request('/api/goals/resolve',{goal});assert.equal(plan.status,'ready');assert.equal(plan.inputs.accountReference,'');
  await request('/api/runs',{mode:'replay',task:plan.task,goal,goalReviewed:true,capabilityId:plan.capabilityId,inputs:{...plan.inputs,clientReference:'10001'},idempotencyKey:randomUUID()},400);
  const natural=await done((await request('/api/runs',{mode:'replay',task:plan.task,goal,goalReviewed:true,capabilityId:plan.capabilityId,inputs:plan.inputs,idempotencyKey:randomUUID()})).id);
  assert.equal(natural.result,'succeeded',JSON.stringify(natural));assert.equal(natural.output?.accountReference,'SAV-1002');assert.equal(natural.output?.currency,'USD');assert.equal(natural.inputs.accountReference,'');assert.equal(natural.resolvedInputs?.accountReference,'SAV-1002');assert.equal(natural.modelCalls,0);pass('Natural-language goals resolve member identity; the real UI supplies the account and USD result');
  for(const [clientReference,accountReference] of [['10001','SAV-1001'],['10002','SAV-1002']]) {
    const r=await done((await create('balance','normal',{clientReference,accountReference})).id);
    assert.equal(r.result,'succeeded',JSON.stringify(r));assert.equal(r.output?.clientReference,clientReference);assert.equal(r.output?.accountReference,accountReference);assert.match(String(r.output?.balance),/^\d+\.\d{2}$/);assert.equal(r.modelCalls,0);
  }
  pass('Parameterized replay verifies two client/account pairs with zero model calls');
  const p=await done((await create('prepare')).id);assert.equal(p.result,'succeeded');assert.equal(p.effect,'none');assert.equal((await records()).length,0);pass('Prepare ends at preview without persisting an application');
  for(const [scenario,task,code] of [['not_found','balance','NOT_FOUND'],['permission','balance','PERMISSION'],['validation','prepare','VALIDATION']] as const){const r=await done((await create(task,scenario)).id);assert.equal(r.result,'business_outcome',JSON.stringify(r));assert.equal(r.outcomeCode,code);}
  pass('Not found, permission and validation become typed business outcomes');
  const created=await create('submit');const a=await wait(created.id,r=>r.status==='awaiting_approval');
  assert.equal((await records()).length,0);assert.equal(a.approval?.summary.clientReference,'10001');
  await request(`/api/runs/${a.id}/approve`,{epoch:a.epoch-1,approvalId:a.approval!.id},409);
  await request(`/api/runs/${a.id}/approve`,{epoch:a.epoch,approvalId:'wrong'},409);
  await request(`/api/runs/${a.id}/approve`,{epoch:a.epoch,approvalId:a.approval!.id});
  const submitted=await done(a.id);assert.equal(submitted.result,'succeeded',JSON.stringify(submitted));assert.equal(submitted.effect,'verified');assert.equal(submitted.approval?.consumed,true);assert.equal((await records()).length,1);
  await request(`/api/runs/${a.id}/approve`,{epoch:a.epoch,approvalId:a.approval!.id},409);
  assert.equal(submitted.events.filter(e=>e.kind==='commit_sent').length,1);pass('Exact-preview approval gates a single submission; stale/reused approvals fail');
  const unknown=await create('submit','commit_unknown');const ua=await wait(unknown.id,r=>r.status==='awaiting_approval');
  await request(`/api/runs/${ua.id}/approve`,{epoch:ua.epoch,approvalId:ua.approval!.id});const ur=await done(ua.id);
  assert.equal(ur.effect,'unknown');assert.equal(ur.outcomeCode,'OUTCOME_UNKNOWN');assert.equal((await records()).length,2);
  // Reproduce a crash with an uncertain run older than the recent-history window.
  server.store.saveRun({...ur,status:'running',owner:'automation'});
  for(let index=0;index<105;index++)server.store.saveRun({...p,id:`newer-completed-${index}`});
  await server.close();server=await startWorkbench({port:14317,targetPort:14318,dataPath});
  assert.ok(!server.store.runs().some(run=>run.id===ur.id));
  const recovered:Run=await request(`/api/runs/${ur.id}`);assert.equal(recovered.status,'completed');assert.equal(recovered.owner,'none');assert.equal(recovered.outcomeCode,'OUTCOME_UNKNOWN');
  const retainedFrame=await request(`/api/runs/${ur.id}/frame`);assert.ok(retainedFrame.dataUrl.startsWith('data:image/jpeg;base64,'));
  const reconciled:Run=await request(`/api/runs/${ur.id}/reconcile`,{epoch:recovered.epoch});assert.equal(reconciled.effect,'verified');assert.equal(reconciled.outcomeCode,'RECONCILED');assert.equal((await records()).length,2);pass('An uncertain run older than 100 records recovers on restart; read-only UI reconciliation verifies it without resubmitting');
  for(const [scenario,button] of [['session_expired','Restore session'],['unexpected_dialog','Dismiss notice']] as const){
    const r=await done((await create('balance',scenario)).id);assert.equal(r.status,'awaiting_human');
    const human:Run=await request(`/api/runs/${r.id}/takeover`,{epoch:r.epoch});assert.equal(human.owner,'human');
    const frame=await request(`/api/runs/${r.id}/frame`);const s=server.engine.sessions.get(r.id)!;const box=await s.page.getByRole('button',{name:button,exact:true}).boundingBox();assert.ok(box);
    const input={epoch:human.epoch,frameRevision:frame.revision,commandId:randomUUID(),action:'click',x:box.x+box.width/2,y:box.y+box.height/2};
    await request(`/api/runs/${r.id}/input`,{...input,epoch:human.epoch-1},409);
    await request(`/api/runs/${r.id}/input`,input);
    await request(`/api/runs/${r.id}/input`,{...input,commandId:randomUUID()},409);
    await request(`/api/runs/${r.id}/resume`,{epoch:human.epoch});const resumed=await done(r.id);assert.equal(resumed.result,'succeeded',JSON.stringify(resumed));
  }
  pass('Same-browser human repair and handback work; stale ownership and frame inputs are rejected');
  const slow=await create('balance','slow');const running=await wait(slow.id,r=>r.status==='running');
  const stopped:Run=await request(`/api/runs/${slow.id}/stop`,{epoch:running.epoch});assert.equal(stopped.result,'cancelled');const steps=stopped.stepIndex;await new Promise(r=>setTimeout(r,400));assert.equal((await request(`/api/runs/${slow.id}`)).stepIndex,steps);pass('Stop drains the in-flight action and prevents subsequent actions');
  const race=await done((await create('balance','session_expired')).id),raceSession=server.engine.sessions.get(race.id)!;
  let release!:()=>void;raceSession.lock=new Promise<void>(resolve=>{release=resolve;});
  const older=server.engine.control(race.id,'takeover',{epoch:race.epoch}).then(()=>null,error=>error);
  const newer=server.engine.control(race.id,'stop',{epoch:server.engine.get(race.id).epoch});
  release();assert.equal((await older)?.statusCode,409);assert.equal((await newer).result,'cancelled');assert.equal(server.engine.get(race.id).status,'completed');pass('A stale takeover cannot resurrect a run after a newer Stop request');
  const key=randomUUID(),body={task:'balance',scenario:'slow',idempotencyKey:key};const one:Run=await request('/api/runs',body),two:Run=await request('/api/runs',body);assert.equal(one.id,two.id);await request('/api/runs',{...body,task:'prepare'},409);const duplicate=await done(one.id);assert.equal(duplicate.result,'succeeded');pass('Duplicate launch requests reuse the same run; conflicting request keys are rejected');
  const cross=await fetch(server.url+'/api/runs',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(cross.status,403);pass('Local server rejects foreign-origin mutation requests');
  assert.ok(server.store.runs().length>=12);assert.ok(server.store.capability('lab-balance-us-v1')!.successCount>=5);pass('Run history, outputs and capability validation counters persist in SQLite');
  console.log(`\n${checks} integration checks passed against real sandboxed Chrome and local services.`);
}finally{await server.close();await rm(dataPath,{recursive:true,force:true});}
