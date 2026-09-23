import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWorkbench } from '../src/server/index.js';
import type { CapabilityRecord, Run, RunInputs } from '../src/shared/contracts.js';

// Opt-in live qualification. Run only against a local stack whose visible
// data is entirely fictional: discovery can observe the existing member list,
// not merely the two fictional identities supplied below.
const flags=process.argv.slice(2);
if(flags.length===1&&flags[0]==='--help'){
  console.log('npm run test:member:discovery\nOpt-in; requires INTERFACE_ENV_FILE pointing to an isolated fictional stack. Use only a local stack whose visible data is entirely fictional, including its existing member list.\nLive OpenAI discovery of fictional member creation, then exact-artifact replay with a different name/reference. Sends Mifos UI data to OpenAI, incurs API charges, and creates two synthetic members after separate exact-preview approvals. Uses isolated worker port 24347. No baseline or reconciliation checks.');
  process.exit(0);
}
assert.equal(flags.length,0,'Only --help is supported.');
console.warn('Live OpenAI check: fictional Mifos UI data will be sent to OpenAI and API charges apply. A successful run creates two synthetic members with separate exact-preview approvals; records are retained for inspection.');
const { loadLocalEnv, localEnvironmentPath }=await import(new URL('../scripts/local-env.mjs',import.meta.url).href);
loadLocalEnv(localEnvironmentPath(process.cwd()));
// A separate existing provider config can supply only model credentials/settings;
// it cannot redirect the isolated target or get copied into the clean checkout.
if(process.env.INTERFACE_PROVIDER_ENV_FILE){
  const providerSettings:Record<string,string>={};
  loadLocalEnv(resolve(process.env.INTERFACE_PROVIDER_ENV_FILE),providerSettings);
  for(const [key,value] of Object.entries(providerSettings))if(/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_(API_KEY|MODEL|BASE_URL)$/.test(key))process.env[key]=value;
}
assert.ok(process.env.INTERFACE_ENV_FILE,'Use an explicit isolated environment file for live member discovery.');
assert.notEqual(new URL(process.env.MIFOS_URL||'http://127.0.0.1:4200').port,'4200','Live member discovery must use the isolated fictional target, not the user workbench.');
const fixtures=JSON.parse(await readFile(resolve(process.env.MIFOS_FIXTURE_DIR||'.local/mifos','fixtures.json'),'utf8'));
assert.equal(fixtures.officeId,1,'Run npm run mifos:seed to verify the local Head Office binding.');
const dataPath=resolve(`.local/validation/member-discovery-${Date.now()}`);
await mkdir(dataPath,{recursive:true,mode:0o700});
const evidencePath=resolve(dataPath,'verification.json');
const server=await startWorkbench({port:24347,dataPath,target:'mifos'});
let latestRun:Run|undefined;
let stage='configuration';
const evidence:Array<Record<string,unknown>>=[];
type TargetRequest={method:string;path:string;policy:string;member?:{externalId:unknown;firstname:unknown;lastname:unknown;officeId:unknown}};
const targetRequests:TargetRequest[]=[];
const originalPolicy=server.engine.profile.networkPolicy.bind(server.engine.profile);
server.engine.profile.networkPolicy=request=>{
  const policy=originalPolicy(request),path=new URL(request.url()).pathname;
  const item:TargetRequest={method:request.method(),path,policy};
  if(request.method()==='POST'&&path.endsWith('/clients')){
    const body=request.postDataJSON();
    item.member={externalId:body.externalId,firstname:body.firstname,lastname:body.lastname,officeId:body.officeId};
  }
  targetRequests.push(item);return policy;
};
function diagnostic(value:unknown):string|undefined{
  if(typeof value!=='string')return undefined;
  return value.replace(/\bsk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/\s+/g,' ').slice(0,1200);
}
function summary(run:Run){
  const keys=['clientReference','memberAccountNumber','firstName','lastName','memberName','office','activationDate','status'];
  const output=run.output?Object.fromEntries(keys.filter(key=>key in run.output!).map(key=>[key,run.output![key]])):undefined;
  return {runId:run.id,task:run.task,mode:run.mode,provider:run.provider??null,model:run.model??null,modelCalls:run.modelCalls,status:run.status,result:run.result,effect:run.effect,outcomeCode:run.outcomeCode,discoveredCapabilityId:run.discoveredCapabilityId,capabilityId:run.capabilityId,capabilityDigest:run.capabilityDigest,output,
    ...(run.intervention?{intervention:{code:run.intervention.code,reason:diagnostic(run.intervention.reason)}}:{}),...(run.error?{error:diagnostic(run.error)}:{})};
}
async function persist(status:'running'|'passed'|'failed',error?:unknown){
  const temporary=`${evidencePath}.tmp`;
  // Explicit run metadata and fictional identity only: no screenshots, prompts,
  // credentials, approval tokens, headers, or provider response bodies.
  const report={schemaVersion:1,at:new Date().toISOString(),target:'mifos-x',stage,status,evidence,...(latestRun?{latestRun:summary(latestRun)}:{}),...(error?{failure:{name:error instanceof Error?error.name:'Error',message:diagnostic(error instanceof Error?error.message:String(error))}}:{})};
  await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(temporary,evidencePath);
}
async function pass(check:string,run:Run,details:Record<string,unknown>={}){
  latestRun=run;evidence.push({at:new Date().toISOString(),check,...summary(run),...details});await persist('running');console.log(`✓ ${check}`);
}
async function request(path:string,body?:unknown){
  const response=await fetch(server.url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(result&&typeof result.id==='string'&&typeof result.modelCalls==='number')latestRun=result;
  if(response.status!==200)throw new Error(`Local worker ${path} returned HTTP ${response.status}: ${diagnostic(result.error)||'request rejected'}`);
  return result;
}
async function wait(id:string,timeout=300_000):Promise<Run>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const run:Run=await request(`/api/runs/${id}`);
    if(['completed','awaiting_human','awaiting_approval'].includes(run.status))return run;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`Member ${stage} timed out; inspect the latest run in verification.json.`);
}
function inputs(firstName:string,lastName:string):RunInputs{
  return {clientReference:String(randomInt(100_000_000_000,999_999_999_999)),firstName,lastName,accountReference:'',product:'Everyday Savings',externalReference:`MEMBER-DISC-${randomUUID().slice(0,12)}`};
}
async function create(input:RunInputs,mode:'discovery'|'replay',capabilityId?:string):Promise<Run>{
  return request('/api/runs',{mode,task:'member',goal:`Create a new member with first name "${input.firstName}" and last name "${input.lastName}", member reference ${input.clientReference}, after my approval`,goalReviewed:true,...(mode==='discovery'?{provider:'openai'}:{}),capabilityId,inputs:input,idempotencyKey:randomUUID()});
}
function clientPosts(start:number){return targetRequests.slice(start).filter(request=>request.method==='POST'&&request.path.endsWith('/clients'));}
function approval(run:Run,input:RunInputs,start:number){
  assert.equal(run.status,'awaiting_approval',`Expected approval during ${stage}; inspect saved intervention details.`);
  assert.equal(run.effect,'none');assert.ok(run.approval,'An exact-preview approval must be issued');
  for(const value of [input.clientReference,input.firstName!,input.lastName!])assert.ok(JSON.stringify(run.approval.summary).includes(value),'Approval preview must contain the requested identity');
  assert.equal(clientPosts(start).length,0,'No POST /clients is allowed before approval');
  assert.equal(targetRequests.slice(start).filter(request=>request.policy==='commit').length,0);
}
function created(run:Run,input:RunInputs,start:number){
  assert.equal(run.status,'completed');assert.equal(run.result,'succeeded',`Expected verified creation during ${stage}; inspect saved intervention details.`);
  assert.equal(run.targetId,'mifos-x');assert.equal(run.effect,'verified');assert.equal(run.approval?.consumed,true);
  assert.equal(run.output?.clientReference,input.clientReference);assert.equal(run.output?.firstName,input.firstName);assert.equal(run.output?.lastName,input.lastName);assert.equal(run.output?.status,'Active');
  assert.ok(run.output?.memberAccountNumber,'The created member must have a generated Mifos account number');
  assert.equal(run.events.filter(event=>event.kind==='commit_sent').length,1);
  const posts=clientPosts(start);assert.equal(posts.length,1);assert.equal(posts[0].policy,'commit');
  assert.deepEqual(posts[0].member,{externalId:input.clientReference,firstname:input.firstName,lastname:input.lastName,officeId:fixtures.officeId});
  assert.equal(targetRequests.slice(start).filter(request=>request.policy==='commit').length,1,'Only the one member creation may be committed');
}

