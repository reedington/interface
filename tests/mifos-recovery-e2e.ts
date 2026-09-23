import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Locator} from 'playwright-core';
import {startWorkbench} from '../src/server/index.js';
import {makeRecord} from '../src/server/capabilities.js';
import {capabilitySchema,type Run,type RunInputs,type TaskKind} from '../src/shared/contracts.js';

if(process.argv.includes('--help')){
 console.log('INTERFACE_ENV_FILE=/absolute/path/to/isolated.env node --import tsx tests/mifos-recovery-e2e.ts\nUses an isolated local Mifos stack (never port4200). Verifies account selection and real manual repair/handback with no model calls. May create one approved pending synthetic savings application if needed.');
 process.exit(0);
}
assert.equal(process.argv.length,2,'Only --help is supported.');
assert.ok(process.env.INTERFACE_ENV_FILE,'Explicit isolated INTERFACE_ENV_FILE is required.');
const {loadLocalEnv,localEnvironmentPath}=await import(new URL('../scripts/local-env.mjs',import.meta.url).href);
loadLocalEnv(localEnvironmentPath(process.cwd()));
const targetUrl=new URL(process.env.MIFOS_URL!);
assert.ok(['127.0.0.1','localhost'].includes(targetUrl.hostname));
assert.notEqual(targetUrl.port,'4200','This harness refuses the live user stack.');
assert.notEqual(process.env.MIFOS_COMPOSE_PROJECT,'interface-mifos');
assert.ok(process.env.MIFOS_FIXTURE_DIR&&process.env.MIFOS_COMPOSE_PROJECT);
const fixtures=JSON.parse(await readFile(resolve(process.env.MIFOS_FIXTURE_DIR,'fixtures.json'),'utf8'));
assert.equal(fixtures.origin,targetUrl.origin);assert.equal(fixtures.composeProject,process.env.MIFOS_COMPOSE_PROJECT);
const dataPath=resolve(process.env.WORKBENCH_DATA_DIR||'.local/validation',`recovery-${Date.now()}-${randomUUID().slice(0,8)}`);
await mkdir(dataPath,{recursive:true,mode:0o700});
const evidencePath=resolve(dataPath,'verification.json');
const server=await startWorkbench({port:24337,target:'mifos',dataPath});
const evidence:Array<Record<string,unknown>>=[];
let latest:Run|undefined;
const requests:Array<{path:string;policy:string}>=[];
const originalPolicy=server.engine.profile.networkPolicy.bind(server.engine.profile);
server.engine.profile.networkPolicy=request=>{const policy=originalPolicy(request);requests.push({path:new URL(request.url()).pathname,policy});return policy;};
async function persist(status:'running'|'passed'|'failed'){
 const temporary=evidencePath+'.tmp';await writeFile(temporary,JSON.stringify({schemaVersion:1,status,targetOrigin:targetUrl.origin,at:new Date().toISOString(),evidence,...(status==='failed'&&latest?{lastRun:{id:latest.id,status:latest.status,outcomeCode:latest.outcomeCode,intervention:latest.intervention}}:{})},null,2)+'\n',{mode:0o600});await rename(temporary,evidencePath);
}
async function api(path:string,body?:unknown,expected=200):Promise<any>{
 const response=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();if(result?.id&&result?.task)latest=result;
 assert.equal(response.status,expected,JSON.stringify(result));return result;
}
async function wait(id:string):Promise<Run>{
 const deadline=Date.now()+90_000;
 while(Date.now()<deadline){const run:Run=await api(`/api/runs/${id}`);if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;await new Promise(r=>setTimeout(r,120));}
 throw new Error(`Run ${id} did not reach an action boundary.`);
}
async function create(task:TaskKind,patch:Partial<RunInputs>={},capabilityId?:string):Promise<Run>{
 return api('/api/runs',{task,mode:'replay',capabilityId,inputs:{clientReference:'10001',accountReference:'',product:'Everyday Savings',externalReference:`RECOVERY-${randomUUID().slice(0,10)}`,...patch},idempotencyKey:randomUUID()});
}
function success(run:Run){assert.equal(run.result,'succeeded',JSON.stringify(run));assert.equal(run.modelCalls,0);assert.equal(run.targetId,'mifos-x');}
async function pass(check:string,run:Run){evidence.push({check,runId:run.id,sessionId:run.sessionId,status:run.status,result:run.result,outcomeCode:run.outcomeCode,modelCalls:run.modelCalls,output:run.output});await persist('running');console.log(`✓ ${check}`);}
const commits=()=>requests.filter(request=>request.policy==='commit').length;
try{
 console.log(`Mifos recovery verification: ${evidencePath}`);await persist('running');
 let picker=await wait((await create('balance')).id);
 if(picker.result==='succeeded'){
  const before=commits(),pending=await wait((await create('submit')).id);
  assert.equal(pending.status,'awaiting_approval',JSON.stringify(pending));assert.equal(pending.effect,'none');assert.equal(commits(),before);assert.ok(pending.approval);
  assert.equal(pending.approval.summary.clientReference,'10001');assert.equal(pending.approval.summary.product,'Everyday Savings');
  await api(`/api/runs/${pending.id}/approve`,{epoch:pending.epoch,approvalId:pending.approval.id});
  const submitted=await wait(pending.id);success(submitted);assert.equal(submitted.effect,'verified');assert.equal(commits(),before+1);
  await pass('One exact approved UI submission supplies a second synthetic Everyday Savings account when needed',submitted);
  picker=await wait((await create('balance')).id);
 }
 assert.equal(picker.intervention?.code,'ACCOUNT_SELECTION_REQUIRED',JSON.stringify(picker));
 assert.equal(picker.status,'awaiting_human');assert.equal(picker.owner,'none');assert.equal(picker.effect,'none');assert.equal(picker.modelCalls,0);
 const selection=picker.intervention!.accountSelection!;assert.equal(selection.clientReference,'10001');assert.ok(selection.choices.length>=2);assert.ok(selection.choices.every(choice=>choice.product==='Everyday Savings'));
 const active=selection.choices.find(choice=>choice.accountReference==='SAV-1001');assert.equal(active?.status,'Active');
 const page=server.engine.sessions.get(picker.id)!.page,sessionId=picker.sessionId,beforeSelection=commits();
 await api(`/api/runs/${picker.id}/select-account`,{epoch:picker.epoch-1,accountReference:'SAV-1001'},409);
 await api(`/api/runs/${picker.id}/select-account`,{epoch:picker.epoch,accountReference:'SAV-1002'},400);
 await api(`/api/runs/${picker.id}/select-account`,{epoch:picker.epoch,accountReference:'SAV-9999'},400);
 assert.equal((await api(`/api/runs/${picker.id}`)).resolvedInputs?.accountReference,undefined);
 await api(`/api/runs/${picker.id}/select-account`,{epoch:picker.epoch,accountReference:'SAV-1001'});
 const selected=await wait(picker.id);success(selected);assert.equal(selected.sessionId,sessionId);assert.equal(server.engine.sessions.get(selected.id)!.page,page);
 assert.equal(selected.resolvedInputs?.accountReference,'SAV-1001');assert.equal(selected.output?.accountReference,'SAV-1001');assert.equal(selected.output?.balance,'12540.75');assert.equal(commits(),beforeSelection);
 await pass('Member-bound account picker rejects stale and foreign choices, then continues on the same browser with the chosen active balance',selected);

 // A deliberately damaged test-only contract puts a wrong external reference in
 // the real form. The real checkpoint must catch it; operator input repairs it.
 const source=server.store.capability('mifos-prepare-v1')!;
 const broken=capabilitySchema.parse({...source,id:'mifos-prepare-manual-repair-test',name:'Test-only external-reference repair',steps:source.steps.map(step=>step.id==='reference'?{...step,value:{source:'literal',value:'WRONG-REFERENCE'}}:step)});
 server.store.saveCapability(makeRecord(broken,'draft'));
 const desired=`REPAIRED-${randomUUID().slice(0,12)}`,repairStart=commits();
 const interrupted=await wait((await create('prepare',{clientReference:'10002',product:'Growth Savings',externalReference:desired},broken.id)).id);
 assert.equal(interrupted.status,'awaiting_human',JSON.stringify(interrupted));assert.equal(interrupted.intervention?.code,'OBSERVATION_FAILED');assert.match(interrupted.intervention!.reason,/preview external reference does not match/);
 const originalPage=server.engine.sessions.get(interrupted.id)!.page,originalSession=interrupted.sessionId;
 const human:Run=await api(`/api/runs/${interrupted.id}/takeover`,{epoch:interrupted.epoch});assert.equal(human.owner,'human');assert.equal(human.sessionId,originalSession);
 async function input(action:'click'|'key'|'type'|'scroll',values:Record<string,unknown>={}){
  const frame=await api(`/api/runs/${human.id}/frame`);
  return api(`/api/runs/${human.id}/input`,{epoch:human.epoch,frameRevision:frame.revision,commandId:randomUUID(),action,...values});
 }
 async function click(locator:Locator){
  await locator.waitFor({state:'visible',timeout:10_000});
  assert.equal(await locator.isEnabled(),true,'Manual repair only uses enabled controls.');
  let stableBox='';
  for(let i=0;i<12;i++){
   const box=await locator.boundingBox();assert.ok(box,'Visible operator target must have bounds.');
   const x=box.x+box.width/2,y=box.y+box.height/2;
   const hit=await locator.evaluate((element,{x,y})=>element.contains(document.elementFromPoint(x,y)),{x,y});
   const position=JSON.stringify(box);
   if(hit&&x>=0&&x<human.viewport.width&&y>=0&&y<human.viewport.height){
    if(position===stableBox){await input('click',{x:Math.round(x),y:Math.round(y)});return;}
    stableBox=position;await new Promise(r=>setTimeout(r,100));continue;
   }
   stableBox='';await input('scroll',{deltaY:y<human.viewport.height/2?-400:400});await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Manual target did not become stable and unobscured in the operator viewport.');
 }
 const activePanel='.mat-horizontal-stepper-content:not(.mat-horizontal-stepper-content-inactive)';
 // The pinned published UI disables Terms' Previous button. Its visible
 // Details step header is the supported way back to the reference field.
 await click(originalPage.getByRole('tab',{name:/DETAILS/i}));
 const reference=originalPage.locator(`${activePanel} mifosx-savings-account-details-step input[formcontrolname="externalId"]`);
 await click(reference);await input('key',{key:process.platform==='darwin'?'Meta+A':'Control+A'});await input('type',{text:desired});
 assert.equal(await reference.inputValue(),desired);
 for(const part of ['details','terms','charges'])await click(originalPage.locator(`${activePanel} mifosx-savings-account-${part}-step`).getByRole('button',{name:'Next',exact:true}));
 await api(`/api/runs/${human.id}/resume`,{epoch:human.epoch});
 const repaired=await wait(human.id);success(repaired);assert.equal(repaired.sessionId,originalSession);assert.equal(server.engine.sessions.get(repaired.id)!.page,originalPage);
 assert.equal(repaired.output?.externalReference,desired);assert.equal(repaired.output?.product,'Growth Savings');assert.equal(repaired.output?.clientReference,'10002');assert.equal(repaired.effect,'none');assert.equal(commits(),repairStart);assert.ok(repaired.events.some(event=>event.kind==='manual'));
 await pass('An actual wrong Mifos form value is repaired through humanInput and handed back in the same session, then verified with no commit or model calls',repaired);
 await persist('passed');console.log(`Passed ${evidence.length} checks. ${evidencePath}`);
}catch(error){await persist('failed');throw error;}finally{await server.close();}
