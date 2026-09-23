import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from '../src/server/index.js';
import type { AppState, Run, TaskKind } from '../src/shared/contracts.js';

const usage=`Real Mifos UI verification (local fictional fixtures only).
  npm run test:mifos                         10 baseline checks, no model calls
  npm run test:mifos -- --discover            Baseline + balance discovery/replay
  npm run test:mifos -- --discover-apps       Baseline + all three discovery/replay pairs (16 checks)
  npm run test:mifos -- --discover-apps --discover-only --task=prepare

--discover-only skips the baseline for an authorized live-model iteration.
--task=balance|prepare|submit filters discovery only; prepare/submit require --discover-apps.
Discovery sends fictional UI data to OpenAI and may incur API charges. Submit creates
two pending synthetic savings applications, each behind its own exact-preview approval.
Each passed check is saved immediately in the printed verification.json path.`;

export function parseMifosFlags(args:string[]){
  const seen=new Set<string>();
  let discovery:'none'|'balance'|'all'='none',discoveryOnly=false,task:TaskKind|undefined,help=false;
  for(const arg of args){
    const key=arg.startsWith('--task=')?'--task':arg;
    if(seen.has(key))throw new Error(`Repeated option: ${key}`);
    seen.add(key);
    if(arg==='--help'){help=true;continue;}
    if(arg==='--discover'||arg==='--discover-apps'){
      if(discovery!=='none')throw new Error('Choose either --discover or --discover-apps, not both.');
      discovery=arg==='--discover'?'balance':'all';continue;
    }
    if(arg==='--discover-only'){discoveryOnly=true;continue;}
    if(arg.startsWith('--task=')){
      const value=arg.slice('--task='.length);
      if(!['balance','prepare','submit'].includes(value))throw new Error('--task must be balance, prepare, or submit.');
      task=value as TaskKind;continue;
    }
    throw new Error(`Unknown option: ${arg}. Use --help for supported options.`);
  }
  if(help&&args.length!==1)throw new Error('--help must be used by itself.');
  if(discovery==='none'&&(discoveryOnly||task))throw new Error('--discover-only and --task require --discover or --discover-apps.');
  if(discovery==='balance'&&task&&task!=='balance')throw new Error('--task=prepare and --task=submit require --discover-apps.');
  const discoveryTasks:TaskKind[]=discovery==='none'?[]:task?[task]:discovery==='balance'?['balance']:['balance','prepare','submit'];
  return {help,baseline:!discoveryOnly,discoveryTasks,expectedChecks:(discoveryOnly?0:10)+discoveryTasks.length*2};
}