try{
  console.log(`Member discovery evidence: ${evidencePath}`);await persist('running');
  const state=await request('/api/state');assert.equal(state.target.id,'mifos-x');
  assert.equal(state.providers.find((provider:{id:string})=>provider.id==='openai')?.configured,true,'Configure OpenAI before this live discovery check.');
  const first=inputs('Jordan','Ellis');stage='discovery preview';
  const discoveryStart=targetRequests.length;
  const pending=await wait((await create(first,'discovery')).id);
  approval(pending,first,discoveryStart);assert.ok(pending.modelCalls>0);assert.equal(pending.provider,'openai');assert.ok(pending.model);
  const callsAtApproval=pending.modelCalls;
  await pass('Live OpenAI member discovery reaches exact approval without sending a member creation',pending);

  stage='discovery creation';
  await request(`/api/runs/${pending.id}/approve`,{epoch:pending.epoch,approvalId:pending.approval!.id});
  const discovered=await wait(pending.id);created(discovered,first,discoveryStart);
  assert.equal(discovered.modelCalls,callsAtApproval,'Approving the retained proposal must not request another model action');
  assert.ok(discovered.discoveredCapabilityId);assert.equal(discovered.outcomeCode,'DISCOVERED');
  const artifact:CapabilityRecord=await request(`/api/capabilities/${discovered.discoveredCapabilityId}`);
  assert.equal(artifact.status,'draft');assert.equal(artifact.task,'member');assert.equal(artifact.target,'mifos-x');assert.equal(artifact.provenance.kind,'discovered');assert.equal(artifact.provenance.runId,discovered.id);
  assert.equal(artifact.provenance.provider,discovered.provider);assert.equal(artifact.provenance.model,discovered.model);
  const commitIndex=artifact.steps.findIndex(step=>step.effect==='commit');
  assert.equal(artifact.steps.filter(step=>step.effect==='commit').length,1);
  assert.ok(artifact.steps.some((step,index)=>step.checkpoint==='member_absent'&&index<commitIndex));
  assert.ok(artifact.steps.some((step,index)=>step.checkpoint==='member_preview'&&index<commitIndex));
  assert.equal(artifact.steps.at(-1)?.checkpoint,'member_created');
  for(const key of ['clientReference','firstName','lastName'])assert.ok(artifact.steps.some(step=>step.value?.source==='input'&&step.value.key===key),`The recorded contract must parameterize ${key}`);
  await pass('Approved discovery creates exactly one member and publishes a parameterized draft without another model call',discovered,{artifactId:artifact.id,artifactDigest:artifact.digest});

  const second=inputs('Casey','Morgan');assert.notEqual(second.clientReference,first.clientReference);assert.notEqual(second.firstName,first.firstName);assert.notEqual(second.lastName,first.lastName);
  stage='replay preview';const replayStart=targetRequests.length;
  const replayPending=await wait((await create(second,'replay',artifact.id)).id,120_000);
  approval(replayPending,second,replayStart);assert.equal(replayPending.modelCalls,0);assert.equal(replayPending.capabilityId,artifact.id);assert.equal(replayPending.capabilityDigest,artifact.digest);
  assert.notEqual(replayPending.approval!.id,pending.approval!.id);
  await pass('The exact recorded artifact replays a different name/reference with zero model calls and requires a new approval',replayPending);

  stage='replay creation';
  await request(`/api/runs/${replayPending.id}/approve`,{epoch:replayPending.epoch,approvalId:replayPending.approval!.id});
  const replayed=await wait(replayPending.id,120_000);created(replayed,second,replayStart);assert.equal(replayed.modelCalls,0);
  assert.equal((await request(`/api/runs/${discovered.id}`)).modelCalls,callsAtApproval);
  assert.notEqual(replayed.output?.memberAccountNumber,discovered.output?.memberAccountNumber);
  await pass('A separate approval creates exactly the second member with zero replay model calls',replayed);

  stage='qualification';
  const qualified:CapabilityRecord=await request(`/api/capabilities/${artifact.id}`);
  assert.equal(qualified.status,'draft');assert.equal(qualified.digest,artifact.digest);assert.equal(qualified.qualification?.eligible,true,'Different-member replay must qualify the exact discovered draft');
  assert.equal(qualified.qualification?.digestVerified,true);assert.equal(qualified.qualification?.distinctMemberCount,2);assert.equal(qualified.qualification?.discoveryRunId,discovered.id);
  assert.deepEqual(qualified.qualification?.replayRunIds,[replayed.id]);assert.deepEqual(qualified.qualification?.testedProducts,[]);
  assert.equal(qualified.qualification?.successfulReplays,1);assert.equal(qualified.qualification?.totalReplays,1);
  await pass('Qualification binds the exact artifact to two different member identities and contains no savings-product evidence',replayed,{qualification:qualified.qualification});
  assert.equal(evidence.length,5);stage='complete';await persist('passed');
  console.log(`\n5 live member discovery checks passed. Created fictional members ${first.clientReference} (Jordan Ellis) and ${second.clientReference} (Casey Morgan). Evidence: ${evidencePath}`);
}catch(error){await persist('failed',error);throw error;}finally{await server.close();}
