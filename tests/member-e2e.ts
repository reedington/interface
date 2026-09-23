import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWorkbench } from '../src/server/index.js';
import type { Run, RunInputs } from '../src/shared/contracts.js';

// Real local Mifos only, with authored replay and no model requests. The sole
// accepted member remains in the synthetic local database for inspection.
const flags=process.argv.slice(2);
if(flags.includes('--help')){
  assert.deepEqual(flags,['--help']);
  console.log('npm run test:member [-- --reconcile]\nCreates one fictional member through the real Mifos UI, proves approval/duplicate/stop boundaries, and prepares savings without submitting it.\n--reconcile additionally hides the confirmed result in isolated worker history, restarts, and verifies read-only UI recovery. No model calls.');
  process.exit(0);
}
assert.ok(flags.length<=1&&flags.every(flag=>flag==='--reconcile'),'Only --reconcile or --help is supported.');
const { loadLocalEnv, localEnvironmentPath }=await import(new URL('../scripts/local-env.mjs',import.meta.url).href);
loadLocalEnv(localEnvironmentPath(resolve('.')));
const fixtures=JSON.parse(await readFile(resolve(process.env.MIFOS_FIXTURE_DIR||'.local/mifos','fixtures.json'),'utf8'));
assert.equal(fixtures.officeId,1,'Run npm run mifos:seed to verify the Head Office fixture binding first.');
const dataPath=resolve(`.local/validation/member-${Date.now()}-${randomUUID().slice(0,8)}`);
await mkdir(dataPath,{recursive:true,mode:0o700});
const evidencePath=resolve(dataPath,'verification.json');
let server=await startWorkbench({port:24327,dataPath,target:'mifos'});
let latestRun:Run|undefined;
const evidence:Array<Record<string,unknown>>=[];
type ObservedRequest={method:string;path:string;policy:string;member?:{externalId:unknown;firstname:unknown;lastname:unknown;officeId:unknown}};
let targetRequests:ObservedRequest[]=[];
function monitor(){
  const original=server.engine.profile.networkPolicy.bind(server.engine.profile);
  server.engine.profile.networkPolicy=request=>{
    const policy=original(request),path=new URL(request.url()).pathname;
    const item:ObservedRequest={method:request.method(),path,policy};
    if(policy==='commit'&&path.endsWith('/clients')){
      const body=request.postDataJSON();
      item.member={externalId:body.externalId,firstname:body.firstname,lastname:body.lastname,officeId:body.officeId};
    }
    targetRequests.push(item);return policy;
  };
}
monitor();
function summary(run:Run){
  const keys=['clientReference','memberAccountNumber','firstName','lastName','memberName','office','activationDate','externalReference','product','status'];
  const output=run.output?Object.fromEntries(keys.filter(key=>key in run.output!).map(key=>[key,run.output![key]])):undefined;
  return {runId:run.id,task:run.task,mode:run.mode,modelCalls:run.modelCalls,status:run.status,result:run.result,effect:run.effect,outcomeCode:run.outcomeCode,output};
}
async function persist(status:'running'|'passed'|'failed'){
  const temporary=`${evidencePath}.tmp`;
  await writeFile(temporary,JSON.stringify({schemaVersion:1,at:new Date().toISOString(),target:'mifos-x',status,evidence,...(status==='failed'&&latestRun?{lastRun:summary(latestRun)}:{})},null,2)+'\n',{mode:0o600});
  await rename(temporary,evidencePath);
}
async function pass(check:string,run:Run){evidence.push({check,...summary(run)});await persist('running');console.log(`✓ ${check}`);}
async function request(path:string,body?:unknown,expected=200){
  const response=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(result&&typeof result.id==='string'&&typeof result.modelCalls==='number')latestRun=result;
  assert.equal(response.status,expected,JSON.stringify(result));return result;
}
async function wait(id:string):Promise<Run>{
  const deadline=Date.now()+120_000;
  while(Date.now()<deadline){
    const run:Run=await request(`/api/runs/${id}`);
    if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`Member UI run timed out: ${id}`);
}
function input(firstName:string,lastName:string):RunInputs{
  return {clientReference:String(randomInt(100_000_000_000,999_999_999_999)),firstName,lastName,
    accountReference:'',product:'Growth Savings',externalReference:`MEMBER-QA-${randomUUID().slice(0,12)}`};
}
async function createMember(inputs:RunInputs):Promise<Run>{return request('/api/runs',{mode:'replay',task:'member',inputs,idempotencyKey:randomUUID()});}
function commits(start:number){return targetRequests.slice(start).filter(request=>request.policy==='commit');}
function verified(run:Run){assert.equal(run.result,'succeeded',JSON.stringify(run));assert.equal(run.targetId,'mifos-x');assert.equal(run.modelCalls,0);}
function exactMember(run:Run,inputs:RunInputs){
  assert.equal(run.output?.clientReference,inputs.clientReference);
  assert.equal(run.output?.firstName,inputs.firstName);
  assert.equal(run.output?.lastName,inputs.lastName);
  assert.equal(run.output?.status,'Active');
  assert.ok(run.output?.memberAccountNumber,'The persisted member must have a generated Mifos account number');
}