async function main(args:string[]){
const options=parseMifosFlags(args);
if(options.help){console.log(usage);return;}

const { loadLocalEnv, localEnvironmentPath }=await import(new URL('../scripts/local-env.mjs',import.meta.url).href);
loadLocalEnv(localEnvironmentPath(resolve('.')));
const fixtures=JSON.parse(await readFile(resolve(process.env.MIFOS_FIXTURE_DIR||'.local/mifos','fixtures.json'),'utf8'));
const dataPath=resolve(`.local/validation/mifos-${Date.now()}`);
await mkdir(dataPath,{recursive:true,mode:0o700});
let server=await startWorkbench({port:24317,dataPath,target:'mifos'});
const verificationPath=resolve(dataPath,'verification.json');
console.log(`Progress evidence: ${verificationPath}`);
type RunEvidence=Pick<Run,'task'|'mode'|'modelCalls'|'status'|'result'|'effect'|'outcomeCode'|'discoveredCapabilityId'> & {runId:string;provider:string|null;model:string|null;output?:Run['output']};
const evidence:({check:string;at:string}&Partial<RunEvidence>)[]=[];
let target:AppState['target']|undefined,latestRun:Run|undefined;
function summarizeRun(run:Run):RunEvidence{
  const output=run.output?Object.fromEntries(['clientReference','accountReference','product','externalReference','applicationReference','currency','balance'].filter(key=>key in run.output!).map(key=>[key,run.output![key]])):undefined;
  return {runId:run.id,task:run.task,mode:run.mode,provider:run.provider??null,model:run.model??null,modelCalls:run.modelCalls,status:run.status,result:run.result,effect:run.effect,outcomeCode:run.outcomeCode,discoveredCapabilityId:run.discoveredCapabilityId,output};
}
async function saveProgress(status:'running'|'passed'|'failed',failure?:unknown){
  // Persist only explicit metadata and fictional business results; omit prompts,
  // screenshots, request headers, provider payloads, and error bodies.
  const report={schemaVersion:1,at:new Date().toISOString(),status,target,options,completedChecks:evidence.length,evidence,...(status==='failed'?{failure:{name:failure instanceof Error?failure.name:'Error',...(latestRun?{run:summarizeRun(latestRun)}:{})}}:{})};
  const temporary=`${verificationPath}.tmp`;
  await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await rename(temporary,verificationPath);
}
interface ObservedTargetRequest { method:string;path:string;policy:string; }
function monitorTargetRequests():ObservedTargetRequest[]{
  const requests:ObservedTargetRequest[]=[];
  const original=server.engine.profile.networkPolicy.bind(server.engine.profile);
  server.engine.profile.networkPolicy=request=>{
    const policy=original(request);requests.push({method:request.method(),path:new URL(request.url()).pathname,policy});return policy;
  };
  return requests;
}
let targetRequests=monitorTargetRequests();
async function request(path:string,body?:unknown,expected=200){
  const response=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(result&&typeof result.id==='string'&&typeof result.task==='string'&&typeof result.modelCalls==='number')latestRun=result;
  assert.equal(response.status,expected,JSON.stringify(result));return result;
}
async function create(task:TaskKind,member='10001',product='Everyday Savings',accountReference='',mode='replay',capabilityId?:string):Promise<Run>{
  return request('/api/runs',{mode,task,capabilityId,provider:'openai',inputs:{clientReference:member,accountReference,product,externalReference:`QA-${randomUUID().slice(0,12)}`},idempotencyKey:randomUUID()});
}
async function wait(id:string,timeout=90_000):Promise<Run>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const run:Run=await request(`/api/runs/${id}`);if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;await new Promise(r=>setTimeout(r,150));}
  throw new Error('Mifos run timed out: '+JSON.stringify(await request(`/api/runs/${id}`)));
}
function success(run:Run){assert.equal(run.result,'succeeded',JSON.stringify(run));assert.equal(run.targetId,'mifos-x');assert.equal(run.modelCalls,0);}
async function pass(check:string,run?:Run){evidence.push({check,at:new Date().toISOString(),...(run?summarizeRun(run):{})});await saveProgress('running');console.log(`✓ ${check}`);}
try{
  const state=await request('/api/state');assert.equal(state.target.id,'mifos-x');assert.ok(state.capabilities.every((c:{target:string})=>c.target==='mifos-x'));
  target=state.target;await saveProgress('running');
  if(options.baseline){
  await request('/api/runs',{mode:'replay',capabilityId:'lab-balance-us-v1',idempotencyKey:randomUUID()},409);
  await request('/api/runs',{scenario:'session_expired',idempotencyKey:randomUUID()},400);
  await pass('Workbench exposes Mifos capabilities and refuses lab contracts and injected lab scenarios');
  for(const fixture of fixtures.clients){
    const goal=`Look up member ${fixture.clientReference} and read their current savings balance for account ${fixture.accountReference}`;
    const plan=await request('/api/goals/resolve',{goal});assert.equal(plan.capabilityId,'mifos-balance-v1');
    const run=await wait((await request('/api/runs',{mode:'replay',goal,goalReviewed:true,task:plan.task,capabilityId:plan.capabilityId,inputs:plan.inputs,idempotencyKey:randomUUID()})).id);
    success(run);assert.equal(run.output?.currency,'USD');assert.equal(run.output?.accountReference,fixture.accountReference);assert.equal(run.output?.balance,fixture.initialBalance);
    await pass(`Visible Mifos UI verifies ${fixture.clientReference} / ${fixture.accountReference} USD balance with zero model calls`,run);
  }
  const memberOnly=await wait((await create('balance','10002','Everyday Savings')).id);
  success(memberOnly);assert.equal(memberOnly.inputs.accountReference,'');assert.equal(memberOnly.resolvedInputs?.accountReference,'SAV-1002');assert.equal(memberOnly.output?.balance,'840.00');
  await pass('A member-only balance goal resolves the unique Everyday Savings account from the actual Mifos member screen',memberOnly);
  // Both member and product change; no submission request is authorized by preparation.
  for(const [member,product] of [['10001','Growth Savings'],['10002','Everyday Savings']]){
    const requestStart=targetRequests.length;
    const run=await wait((await create('prepare',member,product)).id);success(run);assert.equal(run.effect,'none');assert.equal(run.output?.clientReference,member);assert.equal(run.output?.product,product);assert.equal(run.events.some(e=>e.kind==='commit_sent'),false);
    assert.equal(targetRequests.slice(requestStart).filter(request=>request.policy==='commit').length,0,'Preparation must not even request a savings application write');
    await pass(`Prepare ${product} for ${member} reaches the actual preview with zero savings submission requests`,run);
  }
  const submissionRequestStart=targetRequests.length;
  const awaiting=await wait((await create('submit','10002','Growth Savings')).id);
  assert.equal(awaiting.status,'awaiting_approval',JSON.stringify(awaiting));assert.equal(awaiting.effect,'none');assert.ok(awaiting.approval?.summary.previewText);
  await request(`/api/runs/${awaiting.id}/approve`,{epoch:awaiting.epoch-1,approvalId:awaiting.approval!.id},409);
  await request(`/api/runs/${awaiting.id}/approve`,{epoch:awaiting.epoch,approvalId:awaiting.approval!.id});
  const submitted=await wait(awaiting.id);success(submitted);assert.equal(submitted.effect,'verified');assert.equal(submitted.approval?.consumed,true);assert.equal(submitted.events.filter(e=>e.kind==='commit_sent').length,1);
  assert.equal(targetRequests.slice(submissionRequestStart).filter(request=>request.policy==='commit').length,1,'Exactly one savings submission request should reach the worker policy');
  await request(`/api/runs/${awaiting.id}/approve`,{epoch:awaiting.epoch,approvalId:awaiting.approval!.id},409);
  await pass('Exact-preview approval permits one real pending savings application; stale/reused approval is rejected',submitted);

  // Deliberate worker-state fault injection after a confirmed synthetic write.
  // This proves read-only recovery; it does not claim an actual target outage.
  function injectUnknown(id:string):Run{
    const saved=server.engine.get(id);
    saved.effect='unknown';saved.result='failed';saved.outcomeCode='OUTCOME_UNKNOWN';saved.output=undefined;
    saved.error='TEST INJECTION: confirmation deliberately hidden after a known accepted synthetic submission.';
    saved.events.push({id:saved.events.length+1,timestamp:new Date().toISOString(),kind:'test_injection',actor:'system',message:saved.error});
    server.store.saveRun(saved);return saved;
  }
  const actualApplicationReference=submitted.output!.applicationReference;
  const oldSession=server.engine.sessions.get(submitted.id)!;
  await oldSession.page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
  await oldSession.page.goto(`${server.targetUrl}/#/login`);
  await oldSession.page.locator('#login-form').waitFor({state:'visible'});
  const expired=injectUnknown(submitted.id),expiredRequestStart=targetRequests.length;
  const recoveredExpired:Run=await request(`/api/runs/${expired.id}/reconcile`,{epoch:expired.epoch});
  success(recoveredExpired);assert.equal(recoveredExpired.outcomeCode,'RECONCILED');assert.equal(recoveredExpired.effect,'verified');
  assert.equal(recoveredExpired.output?.applicationReference,actualApplicationReference);
  assert.equal(server.engine.sessions.get(expired.id)!.context===oldSession.context,false,'Recovery must replace an expired retained browser session');
  assert.equal(targetRequests.slice(expiredRequestStart).some(request=>request.policy==='commit'),false);
  assert.ok(targetRequests.slice(expiredRequestStart).every(request=>['read','authentication'].includes(request.policy)));
  await pass('Injected unknown outcome recovers through a fresh authenticated browser after retained login expiry, with zero submission requests',recoveredExpired);

  injectUnknown(submitted.id);
  await server.close();
  server=await startWorkbench({port:24317,dataPath,target:'mifos'});targetRequests=monitorTargetRequests();
  const restored:Run=await request(`/api/runs/${submitted.id}`);
  assert.equal(restored.effect,'unknown');assert.equal(restored.status,'completed');assert.equal(server.engine.sessions.has(restored.id),false);
  const reconciled:Run=await request(`/api/runs/${restored.id}/reconcile`,{epoch:restored.epoch});
  success(reconciled);assert.equal(reconciled.outcomeCode,'RECONCILED');assert.equal(reconciled.effect,'verified');
  assert.equal(reconciled.output?.applicationReference,actualApplicationReference);
  assert.equal(reconciled.events.filter(event=>event.kind==='commit_sent').length,1,'Recovery must preserve the sole original dispatch');
  assert.equal(targetRequests.some(request=>request.policy==='commit'),false,'Recovery after restart must never request another savings submission');
  assert.ok(targetRequests.every(request=>['read','authentication'].includes(request.policy)));
  await pass('Injected unknown outcome survives worker restart and reconciles the same real Mifos record using only read/authentication requests',reconciled);
  const prepared=await create('submit','10001','Growth Savings');const paused=await wait(prepared.id);assert.equal(paused.status,'awaiting_approval');
  const human:Run=await request(`/api/runs/${paused.id}/takeover`,{epoch:paused.epoch});assert.equal(human.owner,'human');assert.equal(human.approval,undefined);
  await request(`/api/runs/${paused.id}/approve`,{epoch:human.epoch,approvalId:paused.approval!.id},409);
  const stopped:Run=await request(`/api/runs/${human.id}/stop`,{epoch:human.epoch});assert.equal(stopped.result,'cancelled');assert.equal(stopped.effect,'none');
  await pass('Taking control of the actual Mifos session revokes approval; stopping leaves the draft unsubmitted',stopped);
  }
  if(options.discoveryTasks.includes('balance')){
    const discovery=await wait((await create('balance','10001','Everyday Savings','SAV-1001','discovery')).id,300_000);
    assert.equal(discovery.result,'succeeded',JSON.stringify(discovery));assert.ok(discovery.modelCalls>0);assert.ok(discovery.discoveredCapabilityId);await pass('Live model discovers a Mifos balance capability',discovery);
    const replay=await wait((await create('balance','10002','Everyday Savings','SAV-1002','replay',discovery.discoveredCapabilityId)).id);success(replay);assert.equal(replay.output?.balance,'840.00');
    const cap=await request(`/api/capabilities/${discovery.discoveredCapabilityId}`);assert.equal(cap.qualification.eligible,true,JSON.stringify(cap.qualification));
    await pass('Discovered Mifos contract replays the other member without a model',replay);
  }
    for(const task of options.discoveryTasks.filter((task):task is 'prepare'|'submit'=>task!=='balance')){
      const requestStart=targetRequests.length;
      let discovery=await wait((await create(task,'10001','Growth Savings','','discovery')).id,300_000);
      assert.ok(discovery.modelCalls>0,JSON.stringify(discovery));
      if(task==='submit'){
        assert.equal(discovery.status,'awaiting_approval',JSON.stringify(discovery));
        assert.ok(discovery.approval?.summary.previewText);
        assert.equal(targetRequests.slice(requestStart).filter(request=>request.policy==='commit').length,0,'Discovery must reach human approval before requesting a write');
        await request(`/api/runs/${discovery.id}/approve`,{epoch:discovery.epoch,approvalId:discovery.approval!.id});
        discovery=await wait(discovery.id,300_000);
      }
      assert.equal(discovery.result,'succeeded',JSON.stringify(discovery));
      assert.ok(discovery.discoveredCapabilityId,JSON.stringify(discovery));
      assert.equal(discovery.output?.clientReference,'10001');
      assert.equal(discovery.output?.product,'Growth Savings');
      assert.equal(discovery.output?.externalReference,discovery.inputs.externalReference);
      assert.equal(targetRequests.slice(requestStart).filter(request=>request.policy==='commit').length,task==='submit'?1:0);
      await pass(`Live model discovers Mifos ${task} for Growth Savings${task==='submit'?' with a separate exact-preview approval':''}`,discovery);

      // Preparation varies both member and product. Submission stays on Growth
      // so the active Everyday Savings fixtures remain unambiguous for lookups.
      const replayProduct=task==='prepare'?'Everyday Savings':'Growth Savings';
      const replayStart=targetRequests.length;
      let replay=await wait((await create(task,'10002',replayProduct,'','replay',discovery.discoveredCapabilityId)).id);
      assert.notEqual(replay.inputs.externalReference,discovery.inputs.externalReference);
      if(task==='submit'){
        assert.equal(replay.status,'awaiting_approval',JSON.stringify(replay));
        assert.notEqual(replay.approval?.id,discovery.approval?.id);
        assert.equal(targetRequests.slice(replayStart).filter(request=>request.policy==='commit').length,0);
        await request(`/api/runs/${replay.id}/approve`,{epoch:replay.epoch,approvalId:replay.approval!.id});
        replay=await wait(replay.id);
      }
      success(replay);
      assert.equal(replay.output?.clientReference,'10002');
      assert.equal(replay.output?.product,replayProduct);
      assert.equal(replay.output?.externalReference,replay.inputs.externalReference);
      assert.equal(targetRequests.slice(replayStart).filter(request=>request.policy==='commit').length,task==='submit'?1:0);
      const capability=await request(`/api/capabilities/${discovery.discoveredCapabilityId}`);
      assert.equal(capability.qualification.eligible,true,JSON.stringify(capability.qualification));
      assert.equal(capability.qualification.distinctMemberCount,2);
      assert.deepEqual([...capability.qualification.testedProducts].sort(),task==='prepare'?['Everyday Savings','Growth Savings']:['Growth Savings']);
      await pass(`Discovered Mifos ${task} replays another member and fresh reference${task==='prepare'?' with a changed product':''}, zero model calls${task==='submit'?', and its own approval':''}`,replay);
    }
  assert.equal(evidence.length,options.expectedChecks,'The selected verification plan must complete every expected check');
  await saveProgress('passed');
  console.log(`\n${evidence.length} real Mifos checks passed. Evidence: ${dataPath}`);
}catch(error){await saveProgress('failed',error);throw error;}finally{await server.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await main(process.argv.slice(2));
}
