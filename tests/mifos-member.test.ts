import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Request} from 'playwright-core';
import {inputSchema} from '../src/shared/contracts.js';
import {createMifosProfile} from '../src/server/targets/mifos.js';
import {MEMBER_GENERAL, normalizeMemberDate} from '../src/server/targets/mifos-member.js';
import {TargetBusinessError} from '../src/server/targets/types.js';
import {launchBrowser,locate,observe} from '../src/server/surface.js';

test('member activation dates are unambiguous and replay reads the current visible date',()=>{
 assert.equal(normalizeMemberDate('9/23/2026'),'23 September 2026');
 assert.equal(normalizeMemberDate('23 September 2026'),'23 September 2026');
 for(const value of ['23/9/2026','2/30/2026','today','2026-09-23'])assert.throws(()=>normalizeMemberDate(value),/unambiguous/);
 const cap=createMifosProfile({baseUrl:'http://127.0.0.1:4200'}).capabilities().find(c=>c.task==='member')!;
 assert.equal(cap.id,'mifos-member-v1');
 assert.equal(cap.steps.filter(s=>s.effect==='commit').length,1);
 assert.ok(cap.steps.findIndex(s=>s.checkpoint==='member_absent')<cap.steps.findIndex(s=>s.id==='new-member'));
 assert.deepEqual(cap.steps.find(s=>s.id==='activation-date')?.value,{source:'input',key:'memberActivationDate'});
 assert.equal(cap.steps.at(-1)?.checkpoint,'member_created');
});

test('member UI contract checks absence, exact preview, constrained payload and generated member number', {timeout:30_000},async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage();
  const base='http://127.0.0.1:4200';
  const profile=createMifosProfile({baseUrl:base,officeId:1});
  const inputs=inputSchema.parse({clientReference:'99102',accountReference:'',firstName:'Jordan',lastName:'Parker',memberActivationDate:'9/23/2026'});
  let html='';
  const shell=(body:string)=>`<style>mifosx-client-preview-step,mifosx-client-general-step,mifosx-clients-view,mat-card-title,mat-card-subtitle{display:block}i{display:inline-block;width:15px;height:15px}td,span{padding:3px}</style>${body}`;
  const navigate=async(hash:string,body:string)=>{html=shell(body);await page.goto(`${base}/`);await page.goto(`${base}/#${hash}`);};
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
  await navigate('/clients','<input placeholder="Search by client name, external Id, mobile" value="99102"><div>No client was found</div>');
  await profile.resolveInputs!(page,'member',inputs);
  assert.equal(await profile.detectState(page),undefined);
  assert.equal(await profile.atCheckpoint(page,'member_absent'),true);
  assert.deepEqual(await profile.checkpoint(page,'member_absent',inputs),{clientReference:'99102',status:'reference_available'});

  const terms:Record<string,string>={Name:'Jordan Parker',Office:'Head Office','Legal Form':'Person','External Id':'99102','Submitted On Date':'23 September 2026','Active?':'Yes','Activation Date':'23 September 2026','Is staff?':'No'};
  const render=()=>`<div class="mat-horizontal-stepper-content"><mifosx-client-preview-step>${Object.entries(terms).map(([key,value])=>`<div><span>${key}</span><span>${value}</span></div>`).join('')}<button>Submit</button></mifosx-client-preview-step></div>`;
  await navigate('/clients/create',render());
  assert.equal(await profile.atCheckpoint(page,'member_preview'),true);
  const summary=await profile.checkpoint(page,'member_preview',inputs) as Record<string,string>;
  assert.equal(summary.opensSavingsAccount,'No');
  assert.equal(await profile.isCommitTarget(page,page.getByRole('button',{name:'Submit'})),true);
  const body={officeId:1,legalFormId:1,isStaff:false,active:true,externalId:'99102',firstname:'Jordan',lastname:'Parker',submittedOnDate:'23 September 2026',activationDate:'23 September 2026',familyMembers:[],dateFormat:'dd MMMM yyyy',locale:'en'};
  const request=(payload:unknown,url=`${base}/fineract-provider/api/v1/clients`)=>({url:()=>url,method:()=>'POST',postDataJSON:()=>payload,frame:()=>({page:()=>page})}) as unknown as Request;
  assert.equal(profile.validateCommit!(request(body),inputs,summary),true);
  for(const patch of [{officeId:2},{legalFormId:2},{isStaff:true},{active:false},{externalId:'99103'},{firstname:'Other'},{lastname:'Other'},{activationDate:'22 September 2026'},{familyMembers:[{firstName:'Other'}]},{savingsProductId:1},{accountNo:'99102'},{mobileNo:'5555551212'}])assert.equal(profile.validateCommit!(request({...body,...patch}),inputs,summary),false,JSON.stringify(patch));
  assert.equal(profile.validateCommit!(request(body,`${base}/fineract-provider/api/v1/clients?command=activate`),inputs,summary),false);
  assert.equal(profile.validateCommit!(request(body),inputs,{...summary,firstName:'Other'}),false);
  terms['Active?']='No';await navigate('/clients/create',render());
  await assert.rejects(()=>profile.checkpoint(page,'member_preview',inputs),/active, non-staff/);

  await navigate('/clients/17/general',`<mifosx-clients-view><mat-card-title><i class="fa-stop"></i><mifosx-entity-name>Jordan Parker</mifosx-entity-name></mat-card-title><mat-card-subtitle><table>${Object.entries({Office:'Head Office',Client:'000000017','External Id':'99102','Activation Date':'23 September 2026'}).map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></mat-card-subtitle></mifosx-clients-view><div class="mat-tooltip">Active</div>`);
  const output=await profile.checkpoint(page,'member_created',inputs);
  assert.equal(output.clientReference,'99102');assert.equal(output.memberAccountNumber,'000000017');
  assert.equal(output.firstName,'Jordan');assert.equal(output.lastName,'Parker');assert.equal(output.status,'Active');
  assert.deepEqual(await profile.checkpoint(page,'client',inputs),{clientReference:'99102'});
  await assert.rejects(()=>profile.checkpoint(page,'member_created',{...inputs,firstName:'Other'}),/identity/);

  await navigate('/clients','<input placeholder="Search by client name, external Id, mobile" value="99102"><mifosx-clients><table><tr><td class="mat-column-displayName">Jordan Parker</td><td class="mat-column-externalId"><mifosx-external-identifier><span>99102</span></mifosx-external-identifier></td></tr></table></mifosx-clients>');
  await assert.rejects(()=>profile.checkpoint(page,'member_absent',inputs),error=>error instanceof TargetBusinessError&&error.code==='MEMBER_REFERENCE_EXISTS');
 }finally{await browser.close();}
});

