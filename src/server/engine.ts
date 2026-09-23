import { trackCursor, moveToControl, type CursorState } from './cursor.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { capabilitySchema, defaultGoals, inputSchema, type Capability, type CapabilityStep, type CreateRun, type DiscoveryBudget, type HumanInput, type Run, type RunInputs, type ProviderConfig, type TaskKind, type TargetLocator } from '../shared/contracts.js';
import { digest, makeRecord } from './capabilities.js';
import { Store } from './store.js';
import { launchBrowser, observe, uniqueLocator } from './surface.js';
import { proposeAction, resolveProviderConfig } from './providers.js';
import { reviewedGoalProblem } from './goals.js';
import { createLabProfile } from './targets/lab.js';
import { AccountSelectionRequired, TargetBusinessError, type Checkpoint, type TargetProfile } from './targets/types.js';
import { validateFinalOutput, validateTaskInputs, OutputContractError } from './output-contracts.js';
import { evidenceScreenshot, evidenceStructure, openPrivate, readStateKey } from './privacy.js';

const now=()=>new Date().toISOString();
const endpointFor=(task:TaskKind):Checkpoint=>task==='member'?'member_created':task==='balance'?'account':task==='prepare'?'preview':'submitted';
const previewFor=(task:TaskKind):Checkpoint=>task==='member'?'member_preview':'preview';
export const discoveryLimits = Object.freeze({maxModelCalls:30,maxActions:24,maxActiveMs:300_000,maxUnchangedObservations:4,maxConsecutiveWaits:3});
export class ActionError extends Error {constructor(message:string,public statusCode=409){super(message);}}
class Halt extends Error {}
interface Session {
  run:Run;page:Page;context:BrowserContext;capability?:Capability;config?:ProviderConfig;
  lock:Promise<unknown>;driving:boolean;haltRequested:boolean;permitCommit:boolean;
  approvedDigest?:string;commands:Set<string>;recorded:CapabilityStep[];
  history:Array<{action:string;reason:string}>;assisted:boolean;
  pendingProposal?:AbortController;pendingStep?:CapabilityStep;
  discoveryStepStarted?:number;lastObservationHash?:string;
  initializing?:boolean;commitSummary?:Record<string,string>;
  cursor?:CursorState;
  frame?:{dataUrl:string;revision:number;at:string;width:number;height:number;hash:string};
}
export class Engine {
  runs=new Map<string,Run>(); sessions=new Map<string,Session>();
  private browser?:Browser; private browserPromise?:Promise<Browser>;
  private closing=false;
  readonly profile:TargetProfile;
  readonly targetUrl:string;
  constructor(public store:Store,target:string|TargetProfile) {
    this.profile=typeof target==='string'?createLabProfile(target):target;this.targetUrl=this.profile.baseUrl;
    for(const r of store.runs())if((r.targetId||'local-banking-lab')===this.profile.id)this.runs.set(r.id,r);
  }
  private persist(r:Run) {r.updatedAt=now();this.store.saveRun(r);}
  private event(r:Run,kind:string,message:string,actor:'automation'|'human'|'system'='system') {
    r.events.push({id:r.events.length+1,timestamp:now(),kind,message,actor});this.persist(r);
  }
  get(id:string):Run {const r=this.runs.get(id)||this.store.run(id);if(!r||(r.targetId||'local-banking-lab')!==this.profile.id)throw new ActionError('Run not found for this application.',404);return r;}
  private session(id:string):Session {const s=this.sessions.get(id);if(!s)throw new ActionError('The browser session is no longer available. Start a new run.');return s;}
  private async serial<T>(s:Session,fn:()=>Promise<T>):Promise<T> {
    const task=s.lock.then(fn,fn);s.lock=task.catch(()=>{});return task;
  }
  async create(input:CreateRun):Promise<Run> {
    const hash=digest(input);const old=this.store.request(input.idempotencyKey);
    if(old){if(old.body_hash!==hash)throw new ActionError('This request key was already used with different inputs.');return this.get(old.run_id);}
    if([...this.runs.values()].filter(r=>r.status!=='completed').length>=2)throw new ActionError('Two local sessions are active. Finish or stop one before starting another.');
    const cap=input.mode==='replay'?this.store.capability(input.capabilityId||this.profile.capabilities().find(c=>c.task===input.task)?.id||''):undefined;
    if(input.mode==='replay'&&(!cap||cap.status==='quarantined'||cap.target!==this.profile.id))throw new ActionError('Choose an available capability for the current application.');
    if(this.profile.id==='mifos-x'&&input.scenario!=='normal')throw new ActionError('Fault-injection scenarios are available in the explicit local lab, not the real Mifos application.',400);
    const task=cap?.task||input.task;
    try{validateTaskInputs(task,input.inputs);}catch{throw new ActionError('Required inputs for this operation are missing or invalid.',400);}
    if(task==='member'&&(this.profile.id!=='mifos-x'||!input.inputs.firstName||!input.inputs.lastName))throw new ActionError('New member creation requires local Mifos, a first name, a last name, and a new member reference.',400);
    if(input.goalReviewed){
      if(!input.goal)throw new ActionError('Review a natural-language goal before starting.',400);
      const problem=reviewedGoalProblem(input.goal,task,input.inputs);if(problem)throw new ActionError(problem,400);
    }
    const config=input.mode==='discovery'?resolveProviderConfig(input.provider,input.model):undefined;
    const r:Run={id:randomUUID(),mode:input.mode,task,goal:input.goal||defaultGoals[task],capabilityId:cap?.id,capabilityDigest:cap?.digest,status:'queued',effect:'none',inputs:input.inputs,scenario:input.scenario,createdAt:now(),updatedAt:now(),sessionId:randomUUID(),owner:'automation',epoch:1,stepIndex:0,steps:cap?.steps.map(s=>({id:s.id,label:s.label,state:'pending'}))||[],events:[],frameRevision:0,viewport:{width:1120,height:760},provider:config?.provider,model:config?.model,modelCalls:0,...(config?{discoveryBudget:{...discoveryLimits,actions:0,activeMs:0,unchangedObservations:0,consecutiveWaits:0}}:{})};
    r.targetId=this.profile.id;
    this.runs.set(r.id,r);this.store.saveRun(r);this.store.saveRequest(input.idempotencyKey,r.id,hash);
    this.event(r,'created',`${input.mode==='replay'?'Deterministic replay':'Model discovery'} requested for synthetic records.`);
    void this.start(r,cap,config).catch(error=>{if(!(error instanceof Halt))this.finish(r,'failed','START_FAILED',String(error.message||error));});
    return r;
  }
  private async start(r:Run,capability?:Capability,config?:ProviderConfig) {
    this.browserPromise??=launchBrowser().catch(e=>{this.browserPromise=undefined;throw e;});
    this.browser=await this.browserPromise;
    if(r.status==='completed'||this.closing)return;
    // Retain a small set of completed sessions for inspection; history stays durable.
    for(const [id,old] of this.sessions) if(this.sessions.size>=6&&old.run.status==='completed') {await old.context.close();this.sessions.delete(id);}
    const context=await this.browser.newContext({viewport:r.viewport,acceptDownloads:false,serviceWorkers:'block',locale:'en-US',timezoneId:'America/New_York'});
    const page=await context.newPage();page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(12000);
    const s:Session={run:r,page,context,capability,config,lock:Promise.resolve(),driving:false,haltRequested:false,permitCommit:false,commands:new Set(),recorded:[{id:'open',label:'Open the banking application',action:'navigate',path:this.profile.entryPath,effect:'read'}],history:[],assisted:false};
    s.cursor=await trackCursor(page);
    this.sessions.set(r.id,s);
    await context.route('**/*',async route=>{
      const request=route.request();let url:URL;try{url=new URL(request.url());}catch{return route.abort();}
      if(url.origin!==this.targetUrl){this.event(r,'policy','Blocked navigation or network access outside the local target.');return route.abort('blockedbyclient');}
      const policy=this.profile.networkPolicy(request);
      if(policy==='deny'||(policy==='authentication'&&!s.initializing&&r.owner!=='human')){this.event(r,'policy',`Blocked unregistered ${request.method()} action at ${url.pathname.slice(0,180)}.`);return route.abort('blockedbyclient');}
      if(policy==='commit') {
        if(!s.permitCommit||s.haltRequested||r.owner!=='automation'||r.status!=='running'){this.event(r,'policy','Blocked submission without an active single-use approval.');return route.abort('blockedbyclient');}
        if(this.profile.validateCommit&&!this.profile.validateCommit(request,r.inputs,s.commitSummary||{})){s.permitCommit=false;this.event(r,'policy','Blocked submission that differs from the approved target request.');return route.abort('blockedbyclient');}
        s.permitCommit=false;
        // Durable intent precedes the external request. A crash after this point is ambiguous.
        r.effect='unknown';this.event(r,'commit_sent','Submission dispatched. Confirmation is still required.');
      }
      await route.continue();
    });
    page.on('dialog',dialog=>{void dialog.dismiss();this.event(r,'policy','Dismissed an unexpected browser dialog.');});
    await this.serial(s,async()=>{
      if(s.haltRequested||(r.status as string)==='completed')return;
      r.status='running';s.initializing=true;this.persist(r);
      try {await this.profile.bootstrap(page,r.scenario,()=>this.assertAutomation(s));}
      catch(error){if(error instanceof Halt)throw error;this.intervene(s,'TARGET_NOT_READY',error instanceof Error?error.message:'The target could not be opened.');}
      finally{s.initializing=false;await this.capture(s);}
    });
    void this.drive(s);
  }
  private assertAutomation(s:Session) {if(s.haltRequested||s.run.owner!=='automation'||s.run.status!=='running')throw new Halt();}
  private async drive(s:Session) {
    if(s.driving)return;s.driving=true;
    try {
      while(s.run.status==='running'&&s.run.owner==='automation'&&!s.haltRequested) {
        await this.serial(s,async()=>{
          this.assertAutomation(s);
          if(this.profile.resolveInputs){
            const current={...s.run.inputs,...s.run.resolvedInputs};
            const observed=await this.profile.resolveInputs(s.page,s.run.task,current);
            this.assertAutomation(s);
            const missing=Object.fromEntries(Object.entries(observed).filter(([key,value])=>value!==undefined&&!current[key as keyof RunInputs]));
            if(Object.keys(missing).length){inputSchema.parse({...current,...missing});s.run.resolvedInputs={...s.run.resolvedInputs,...missing};this.event(s.run,'input_resolved','Resolved missing operation values from the visible application form.');}
          }
          if(await this.detectState(s))return;
          if(s.run.mode==='replay')await this.replayStep(s);else await this.discoveryStep(s);
          await this.capture(s);
        });
      }
    } catch(error) {
      // A late failure must not replace a newer pause, stop, takeover or shutdown.
      if(!(error instanceof Halt)&&!s.haltRequested&&s.run.owner==='automation'&&s.run.status==='running') {
        if(s.run.effect==='unknown')this.finish(s.run,'failed','OUTCOME_UNKNOWN','Submission may have succeeded. Reconcile the application before taking another business action.');
        else if(error instanceof TargetBusinessError)this.finish(s.run,'business_outcome',error.code,error.message,{status:error.code.toLowerCase()});
        else if(error instanceof AccountSelectionRequired)this.requestAccountSelection(s,error);
        else this.intervene(s,error instanceof OutputContractError?error.code:'OBSERVATION_FAILED',error instanceof Error?error.message:'The browser action could not be verified.');
      }
    } finally {s.driving=false;}
  }
  private async detectState(s:Session):Promise<boolean> {
    const state=await this.profile.detectState(s.page);if(!state)return false;
    this.assertAutomation(s);
    if(state.kind==='business')this.finish(s.run,'business_outcome',state.code,state.message,{status:state.code.toLowerCase()});
    else if(state.kind==='unknown')this.finish(s.run,'failed',state.code,state.message);
    else this.intervene(s,state.code,state.message);
    return true;
  }
  private intervene(s:Session,code:string,reason:string) {
    if(s.haltRequested||s.run.owner!=='automation'||s.run.status!=='running')return;
    s.run.status='awaiting_human';s.run.owner='none';s.run.epoch++;s.approvedDigest=undefined;s.run.approval=undefined;s.pendingStep=undefined;
    s.run.intervention={code,reason,createdAt:now()};this.event(s.run,'intervention',reason);
  }
  private requestAccountSelection(s:Session,error:AccountSelectionRequired){
    s.run.status='awaiting_human';s.run.owner='none';s.run.epoch++;s.haltRequested=false;
    s.approvedDigest=undefined;s.run.approval=undefined;s.pendingStep=undefined;
    s.run.intervention={code:'ACCOUNT_SELECTION_REQUIRED',reason:'Choose the savings account to read for this member.',createdAt:now(),accountSelection:{clientReference:error.boundClientReference,choices:error.choices}};
    this.event(s.run,'intervention','An explicit account choice is required before continuing.');
  }
  async selectAccount(id:string,body:{epoch:number;accountReference:string}):Promise<Run>{
    const s=this.session(id),r=s.run;
    return this.serial(s,async()=>{
      this.checkEpoch(r,body.epoch);
      const selection=r.intervention?.accountSelection;
      if(r.task!=='balance'||r.status!=='awaiting_human'||r.owner!=='none'||r.effect!=='none'||!selection||!this.profile.listAccountChoices)throw new ActionError('This run is not waiting for an account choice.');
      if(r.inputs.accountReference||selection.clientReference!==r.inputs.clientReference)throw new ActionError('The account request no longer matches this member.');
      if(!selection.choices.some(choice=>choice.accountReference===body.accountReference))throw new ActionError('Choose an account from the current member’s displayed choices.',400);
      const fresh=await this.profile.listAccountChoices(s.page,r.inputs);
      this.checkEpoch(r,body.epoch);
      if(!fresh.some(choice=>choice.accountReference===body.accountReference)){
        if(!fresh.length)this.finish(r,'business_outcome','NO_SAVINGS_ACCOUNT','The verified member no longer has a matching savings account.',{status:'no_savings_account'});
        else this.requestAccountSelection(s,new AccountSelectionRequired(r.inputs.clientReference,fresh));
        return r;
      }
      r.resolvedInputs={...r.resolvedInputs,accountReference:body.accountReference};
      r.owner='automation';r.status='running';r.epoch++;r.intervention=undefined;s.haltRequested=false;
      this.event(r,'account_selected','The operator selected an account from a freshly verified member account list.','human');
      setImmediate(()=>void this.drive(s));return r;
    });
  }
  private validatedOutput(r:Run,output:unknown){
    return validateFinalOutput({task:r.task,targetId:this.profile.id,inputs:r.inputs,resolvedInputs:r.resolvedInputs,output,declaredOutput:r.capabilityId?this.store.capability(r.capabilityId)?.output:undefined});
  }
  private finish(r:Run,result:Run['result'],outcomeCode:string,error?:string,output?:Record<string,unknown>) {
    if(r.status==='completed')return;
    if(result==='succeeded')output=this.validatedOutput(r,output||r.output);
    r.status='completed';r.result=result;r.outcomeCode=outcomeCode;r.error=error;r.output=output||r.output;r.finishedAt=now();r.owner='none';r.epoch++;r.intervention=undefined;
    if(r.capabilityId){const cap=this.store.capability(r.capabilityId);if(cap){cap.replayCount++;if(result==='succeeded')cap.successCount++;this.store.saveCapability(cap);}}
    this.event(r,'finished',error||`Run finished: ${outcomeCode}.`);
    const s=this.sessions.get(r.id);if(s)void this.capture(s).catch(()=>{});
  }
  private async replayStep(s:Session) {
    const r=s.run;const step=s.capability!.steps[r.stepIndex];
    if(!step){r.output=await this.checkpoint(s,endpointFor(r.task));this.finish(r,'succeeded','VERIFIED');return;}
    r.steps[r.stepIndex].state='running';this.persist(r);
    const complete=await this.execute(s,step);
    if(!complete){r.steps[r.stepIndex].state='waiting';this.persist(r);return;}
    r.steps[r.stepIndex].state='verified';r.stepIndex++;
    this.event(r,'step',step.label,'automation');
    if(r.stepIndex===s.capability!.steps.length){r.output=await this.checkpoint(s,endpointFor(r.task));this.finish(r,'succeeded','VERIFIED');}
  }
  private async execute(s:Session,step:CapabilityStep):Promise<boolean> {
    this.assertAutomation(s);const r=s.run;
    if(step.action==='navigate') {
      if(step.path!==this.profile.entryPath)throw new ActionError('Only the registered target entry point is permitted.');
      // A session starts at this route already; avoid resetting repaired login/fault state.
      return true;
    }
    if(step.action==='checkpoint'){r.output=await this.checkpoint(s,step.checkpoint!);this.persist(r);return true;}
    if(!step.target)throw new Error('The capability step has no target locator.');
    const loc=await uniqueLocator(s.page,step.target,{...r.inputs,...r.resolvedInputs});
    const commit=step.effect==='commit'||await this.profile.isCommitTarget(s.page,loc);
    if(commit) {
      if(!['submit','member'].includes(r.task))throw new ActionError('This capability cannot submit records.');
      const summary=await this.checkpoint(s,previewFor(r.task)) as Record<string,string>;
      s.commitSummary=summary;
      this.assertAutomation(s);
      const bound=digest({sessionId:r.sessionId,epoch:r.epoch,capability:r.capabilityDigest||r.task,inputs:r.inputs,summary});
      if(s.approvedDigest!==bound||!r.approval||r.approval.consumed||Date.parse(r.approval.expiresAt)<Date.now()) {
        r.epoch++;r.owner='none';r.status='awaiting_approval';
        r.approval={id:randomUUID(),digest:digest({sessionId:r.sessionId,epoch:r.epoch,capability:r.capabilityDigest||r.task,inputs:r.inputs,summary}),summary,expiresAt:new Date(Date.now()+5*60_000).toISOString(),consumed:false};
        this.event(r,'approval',r.task==='member'?'Review the exact new member details before approving creation.':'Review the exact client, product and reference before approving submission.');return false;
      }
      r.approval.consumed=true;s.approvedDigest=undefined;this.event(r,'approval_consumed','Single-use submission approval consumed.');
    }
    this.assertAutomation(s);
    if(r.mode==='discovery'&&!this.discoveryGuard(s,'action'))throw new Halt();
    const value=step.value?.source==='input'?({...r.inputs,...r.resolvedInputs})[step.value.key]:step.value?.value;
    try {
      if(['click','fill','select'].includes(step.action)){await this.capture(s,false);await moveToControl(s.page,loc,s.cursor,()=>this.assertAutomation(s));}
      if(commit)s.permitCommit=true;
      if(step.action==='click')await loc.click();
      else if(step.action==='fill'){if(value===undefined)throw new Error('Missing fill value.');await loc.fill(value);}
      else if(step.action==='select'){if(value===undefined)throw new Error('Missing select value.');if(await loc.evaluate(el=>el.tagName.toLowerCase()==='select'))await loc.selectOption({label:value});else {await loc.click();this.assertAutomation(s);const option=s.page.getByRole('option',{name:value,exact:true});await option.waitFor({state:'visible'});if(await option.count()!==1)throw new Error('The requested option is not unique.');this.assertAutomation(s);await moveToControl(s.page,option,s.cursor,()=>this.assertAutomation(s));await option.click();}}
      else if(step.action==='press'){if(!['Enter','Tab','Shift+Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(value||''))throw new Error('Unsupported key.');await loc.press(value!);}
      await s.page.waitForLoadState('domcontentloaded');
    } finally {s.permitCommit=false;}
    this.assertAutomation(s);
    await this.profile.awaitObservationReady?.(s.page,step,{...r.inputs,...r.resolvedInputs});
    this.assertAutomation(s);
    return true;
  }
  private async checkpoint(s:Session,name:Checkpoint):Promise<Record<string,unknown>> {
    const r=s.run;
    if(name==='member_created'&&r.effect==='none')throw new ActionError('A new member cannot be reported as created without an approved creation request.');
    const result=await this.profile.checkpoint(s.page,name,r.inputs,r.resolvedInputs);
    if(name==='client'&&r.task==='balance'&&!r.inputs.accountReference&&!r.resolvedInputs?.accountReference&&this.profile.resolveAccount){
      const accountReference=await this.profile.resolveAccount(s.page,r.inputs);
      r.resolvedInputs={...r.resolvedInputs,accountReference};
      this.event(r,'account_resolved','Resolved the requested member’s savings account through the visible application.');
    }
    if(name===endpointFor(r.task))this.validatedOutput(r,result);
    if(name==='submitted'||name==='member_created')r.effect='verified';
    return result;
  }
  private parameterize(target:TargetLocator,r:Run):TargetLocator {
    return this.profile.parameterize(target,r.inputs,r.resolvedInputs);
  }
  private budget(s:Session):DiscoveryBudget {
    return s.run.discoveryBudget??={...discoveryLimits,actions:0,activeMs:0,unchangedObservations:0,consecutiveWaits:0};
  }
  private remainingDiscoveryMs(s:Session):number {
    return this.budget(s).maxActiveMs-this.budget(s).activeMs-(s.discoveryStepStarted===undefined?0:performance.now()-s.discoveryStepStarted);
  }
  private discoveryGuard(s:Session,kind?:'model'|'action'):boolean {
    const budget=this.budget(s);
    if(this.remainingDiscoveryMs(s)<=0){this.intervene(s,'DISCOVERY_TIME_LIMIT','Discovery reached its active-time budget. Inspect or repair this session; a new run is required for more automated discovery.');return false;}
    if(kind==='model'&&s.run.modelCalls>=budget.maxModelCalls){this.intervene(s,'DISCOVERY_MODEL_LIMIT',`Discovery reached its ${budget.maxModelCalls}-call budget. Inspect or repair this session; a new run is required for more model calls.`);return false;}
    if(kind==='action'&&budget.actions>=budget.maxActions){this.intervene(s,'DISCOVERY_ACTION_LIMIT',`Discovery reached its ${budget.maxActions}-action budget. Inspect or repair this session; a new run is required for more automated actions.`);return false;}
    return true;
  }
  private recordDiscoveredStep(s:Session,step:CapabilityStep) {
    s.recorded.push(step);s.run.steps.push({id:step.id,label:step.label,state:'verified'});s.run.stepIndex++;
    this.budget(s).actions++;this.event(s.run,'step',step.label,'automation');
  }
  private async discoveryStep(s:Session) {
    s.discoveryStepStarted=performance.now();
    try {await this.discover(s);}
    finally {
      this.budget(s).activeMs+=Math.max(0,Math.ceil(performance.now()-s.discoveryStepStarted));
      s.discoveryStepStarted=undefined;this.persist(s.run);
    }
  }
  private async discover(s:Session) {
    const r=s.run;
    // Finish only after the runtime independently verifies the business checkpoint.
    const endpoint=endpointFor(r.task);
    if(await this.profile.atCheckpoint(s.page,endpoint)) {
      r.output=await this.checkpoint(s,endpoint);
      if(s.assisted){this.event(r,'artifact_withheld','The outcome is verified, but this assisted session contains unrecorded human actions. No replay artifact was published.');this.finish(r,'succeeded','VERIFIED_ASSISTED');return;}
      s.recorded.push({id:`verify-${endpoint}`,label:`Verify ${endpoint}`,action:'checkpoint',checkpoint:endpoint,effect:'read'});
      const c=makeRecord(capabilitySchema.parse({schemaVersion:1,id:`discovered-${r.id.slice(0,8)}`,version:'1.1.0',name:`Discovered ${r.task} workflow`,description:'Recorded from a live model-guided session. Validate with deterministic replay before approving.',task:r.task,target:this.profile.id,inputs:'banking-inputs-v1',output:`${r.task==='member'?'member':r.task==='balance'?'balance':r.task==='prepare'?'prepared':'submitted'}-v1`,steps:s.recorded,provenance:{kind:'discovered',runId:r.id,provider:r.provider,model:r.model}}));
      this.store.saveCapability(c);r.discoveredCapabilityId=c.id;this.finish(r,'succeeded','DISCOVERED');return;
    }
    // A human can repair an exhausted run to its verified end state, but cannot
    // reset its finite automation budget by repeatedly pressing Resume.
    if(!this.discoveryGuard(s))return;
    if(s.pendingStep) {
      if(!this.discoveryGuard(s,'action'))return;
      const step=s.pendingStep;
      // execute rechecks the observed locator, exact preview and single-use approval.
      if(await this.execute(s,step)){s.pendingStep=undefined;this.recordDiscoveredStep(s,step);}
      return;
    }
    if(!this.discoveryGuard(s,'model')||!this.discoveryGuard(s,'action'))return;
    if(r.task==='balance'&&!r.inputs.accountReference&&!r.resolvedInputs?.accountReference&&await this.profile.atCheckpoint(s.page,'client'))await this.checkpoint(s,'client');
    if(r.task==='member'&&await this.profile.atCheckpoint(s.page,'member_absent')&&!s.recorded.some(step=>step.checkpoint==='member_absent')){
      await this.checkpoint(s,'member_absent');s.recorded.push({id:'verify-member-absent',label:'Verify the new member reference is unused',action:'checkpoint',checkpoint:'member_absent',effect:'read'});
    }
    const observation=await observe(s.page);
    this.assertAutomation(s);
    if(!this.discoveryGuard(s,'model'))return;
    const budget=this.budget(s);
    // A screenshot's pixels may flicker without business progress. Compare the
    // visible semantic state, including current field values, instead.
    const observationHash=digest({url:observation.url,text:observation.text,controls:observation.controls});
    budget.unchangedObservations=observationHash===s.lastObservationHash?budget.unchangedObservations+1:0;
    if(observationHash!==s.lastObservationHash)budget.consecutiveWaits=0;
    s.lastObservationHash=observationHash;
    if(budget.unchangedObservations>=budget.maxUnchangedObservations){this.intervene(s,'DISCOVERY_STALLED','The visible application has not changed across repeated attempts. Take control to inspect or repair it before resuming.');return;}
    if(budget.consecutiveWaits>=budget.maxConsecutiveWaits){this.intervene(s,'DISCOVERY_WAIT_LIMIT','The model repeatedly waited without visible progress. Take control to inspect or repair the application before resuming.');return;}
    const controller=new AbortController(),proposalEpoch=r.epoch;
    s.pendingProposal=controller;
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},Math.max(1,this.remainingDiscoveryMs(s)));
    r.modelCalls++;this.event(r,'model','Requesting the next bounded UI action.');
    let proposal;
    try {
      proposal=await proposeAction(s.config!,{goal:r.goal,task:r.task,inputs:{...r.inputs,...r.resolvedInputs},observation,history:s.history},controller.signal);
    } catch(error) {
      if(controller.signal.aborted){
        this.assertAutomation(s);
        if(timedOut){this.intervene(s,'DISCOVERY_TIME_LIMIT','Discovery reached its active-time budget while waiting for the model. No proposed action was dispatched.');return;}
        throw new Halt();
      }
      throw error;
    } finally {clearTimeout(timeout);if(s.pendingProposal===controller)s.pendingProposal=undefined;}
    this.assertAutomation(s);
    if(r.epoch!==proposalEpoch)throw new Halt();
    if(!this.discoveryGuard(s))return;
    s.history.push({action:proposal.action,reason:proposal.reason});
    if(proposal.action==='ask_human'){this.intervene(s,'MODEL_REQUEST',proposal.reason);return;}
    if(proposal.action==='wait'){
      budget.consecutiveWaits++;
      if(budget.consecutiveWaits>=budget.maxConsecutiveWaits){this.intervene(s,'DISCOVERY_WAIT_LIMIT','The model repeatedly waited without visible progress. Take control to inspect or repair the application before resuming.');return;}
      await new Promise(resolve=>setTimeout(resolve,400));return;
    }
    budget.consecutiveWaits=0;
    if(proposal.action==='done')throw new Error('The model declared completion without a verified business checkpoint.');
    const control=observation.controls.find(c=>c.id===proposal.targetId);if(!control)throw new Error('The proposed control was not observed.');
    const isCommit=await this.profile.isCommitTarget(s.page,await uniqueLocator(s.page,control.locator,{...r.inputs,...r.resolvedInputs}));
    // A model's free-form explanation may echo unrelated page PII. Preserve the
    // purpose structurally; never copy that explanation into portable artifacts.
    const safeNames=new Set(['Next','Previous','Submit','Create Client','Clients','Active','Search members','General','Family Members','Preview','Head Office','Person']);
    const label=proposal.inputKey?`${proposal.action==='select'?'Select':'Enter'} the requested ${proposal.inputKey}`:isCommit?'Submit the reviewed details':safeNames.has(control.name)?`${proposal.action} ${control.name}`:`${proposal.action} the observed ${control.role}`;
    const step:CapabilityStep={id:`discovered-step-${s.recorded.length}`,label,action:proposal.action,target:this.parameterize(control.locator,r),effect:isCommit?'commit':proposal.action==='click'?'read':'form'};
    if(proposal.inputKey)step.value={source:'input',key:proposal.inputKey};else if(proposal.value)step.value={source:'literal',value:proposal.value};
    if(r.task==='member'&&proposal.action==='click'&&control.name==='Create Client'&&!s.recorded.some(item=>item.checkpoint==='member_absent')){
      await this.checkpoint(s,'member_absent');
      s.recorded.push({id:'verify-member-absent',label:'Verify the new member reference is unused',action:'checkpoint',checkpoint:'member_absent',effect:'read'});
    }
    // Insert identity checks after every observed transition to a client detail page.
    if(r.task!=='member'&&await this.profile.atCheckpoint(s.page,'client')&&!s.recorded.some(x=>x.checkpoint==='client')) {
      await this.checkpoint(s,'client');s.recorded.push({id:'verify-client',label:'Verify client identity',action:'checkpoint',checkpoint:'client',effect:'read'});
    }
    const preview=previewFor(r.task);
    if(isCommit&&!s.recorded.some(x=>x.checkpoint===preview))s.recorded.push({id:'verify-preview',label:r.task==='member'?'Verify new member preview':'Verify application preview',action:'checkpoint',checkpoint:preview,effect:'read'});
    if(!this.discoveryGuard(s,'action'))return;
    if(await this.execute(s,step))this.recordDiscoveredStep(s,step);
    else if(r.status==='awaiting_approval')s.pendingStep=step;
  }
  private checkEpoch(r:Run,epoch:unknown) {if(epoch!==r.epoch)throw new ActionError('Control ownership changed. Refresh the session before trying again.');}
  async control(id:string,action:string,body:{epoch?:number;approvalId?:string}):Promise<Run> {
    const r=this.get(id);this.checkEpoch(r,body.epoch);
    if(action==='stop'&&r.status==='queued'){this.finish(r,'cancelled','STOPPED');return r;}
    let s=this.sessions.get(id);
    if(action==='reconcile'&&r.effect==='unknown'&&r.status==='completed') {
      // Recovery opens a new read-only browser session; it never replays a commit.
      // A retained session may have expired. Never depend on its cached login or
      // grant it a write permit while investigating an uncertain outcome.
      if(s)await this.serial(s,()=>s!.context.close());
      this.browserPromise??=launchBrowser().catch(e=>{this.browserPromise=undefined;throw e;});this.browser=await this.browserPromise;
      const context=await this.browser.newContext({viewport:r.viewport,acceptDownloads:false,serviceWorkers:'block',locale:'en-US',timezoneId:'America/New_York'});
      // Recovery may authenticate through the UI, but may never write business records.
      await context.route('**/*',async route=>{
        const request=route.request();
        if(new URL(request.url()).origin!==this.targetUrl)return route.abort();
        const policy=this.profile.networkPolicy(request);
        if(!['read','authentication'].includes(policy))await route.abort();else await route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(6000);
      s={run:r,page,context,lock:Promise.resolve(),driving:false,haltRequested:true,permitCommit:false,commands:new Set(),recorded:[],history:[],assisted:false};this.sessions.set(id,s);
    }
    if(!s)throw new ActionError('The browser session is no longer available. Start a new run.');
    const session=s;
    if(action==='pause'||action==='takeover'||action==='stop') {
      if(r.status==='completed')throw new ActionError('This run has already finished.');
      s.haltRequested=true;r.owner='none';r.status='pausing';r.epoch++;r.approval=undefined;s.approvedDigest=undefined;s.pendingStep=undefined;s.pendingProposal?.abort();this.persist(r);
      const transitionEpoch=r.epoch;
      await this.serial(s,async()=>{});
      if(r.epoch!==transitionEpoch||(r.status as string)==='completed')throw new ActionError('A newer control request superseded this request.');
      if(action==='stop')this.finish(r,'cancelled',r.effect==='unknown'?'OUTCOME_UNKNOWN':'STOPPED',r.effect==='unknown'?'Stopped future actions. Submission may already have been accepted.':undefined);
      else {r.owner=action==='takeover'?'human':'none';r.status=action==='takeover'?'human_control':'awaiting_human';r.intervention={code:'PAUSED',reason:action==='takeover'?'You control the live browser. Repair the current screen, then resume.':'Paused at an action boundary. Take control or resume.',createdAt:now()};this.event(r,action,action==='takeover'?'Human control granted after automated input drained.':'Automation paused.','human');}
      await this.capture(s);return r;
    }
    return this.serial(session,async()=>{
      const s=session;
      this.checkEpoch(r,body.epoch);
      if(action==='resume') {
        if(!['human_control','awaiting_human'].includes(r.status))throw new ActionError('This run is not paused.');
        if(new URL(s.page.url()).origin!==this.targetUrl)throw new ActionError('The browser has left its registered target.');
        if(r.task!=='member'&&await this.profile.atCheckpoint(s.page,'client')){
          try{await this.checkpoint(s,'client');}catch(error){
            this.checkEpoch(r,body.epoch);
            if(error instanceof AccountSelectionRequired){this.requestAccountSelection(s,error);return r;}
            if(error instanceof TargetBusinessError){this.finish(r,'business_outcome',error.code,error.message,{status:error.code.toLowerCase()});return r;}
            throw error;
          }
        }
        this.checkEpoch(r,body.epoch);
        r.owner='automation';r.status='running';r.epoch++;s.haltRequested=false;r.intervention=undefined;this.event(r,'resume','Automation resumed after target and identity validation.','human');
        setImmediate(()=>void this.drive(s));return r;
      }
      if(action==='approve') {
        if(r.status!=='awaiting_approval'||!r.approval||body.approvalId!==r.approval.id)throw new ActionError('This approval is no longer available.');
        if(r.approval.consumed||Date.parse(r.approval.expiresAt)<Date.now())throw new ActionError('Approval expired or already used.');
        let summary:Record<string,unknown>;
        try {summary=await this.checkpoint(s,previewFor(r.task));}
        catch(error){throw new ActionError(error instanceof Error?error.message:'The approval preview could not be verified.');}
        this.checkEpoch(r,body.epoch);
        const bound=digest({sessionId:r.sessionId,epoch:r.epoch,capability:r.capabilityDigest||r.task,inputs:r.inputs,summary});
        if(bound!==r.approval.digest)throw new ActionError('The preview changed. Prepare a fresh approval.');
        r.epoch++;r.owner='automation';r.status='running';s.haltRequested=false;
        s.approvedDigest=digest({sessionId:r.sessionId,epoch:r.epoch,capability:r.capabilityDigest||r.task,inputs:r.inputs,summary});
        this.event(r,'approved','The exact application preview was approved.','human');setImmediate(()=>void this.drive(s));return r;
      }
      if(action==='reconcile') {
        if(r.effect!=='unknown'||r.status!=='completed')throw new ActionError('Reconciliation requires a finished run with an unknown submission outcome.');
        if(s.page.url()==='about:blank')await this.profile.bootstrap(s.page,'normal',()=>this.checkEpoch(r,body.epoch));
        const data=await this.profile.reconcile(s.page,{...r.inputs,...r.resolvedInputs},r.task);
        if(!data){this.event(r,'reconcile','Reconciliation was inconclusive. No automatic resubmission is permitted.','human');await this.capture(s);return r;}
        const validated=this.validatedOutput(r,data);
        if(r.result!=='succeeded'&&r.capabilityId){const cap=this.store.capability(r.capabilityId);if(cap){cap.successCount++;this.store.saveCapability(cap);}}
        r.effect='verified';r.result='succeeded';r.outcomeCode='RECONCILED';r.error=undefined;r.output=validated;
        this.event(r,'reconcile','A matching persisted application was verified through the target UI.','human');await this.capture(s);return r;
      }
      throw new ActionError('Unknown control action.',400);
    });
  }
  async humanInput(id:string,input:HumanInput):Promise<Run> {
    const s=this.session(id),r=s.run;
    return this.serial(s,async()=>{
      this.checkEpoch(r,input.epoch);
      if(r.owner!=='human'||r.status!=='human_control')throw new ActionError('Take control before sending browser input.');
      if(s.commands.has(input.commandId))return r;
      if(!s.frame||input.frameRevision!==s.frame.revision||Date.now()-Date.parse(s.frame.at)>15000)throw new ActionError('The displayed frame is stale. Wait for a fresh frame.');
      s.commands.add(input.commandId);
      s.assisted=true;
      if(input.action==='click'){
        if(input.x===undefined||input.y===undefined||input.x<0||input.y<0||input.x>r.viewport.width||input.y>r.viewport.height)throw new ActionError('Click coordinates are outside the viewport.',400);
        const isSubmit=await s.page.evaluate(({x,y})=>['Submit application','Submit'].includes(document.elementFromPoint(x,y)?.closest('button')?.textContent?.trim()||''),{x:input.x,y:input.y});
        if(isSubmit)throw new ActionError('Return control to automation to request a bound submission approval.');
        this.checkEpoch(r,input.epoch);
        await s.page.mouse.click(input.x,input.y);
      } else if(input.action==='type')await s.page.keyboard.insertText(input.text||'');
      else if(input.action==='key') {if(!['Enter','Tab','Shift+Tab','Escape','Backspace','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Meta+A','Control+A'].includes(input.key||''))throw new ActionError('Unsupported manual key.',400);await s.page.keyboard.press(input.key!);}
      else await s.page.mouse.wheel(0,input.deltaY||0);
      this.event(r,'manual',`Human ${input.action} input applied.`,'human');
      r.frameRevision++;s.frame=undefined;await this.capture(s);return r;
    });
  }
  private async capture(s:Session,persistEvidence=true) {
    if(s.page.isClosed())return;
    try {
      const bytes=await s.page.screenshot({type:'jpeg',quality:70,animations:'disabled',timeout:4000});
      const hash=digest(bytes.toString('base64'));if(hash!==s.frame?.hash)s.run.frameRevision++;
      s.run.frameAt=now();s.frame={dataUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`,revision:s.run.frameRevision,at:s.run.frameAt,width:s.run.viewport.width,height:s.run.viewport.height,hash};
      if(!persistEvidence)return;
      const folder=join(this.store.dataPath,'evidence');mkdirSync(folder,{recursive:true,mode:0o700});
      // The raw frame is transient and only served to the local operator. Never
      // write it as evidence: persistent images retain geometry, not page text.
      const redacted=await evidenceScreenshot(s.page);
      writeFileSync(join(folder,`${s.run.id}.jpg`),redacted,{mode:0o600});
      writeFileSync(join(folder,`${s.run.id}.json`),JSON.stringify({policy:'geometry-only-v1',outcomeCode:s.run.outcomeCode,intervention:s.run.intervention?.code,stepIndex:s.run.stepIndex,structure:await evidenceStructure(s.page)}),{mode:0o600});
    }catch{/* A missing frame is an observation failure, never proof of a business failure. */}
  }
  cursor(id:string){this.get(id);return {cursor:this.sessions.get(id)?.cursor||null};}
  async frame(id:string) {
    const s=this.sessions.get(id);
    if(!s){const r=this.get(id),path=join(this.store.dataPath,'evidence',`${r.id}.jpg`);let encoded:string;
      if(existsSync(path))encoded=readFileSync(path).toString('base64');
      else if(existsSync(`${path}.private`))encoded=openPrivate(readFileSync(`${path}.private`,'utf8'),readStateKey(this.store.dataPath),`legacy-frame:${r.id}.jpg`);
      else throw new ActionError('No saved frame is available.',404);
      return {dataUrl:`data:image/jpeg;base64,${encoded}`,revision:r.frameRevision,at:r.frameAt||r.updatedAt,width:r.viewport.width,height:r.viewport.height};}
    if(!s.frame||(!s.driving&&Date.now()-Date.parse(s.frame.at)>800))await this.serial(s,()=>this.capture(s));
    if(!s.frame)throw new ActionError('The browser has not produced a frame yet.',503);
    const {hash,...frame}=s.frame;return frame;
  }
  async close(){this.closing=true;for(const s of this.sessions.values()){s.haltRequested=true;s.run.owner='none';s.pendingStep=undefined;s.pendingProposal?.abort();}await this.browserPromise?.catch(()=>{});await Promise.all([...this.sessions.values()].map(s=>s.lock.catch(()=>{})));await this.browser?.close();this.store.close();}
}