try{
  console.log(`Member verification evidence: ${evidencePath}`);await persist('running');
  const state=await request('/api/state');assert.equal(state.target.id,'mifos-x');
  assert.equal(state.capabilities.filter((cap:{task:string;target:string})=>cap.task==='member'&&cap.target==='mifos-x').length,1);
  const first=input('Avery','Parker'),initialRequest=targetRequests.length;
  const pending=await wait((await createMember(first)).id);
  assert.equal(pending.status,'awaiting_approval',JSON.stringify(pending));assert.equal(pending.effect,'none');assert.equal(pending.modelCalls,0);
  assert.ok(pending.approval);assert.equal(commits(initialRequest).length,0);
  const preview=JSON.stringify(pending.approval.summary);
  for(const value of [first.clientReference,first.firstName!,first.lastName!])assert.ok(preview.includes(value),'Exact member identity must appear in the bound approval preview');
  await request(`/api/runs/${pending.id}/approve`,{epoch:pending.epoch-1,approvalId:pending.approval.id},409);
  assert.equal(commits(initialRequest).length,0);
  await pass('New fictional member reaches an exact identity preview; no creation is sent before approval and stale approval is rejected',pending);

  await request(`/api/runs/${pending.id}/approve`,{epoch:pending.epoch,approvalId:pending.approval.id});
  const created=await wait(pending.id);verified(created);exactMember(created,first);
  assert.equal(created.effect,'verified');assert.equal(created.approval?.consumed,true);
  assert.equal(created.events.filter(event=>event.kind==='commit_sent').length,1);
  const creation=commits(initialRequest);assert.equal(creation.length,1);assert.equal(creation[0].method,'POST');assert.ok(creation[0].path.endsWith('/clients'));
  assert.deepEqual(creation[0].member,{externalId:first.clientReference,firstname:first.firstName,lastname:first.lastName,officeId:fixtures.officeId});
  await request(`/api/runs/${pending.id}/approve`,{epoch:created.epoch,approvalId:pending.approval.id},409);
  await pass('One approved UI request creates the exact member; persisted identity is verified and consumed approval cannot be reused',created);

  const duplicateStart=targetRequests.length;
  const duplicate=await wait((await createMember(first)).id);
  assert.equal(duplicate.effect,'none');assert.equal(duplicate.modelCalls,0);assert.notEqual(duplicate.status,'awaiting_approval');assert.notEqual(duplicate.result,'succeeded');
  assert.equal(commits(duplicateStart).length,0,'An existing member reference must be rejected before a duplicate creation request');
  assert.ok(duplicate.result==='business_outcome'||duplicate.status==='awaiting_human',JSON.stringify(duplicate));
  assert.ok(duplicate.outcomeCode==='MEMBER_REFERENCE_EXISTS'||duplicate.intervention?.reason.startsWith('MEMBER_REFERENCE_EXISTS:'),'The failure must explicitly identify the existing member reference, not an unrelated observation failure');
  await pass('Reusing the created member reference is rejected without a duplicate creation request',duplicate);

  const second=input('Jordan','Blake');assert.notEqual(second.clientReference,first.clientReference);
  const secondStart=targetRequests.length,secondPending=await wait((await createMember(second)).id);
  assert.equal(secondPending.status,'awaiting_approval',JSON.stringify(secondPending));assert.ok(secondPending.approval);
  const human:Run=await request(`/api/runs/${secondPending.id}/takeover`,{epoch:secondPending.epoch});
  assert.equal(human.owner,'human');assert.equal(human.approval,undefined);
  await request(`/api/runs/${human.id}/approve`,{epoch:human.epoch,approvalId:secondPending.approval.id},409);
  const stopped:Run=await request(`/api/runs/${human.id}/stop`,{epoch:human.epoch});
  assert.equal(stopped.result,'cancelled');assert.equal(stopped.effect,'none');assert.equal(stopped.modelCalls,0);assert.equal(commits(secondStart).length,0);
  await pass('A second member and name receive a separate preview; takeover revokes approval and Stop leaves that member uncreated',stopped);

  const prepareStart=targetRequests.length;
  const prepared=await wait((await request('/api/runs',{mode:'replay',task:'prepare',inputs:{...first,externalReference:`SAVINGS-QA-${randomUUID().slice(0,12)}`},idempotencyKey:randomUUID()})).id);
  verified(prepared);assert.equal(prepared.effect,'none');assert.equal(prepared.output?.clientReference,first.clientReference);assert.equal(prepared.output?.product,'Growth Savings');
  assert.equal(commits(prepareStart).length,0);assert.equal(prepared.events.some(event=>event.kind==='commit_sent'),false);
  await pass('The verified new member can immediately prepare Growth Savings and stop at review with no savings write',prepared);

  if(flags.includes('--reconcile')){
    // Explicit worker-state injection after a known accepted synthetic write;
    // this verifies recovery and does not claim a real Mifos service failure.
    const saved=server.engine.get(created.id);
    saved.effect='unknown';saved.result='failed';saved.outcomeCode='OUTCOME_UNKNOWN';saved.output=undefined;
    saved.error='TEST INJECTION: confirmed synthetic member result deliberately hidden before worker restart.';
    saved.events.push({id:saved.events.length+1,timestamp:new Date().toISOString(),kind:'test_injection',actor:'system',message:saved.error});
    server.store.saveRun(saved);await server.close();
    server=await startWorkbench({port:24327,dataPath,target:'mifos'});targetRequests=[];monitor();
    const restored:Run=await request(`/api/runs/${created.id}`);assert.equal(restored.effect,'unknown');assert.equal(server.engine.sessions.has(restored.id),false);
    const reconciled:Run=await request(`/api/runs/${restored.id}/reconcile`,{epoch:restored.epoch});
    verified(reconciled);exactMember(reconciled,first);assert.equal(reconciled.effect,'verified');assert.equal(reconciled.outcomeCode,'RECONCILED');
    assert.equal(reconciled.output?.memberAccountNumber,created.output?.memberAccountNumber,'Recovery must identify the original persisted member');
    assert.equal(reconciled.events.filter(event=>event.kind==='commit_sent').length,1);assert.equal(commits(0).length,0);
    assert.ok(targetRequests.every(request=>['read','authentication'].includes(request.policy)));
    await pass('Injected unknown member result survives worker restart and reconciles the same identity using only UI reads and authentication',reconciled);
  }
  assert.equal(evidence.length,flags.includes('--reconcile')?6:5);await persist('passed');
  console.log(`\n${evidence.length} real Mifos member checks passed. Fictional member retained: ${first.clientReference}. Evidence: ${evidencePath}`);
}catch(error){await persist('failed');throw error;}finally{await server.close();}