test('member observer excludes inactive wizard content and exposes checkbox state with a clickable label', {timeout:15_000},async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage();
  await page.setContent(`<div class="mat-horizontal-stepper-content"><mifosx-client-general-step style="display:block"><mat-checkbox formcontrolname="active"><label for="active">Active?</label><input id="active" type="checkbox"></mat-checkbox><input formcontrolname="submittedOnDate" value="9/23/2026"><button>Next</button></mifosx-client-general-step></div><div class="mat-horizontal-stepper-content mat-horizontal-stepper-content-inactive"><mifosx-client-family-members-step style="display:block"><button>Next</button><button>Add</button></mifosx-client-family-members-step></div>`);
  const profile=createMifosProfile({baseUrl:'http://127.0.0.1:4200'}),inputs=inputSchema.parse({firstName:'Jordan',lastName:'Parker'});
  assert.deepEqual(await profile.resolveInputs!(page,'member',inputs),{memberActivationDate:'9/23/2026'});
  const observation=await observe(page);
  assert.equal(observation.controls.filter(c=>c.name==='Next').length,1);
  assert.equal(observation.controls.find(c=>c.name==='Next')?.locator.scope,MEMBER_GENERAL);
  assert.equal(observation.controls.some(c=>c.name==='Add'),false);
  const active=observation.controls.find(c=>c.name==='Active?')!;
  assert.equal(active.role,'checkbox');assert.equal(active.value,'unchecked');
  await locate(page,active.locator,inputs).click();
  assert.equal(await page.locator('#active').isChecked(),true);
  assert.equal((await observe(page)).controls.find(c=>c.name==='Active?')?.value,'checked');
 }finally{await browser.close();}
});
