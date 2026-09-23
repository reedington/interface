import type { Locator, Page, Request } from 'playwright-core';
import { capabilitySchema, type CapabilityRecord, type CapabilityStep, type RunInputs } from '../../shared/contracts.js';
import { makeRecord } from '../capabilities.js';
import { TargetBusinessError } from './types.js';

const ACTIVE_PANEL='.mat-horizontal-stepper-content:not(.mat-horizontal-stepper-content-inactive)';
export const MEMBER_GENERAL=`${ACTIVE_PANEL} mifosx-client-general-step:visible`;
export const MEMBER_FAMILY=`${ACTIVE_PANEL} mifosx-client-family-members-step:visible`;
export const MEMBER_PREVIEW=`${ACTIVE_PANEL} mifosx-client-preview-step:visible`;
const SEARCH='input[placeholder="Search by client name, external Id, mobile"]';
const CLIENT='mifosx-clients-view';
const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
const route=(page:Page)=>new URL(page.url()).hash.slice(1).split('?')[0];
const memberResult=(reference:string)=>`mifosx-clients tr:has(td.mat-column-externalId mifosx-external-identifier span:text-is("${reference}")) td.mat-column-displayName`;
async function text(locator:Locator,label:string):Promise<string>{
  await locator.waitFor({state:'visible',timeout:10_000});
  if(await locator.count()!==1)throw new Error(`The visible ${label} is ambiguous.`);
  const value=clean(await locator.innerText());
  if(!value)throw new Error(`The visible ${label} is empty.`);
  return value;
}
async function memberField(page:Page,label:string):Promise<string>{
  return text(page.locator(`${CLIENT} mat-card-subtitle tr`).filter({has:page.locator('td:first-child').filter({hasText:new RegExp(`^\\s*${label}\\s*$`)})}).locator('td').nth(1),label);
}
export function normalizeMemberDate(value:string):string{
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const short=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const long=value.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  const month=short?Number(short[1]):long?months.indexOf(long[2])+1:0;
  const day=Number(short?.[2]||long?.[1]),year=Number(short?.[3]||long?.[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(!month||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getUTCFullYear()!==year)throw new Error('The member business date is not an unambiguous US date.');
  return `${day} ${months[month-1]} ${year}`;
}

export function mifosMemberCapability(release:string):CapabilityRecord{
  const step=(id:string,label:string,action:CapabilityStep['action'],target:CapabilityStep['target'],value?:CapabilityStep['value']):CapabilityStep=>({id,label,action,target,value,effect:action==='click'?'read':'form'});
  const steps:CapabilityStep[]=[
    {id:'open',label:'Open Mifos members',action:'navigate',path:'/#/clients',effect:'read'},
    step('search-value','Search the new member reference','fill',{kind:'css',value:SEARCH,exact:true},{source:'input',key:'clientReference'}),
    step('search','Check whether this reference already exists','press',{kind:'css',value:SEARCH,exact:true},{source:'literal',value:'Enter'}),
    {id:'verify-absent',label:'Require an unused member reference',action:'checkpoint',checkpoint:'member_absent',effect:'read'},
    step('new-member','Open the new member form','click',{kind:'role',role:'button',value:'Create Client',exact:true}),
    step('office','Select the local Head Office','select',{kind:'css',value:'mat-select[formcontrolname="officeId"]',scope:MEMBER_GENERAL,exact:true},{source:'literal',value:'Head Office'}),
    step('first-name','Enter the requested first name','fill',{kind:'css',value:'input[formcontrolname="firstname"]',scope:MEMBER_GENERAL,exact:true},{source:'input',key:'firstName'}),
    step('last-name','Enter the requested last name','fill',{kind:'css',value:'input[formcontrolname="lastname"]',scope:MEMBER_GENERAL,exact:true},{source:'input',key:'lastName'}),
    step('member-reference','Enter the new member external reference','fill',{kind:'css',value:'input[formcontrolname="externalId"]',scope:MEMBER_GENERAL,exact:true},{source:'input',key:'clientReference'}),
    step('active','Select active member status for review','click',{kind:'css',value:'mat-checkbox[formcontrolname="active"] label',scope:MEMBER_GENERAL,exact:true}),
    step('activation-date','Use the visible business date for activation','fill',{kind:'css',value:'input[formcontrolname="activationDate"]',scope:MEMBER_GENERAL,exact:true},{source:'input',key:'memberActivationDate'}),
    step('general-next','Review the member details','click',{kind:'role',role:'button',value:'Next',scope:MEMBER_GENERAL,exact:true}),
    step('family-next','Continue without adding family members','click',{kind:'role',role:'button',value:'Next',scope:MEMBER_FAMILY,exact:true}),
    {id:'verify-member-preview',label:'Verify the exact member preview',action:'checkpoint',checkpoint:'member_preview',effect:'read'},
    {id:'create-member',label:'Create the approved member once',action:'click',target:{kind:'role',role:'button',value:'Submit',scope:MEMBER_PREVIEW,exact:true},effect:'commit'},
    {id:'verify-member-created',label:'Verify the created active member',action:'checkpoint',checkpoint:'member_created',effect:'read'},
  ];
  return makeRecord(capabilitySchema.parse({schemaVersion:1,id:'mifos-member-v1',version:'1.1.0',name:'Mifos · Create reviewed member',description:`Create an active individual member in the local Head Office through the Mifos X ${release} preview and one-time approval. No savings account is opened.`,task:'member',target:'mifos-x',inputs:'banking-inputs-v1',output:'member-v1',steps,provenance:{kind:'authored'}}),'draft');
}

export function createMifosMemberAdapter(options:{baseUrl:string;officeId?:number}){
  const absences=new WeakMap<Page,string>();
  const previews=new WeakMap<Page,Record<string,string>>();
  async function waitSearch(page:Page,inputs:RunInputs){
    const result=page.locator(memberResult(inputs.clientReference));
    const missing=page.getByText('No client was found',{exact:true});
    await result.or(missing).filter({visible:true}).first().waitFor({state:'visible',timeout:10_000});
  }
  async function absent(page:Page,inputs:RunInputs):Promise<Record<string,unknown>>{
    absences.delete(page);
    if(route(page)!=='/clients'||await page.locator(SEARCH).inputValue()!==inputs.clientReference)throw new Error('Search the exact new member reference before opening the creation form.');
    await waitSearch(page,inputs);
    if(await page.locator(memberResult(inputs.clientReference)).count())throw new TargetBusinessError('MEMBER_REFERENCE_EXISTS','This member reference already exists. Use that member or choose a new reference.');
    if(!await page.getByText('No client was found',{exact:true}).isVisible())throw new Error('The new member reference could not be proven unused.');
    absences.set(page,inputs.clientReference);
    return {clientReference:inputs.clientReference,status:'reference_available'};
  }
  async function preview(page:Page,inputs:RunInputs):Promise<Record<string,string>>{
    if(route(page)!=='/clients/create'||absences.get(page)!==inputs.clientReference)throw new Error('Verify the new member reference is unused before preparing this member.');
    if(!inputs.firstName||!inputs.lastName||!inputs.memberActivationDate)throw new Error('The member name and visible business date must be resolved before review.');
    const root=page.locator(MEMBER_PREVIEW);await root.waitFor({state:'visible',timeout:10_000});
    const entries=Object.fromEntries(await root.evaluate(el=>Array.from(el.querySelectorAll('div')).flatMap(div=>{
      const spans=Array.from(div.children).filter(child=>child.tagName==='SPAN');
      return spans.length===2?[[(spans[0] as HTMLElement).innerText.replace(/\s+/g,' ').trim(),(spans[1] as HTMLElement).innerText.replace(/\s+/g,' ').trim()]]:[];
    })));
    const allowed=['Name','Office','Legal Form','External Id','Submitted On Date','Active?','Activation Date','Is staff?'];
    if(Object.keys(entries).some(key=>!allowed.includes(key))||allowed.some(key=>!entries[key]))throw new Error('The member preview includes unsupported or missing fields.');
    if(entries.Name!==`${inputs.firstName} ${inputs.lastName}`||entries['External Id']!==inputs.clientReference)throw new Error('The member preview name or reference does not match the request.');
    if(entries.Office!=='Head Office'||entries['Legal Form']!=='Person'||entries['Active?']!=='Yes'||entries['Is staff?']!=='No')throw new Error('The member preview must be an active, non-staff individual in Head Office.');
    const date=normalizeMemberDate(inputs.memberActivationDate);
    if(entries['Submitted On Date']!==date||entries['Activation Date']!==date)throw new Error('The member preview dates do not match the observed business date.');
    const summary={clientReference:inputs.clientReference,firstName:inputs.firstName,lastName:inputs.lastName,office:entries.Office,legalForm:entries['Legal Form'],status:'Active',submittedOn:date,activationDate:date,isStaff:'No',opensSavingsAccount:'No',previewText:clean(await root.innerText())};
    previews.set(page,summary);return summary;
  }
  async function created(page:Page,inputs:RunInputs):Promise<Record<string,unknown>>{
    await page.waitForURL(url=>/^#\/clients\/\d+\/general$/.test(url.hash),{timeout:10_000});
    const path=route(page);
    const name=await text(page.locator(`${CLIENT} mat-card-title mifosx-entity-name`),'member name');
    const reference=await memberField(page,'External Id');
    const memberAccountNumber=await memberField(page,'Client');
    const office=await memberField(page,'Office');
    const activationDate=await memberField(page,'Activation Date');
    if(name!==`${inputs.firstName} ${inputs.lastName}`||reference!==inputs.clientReference||office!=='Head Office')throw new Error('The created member identity does not match the approved request.');
    if(!inputs.memberActivationDate||activationDate!==normalizeMemberDate(inputs.memberActivationDate))throw new Error('The created member activation date does not match the approved request.');
    const icon=page.locator(`${CLIENT} mat-card-title i.fa-stop:visible`);await icon.hover();
    const status=await text(page.locator('.mat-tooltip:visible, .mat-mdc-tooltip-surface:visible, [role="tooltip"]:visible'),'member status');
    if(status!=='Active')throw new Error('The created member is not visibly Active.');
    if(route(page)!==path||await memberField(page,'Client')!==memberAccountNumber||await memberField(page,'External Id')!==reference)throw new Error('The member changed while its identity was being verified.');
    return {clientReference:reference,memberAccountNumber,firstName:inputs.firstName,lastName:inputs.lastName,memberName:name,office,status,activationDate};
  }
  return {
    waitSearch,absent,preview,created,
    async resolveInputs(page:Page,inputs:RunInputs):Promise<Partial<RunInputs>>{
      if(inputs.memberActivationDate||!await page.locator(MEMBER_GENERAL).count())return {};
      const date=await page.locator(`${MEMBER_GENERAL} input[formcontrolname="submittedOnDate"]`).inputValue();
      normalizeMemberDate(date);return {memberActivationDate:date};
    },
    validateCommit(request:Request,inputs:RunInputs,summary:Record<string,string>):boolean{
      try{
        const page=request.frame().page(),saved=previews.get(page),body=request.postDataJSON();
        if(!options.officeId||route(page)!=='/clients/create'||absences.get(page)!==inputs.clientReference||!saved||JSON.stringify(saved)!==JSON.stringify(summary))return false;
        const allowed=['officeId','legalFormId','isStaff','active','externalId','firstname','lastname','submittedOnDate','activationDate','familyMembers','dateFormat','locale'];
        return Object.keys(body).length===allowed.length&&Object.keys(body).every(key=>allowed.includes(key))
          &&body.officeId===options.officeId&&body.legalFormId===1&&body.isStaff===false&&body.active===true
          &&body.externalId===inputs.clientReference&&body.firstname===inputs.firstName&&body.lastname===inputs.lastName
          &&body.submittedOnDate===saved.submittedOn&&body.activationDate===saved.activationDate
          &&Array.isArray(body.familyMembers)&&body.familyMembers.length===0&&body.dateFormat==='dd MMMM yyyy'&&body.locale==='en';
      }catch{return false;}
    },
    async reconcile(page:Page,inputs:RunInputs):Promise<Record<string,unknown>|undefined>{
      await page.goto(`${options.baseUrl}/#/clients`);await page.locator(SEARCH).fill(inputs.clientReference);await page.locator(SEARCH).press('Enter');
      await waitSearch(page,inputs);
      const match=page.locator(memberResult(inputs.clientReference));
      if(await match.count()===0)return undefined;
      if(await match.count()!==1)throw new Error('Multiple members match the external reference. Inspect them manually.');
      await match.click();return created(page,inputs);
    },
  };
}
