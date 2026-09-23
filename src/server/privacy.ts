import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Run } from '../shared/contracts.js';

// Private operational state is encrypted, not public evidence. It is needed to
// reconcile a dispatched write after restart. The adjacent local key protects
// accidental disclosure of the DB, not an attacker with this user's access.
export function readStateKey(dataPath:string):Buffer {
  const key=readFileSync(join(dataPath,'state.key'));
  if(key.length!==32)throw new Error('The local state key is invalid. Restore the original key to read this history.');
  return key;
}
export function ensureStateKey(dataPath:string):Buffer {
  const path=join(dataPath,'state.key');
  if(!existsSync(path))writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});
  chmodSync(path,0o600);return readStateKey(dataPath);
}
export function sealPrivate(value:string,key:Buffer,context:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(context));
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
export function openPrivate(value:string,key:Buffer,context:string):string {
  try{
    const [version,iv,tag,data,...rest]=value.split('.');
    if(version!=='v1'||rest.length)throw new Error();
    const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
    cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64'));
    return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
  }catch{throw new Error('Private history could not be authenticated. Restore the matching local state key; do not repeat an uncertain submission.');}
}
/** Move pre-policy frames into private encrypted history, never the public evidence path. */
export function migrateLegacyFrames(dataPath:string,key:Buffer){
  const folder=join(dataPath,'evidence');if(!existsSync(folder))return;
  for(const name of readdirSync(folder).filter(name=>/\.(jpg|json)$/.test(name))){
    let safe=false;
    try{safe=JSON.parse(readFileSync(join(folder,name.replace(/\.jpg$/,'.json')),'utf8')).policy==='geometry-only-v1';}catch{}
    if(safe)continue;
    const path=join(folder,name);
    const context=`${name.endsWith('.jpg')?'legacy-frame':'legacy-metadata'}:${name}`;
    writeFileSync(`${path}.private.tmp`,sealPrivate(readFileSync(path).toString('base64'),key,context),{mode:0o600});
    renameSync(`${path}.private.tmp`,`${path}.private`);
    unlinkSync(path);
  }
}
const safeValues=new Set(['USD','Active','Pending Approval','Submitted and pending approval','Head Office','Everyday Savings','Growth Savings']);
const safeValue=(value:unknown):unknown=>typeof value==='string'&&safeValues.has(value)?value:'[redacted]';
const redactFields=(value:Record<string,unknown>|undefined)=>value?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,safeValue(item)])):undefined;
const eventReasons:Record<string,string>={
  created:'A run was requested.',model:'Requested the next bounded UI action.',step:'Executed and verified the recorded step.',
  approval:'Paused for review of the exact preview.',approved:'The operator approved the bound preview.',approval_consumed:'Consumed the single-use approval.',
  commit_sent:'Dispatched the approved write; confirmation is required.',finished:'Finished with the recorded outcome code.',
  intervention:'Automation yielded for the recorded intervention code.',policy:'The worker blocked an action outside its policy.',
  takeover:'Granted human control after automated input drained.',pause:'Paused at an action boundary.',resume:'Resumed after target and identity validation.',
  manual:'Applied operator input to the existing session.',account_selected:'The operator chose from freshly verified member accounts.',
  account_resolved:'Resolved the account from the verified member UI.',input_resolved:'Resolved missing fields from the visible target.',
  reconcile:'Performed read-only reconciliation.',recovery:'Recorded session loss after worker restart.',
  artifact_withheld:'Withheld an artifact because the run contained unrecorded human actions.',
};
/** An allowlisted audit projection. Free-form target/model/user text never enters public logs. */
export function redactRun(run:Run):Record<string,unknown>{
  return {
    id:run.id,targetId:run.targetId,mode:run.mode,task:run.task,goal:'[redacted]',
    capabilityId:run.capabilityId,capabilityDigest:run.capabilityDigest,discoveredCapabilityId:run.discoveredCapabilityId,
    status:run.status,result:run.result,outcomeCode:run.outcomeCode,effect:run.effect,
    inputs:redactFields(run.inputs),resolvedInputs:redactFields(run.resolvedInputs),output:redactFields(run.output),
    createdAt:run.createdAt,updatedAt:run.updatedAt,finishedAt:run.finishedAt,owner:run.owner,epoch:run.epoch,
    sessionId:run.sessionId,stepIndex:run.stepIndex,modelCalls:run.modelCalls,provider:run.provider,model:run.model,discoveryBudget:run.discoveryBudget,
    steps:run.steps.map(step=>({id:step.id,state:step.state,label:'[recorded step]'})),
    events:run.events.map(event=>({id:event.id,timestamp:event.timestamp,kind:event.kind,actor:event.actor,message:eventReasons[event.kind]||'Worker event recorded.'})),
    ...(run.error?{error:'[redacted; inspect outcomeCode and failing step]'}:{}),
    ...(run.intervention?{intervention:{code:run.intervention.code,createdAt:run.intervention.createdAt,reason:'[redacted]',...(run.intervention.accountSelection?{accountSelection:{clientReference:'[redacted]',choiceCount:run.intervention.accountSelection.choices.length}}:{})}}:{}),
    ...(run.approval?{approval:{consumed:run.approval.consumed,expiresAt:run.approval.expiresAt,summary:redactFields(run.approval.summary)}}:{}),
    evidencePolicy:'audit-v1: identifiers, names, goal, raw errors, free-form text and approval tokens omitted',
  };
}
export function redactSecrets(text:string):string {
  return text.replace(/\bsk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi,'$1 [redacted]').replace(/\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*[^\s,;]+/gi,'[redacted credential]');
}
/** Geometry-only persistent screenshot. The interactive frame stays in memory. */
export async function evidenceScreenshot(page:Page):Promise<Buffer>{
  return page.screenshot({type:'jpeg',quality:65,animations:'disabled',timeout:4000,
    mask:[page.locator('input,textarea,select,img,canvas,video,iframe,svg,math')],maskColor:'#d7ded3',
    style:'*,:before,:after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; background-image: none !important; }'});
}
export async function evidenceStructure(page:Page){
  return page.evaluate(()=>{
    const nodes=Array.from(document.querySelectorAll('button,input,select,textarea,[role="dialog"],table'));
    return {title:'[redacted]',controls:nodes.filter(node=>(node as HTMLElement).getClientRects().length).slice(0,200).map(node=>({tag:node.tagName.toLowerCase(),type:node.getAttribute('type')||undefined,disabled:node.matches(':disabled,[aria-disabled="true"]')}))};
  });
}
