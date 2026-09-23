import { createHash } from 'node:crypto';
import { capabilitySchema, type Capability, type CapabilityRecord, type CapabilityStep, type TaskKind } from '../shared/contracts.js';
import { baselineId } from './goals.js';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const click = (id: string, label: string, name: string): CapabilityStep => ({ id, label, action:'click', effect:'read', target:{kind:'role',role:'link',value:name,exact:true} });
const checkpoint = (name:'client'|'account'|'preview'|'submitted'):CapabilityStep => ({id:`verify-${name}`,label:`Verify ${name}`,action:'checkpoint',checkpoint:name,effect:'read'});
export function authoredCapabilities(): CapabilityRecord[] {
  const common: CapabilityStep[] = [
    {id:'open',label:'Open the credit union application',action:'navigate',path:'/',effect:'read'},
    {id:'search-value',label:'Enter the member reference',action:'fill',target:{kind:'label',value:'Member reference',exact:true},value:{source:'input',key:'clientReference'},effect:'form'},
    {id:'search',label:'Find the member',action:'click',target:{kind:'role',role:'button',value:'Search members',exact:true},effect:'read'},
    click('client','Open the matching member','Open member {{clientReference}}'), {...checkpoint('client'),label:'Verify member identity and resolve the savings account'},
  ];
  const prepare:CapabilityStep[] = [
    click('new','Start a savings application','New savings application'),
    {id:'product',label:'Choose the requested product',action:'select',target:{kind:'label',value:'Product',exact:true},value:{source:'input',key:'product'},effect:'form'},
    {id:'reference',label:'Set the application reference',action:'fill',target:{kind:'label',value:'External reference',exact:true},value:{source:'input',key:'externalReference'},effect:'form'},
    {id:'review',label:'Prepare the application preview',action:'click',target:{kind:'role',role:'button',value:'Review application',exact:true},effect:'form'}, checkpoint('preview'),
  ];
  return (['balance','prepare','submit'] as const).map(task => {
    const names = {balance:'Read savings balance',prepare:'Prepare savings application',submit:'Submit reviewed application'};
    const steps = task==='balance' ? [...common,click('account','Open the requested savings account','View account {{accountReference}}'),checkpoint('account')] : [...common,...prepare];
    if(task==='submit') steps.push({id:'submit',label:'Submit the approved application once',action:'click',target:{kind:'role',role:'button',value:'Submit application',exact:true},effect:'commit'},checkpoint('submitted'));
    return makeRecord(capabilitySchema.parse({schemaVersion:1,id:baselineId(task),version:'1.1.0',name:names[task],description:'Authored capability for the US credit union lab with synthetic USD accounts. Replay reads and operates the visible browser UI.',task,target:'local-banking-lab',inputs:'banking-inputs-v1',output:`${task==='balance'?'balance':task==='prepare'?'prepared':'submitted'}-v1`,steps,provenance:{kind:'authored'}}),'approved');
  });
}
export function makeRecord(capability:Capability,status:CapabilityRecord['status']='draft'):CapabilityRecord {
  return {...capability,digest:digest(capability),status,createdAt:new Date().toISOString(),replayCount:0,successCount:0};
}
