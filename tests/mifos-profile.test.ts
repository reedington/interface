import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'playwright-core';
import { inputSchema } from '../src/shared/contracts.js';
import { createMifosProfile, mifosCapabilities, mifosNetworkPolicy, mifosTermsMatch, parseMifosUsdBalance } from '../src/server/targets/mifos.js';
import { launchBrowser, locate, observe } from '../src/server/surface.js';

const terms:Record<string,string>={Product:'Everyday Savings','Submitted On':'23 September 2026','External Id':'CU-REVIEW-001','Field Officer':'',Currency:'USD','Decimal Places':'2','Nominal Annual Interest':'0 %','Interest Compounding Period':'Daily','Interest Posting Period':'Monthly','Interest Calculated using':'Daily Balance','Days in Year':'365 Days','Apply Withdrawal Fee for Transfers':'No','Is Overdraft Allowed':'No','Enforce Minimum Balance':'No'};
const body={clientId:7,productId:3,externalId:'CU-REVIEW-001',fieldOfficerId:'',submittedOnDate:'23 September 2026',dateFormat:'dd MMMM yyyy',monthDayFormat:'dd MMMM',locale:'en',charges:[],nominalAnnualInterestRate:0,interestCompoundingPeriodType:1,interestPostingPeriodType:4,interestCalculationType:1,interestCalculationDaysInYearType:365,minRequiredOpeningBalance:null,withdrawalFeeForTransfers:false,lockinPeriodFrequency:'',lockinPeriodFrequencyType:'',allowOverdraft:false,enforceMinRequiredBalance:false,minRequiredBalance:null};

test('Mifos network policy restricts writes to authentication and exact pending savings creation',()=>{
  const request=(url:string,method='GET')=>({url:()=>url,method:()=>method});
  const base='http://127.0.0.1:4200';
  assert.equal(mifosNetworkPolicy(base,request(`${base}/fineract-provider/api/v1/savingsaccounts/1`)),'read');
  assert.equal(mifosNetworkPolicy(base,request(`${base}/fineract-provider/api/v2/clients/search`,'POST')),'read');
  assert.equal(mifosNetworkPolicy(base,request(`${base}/fineract-provider/api/v1/authentication`,'POST')),'authentication');
  assert.equal(mifosNetworkPolicy(base,request(`${base}/fineract-provider/api/v1/savingsaccounts`,'POST')),'commit');
  for(const [url,method] of [[`${base}/fineract-provider/api/v1/savingsaccounts/1?command=activate`,'POST'],[`${base}/fineract-provider/api/v1/savingsaccounts?command=approve`,'POST'],[`${base}/fineract-provider/api/v1/savingsaccounts/1`,'DELETE'],['https://example.com/fineract-provider/api/v1/savingsaccounts','POST'],['http://localhost:4200/fineract-provider/api/v1/savingsaccounts','POST']])assert.equal(mifosNetworkPolicy(base,request(url,method)),'deny');
  assert.throws(()=>createMifosProfile({baseUrl:'https://example.com'}),/local loopback/);
});

test('Mifos authored preparation ends at preview and isolates submission as a commit',()=>{
  const capabilities=mifosCapabilities();
  assert.equal(capabilities.length,4);
  assert.ok(capabilities.every(cap=>cap.target==='mifos-x'&&cap.status==='draft'));
  const prepare=capabilities.find(cap=>cap.task==='prepare')!;
  const submit=capabilities.find(cap=>cap.task==='submit')!;
  assert.equal(prepare.steps.at(-1)?.checkpoint,'preview');
  assert.equal(prepare.steps.filter(step=>step.effect==='commit').length,0);
  assert.equal(submit.steps.filter(step=>step.effect==='commit').length,1);
  assert.equal(submit.steps.at(-1)?.checkpoint,'submitted');
  assert.equal(prepare.steps.filter(step=>step.target?.value==='Next').length,3);
  assert.ok(prepare.steps.every(step=>!step.target?.value.includes('data-field')));
});

test('Mifos balance parser requires unambiguous US dollar formatting',()=>{
  assert.equal(parseMifosUsdBalance('$12,540.75'),'12540.75');
  assert.equal(parseMifosUsdBalance('$840.00'),'840.00');
  assert.equal(parseMifosUsdBalance('-$12.50'),'-12.50');
  for(const value of ['₦840.00','840.00','$1,23.00','$NaN','$1.2','12.00 USD'])assert.throws(()=>parseMifosUsdBalance(value),/unambiguous/);
});

test('Mifos outgoing application terms must match every supported visible preview field',()=>{
  assert.equal(mifosTermsMatch(body,terms),true);
  for(const patch of [{nominalAnnualInterestRate:9},{interestCompoundingPeriodType:4},{interestPostingPeriodType:7},{interestCalculationType:2},{interestCalculationDaysInYearType:360},{submittedOnDate:'22 September 2026'},{locale:'fr'},{charges:[{chargeId:1,amount:10}]},{allowOverdraft:true},{minRequiredOpeningBalance:500},{withdrawalFeeForTransfers:true},{fieldOfficerId:99},{accountNo:'UNREVIEWED'},{groupId:10}])assert.equal(mifosTermsMatch({...body,...patch},terms),false,JSON.stringify(patch));
});

test('Mifos observation readiness waits for routed member accounts and account content', {timeout:20_000}, async()=>{
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage();
    const base='http://127.0.0.1:4200';
    const profile=createMifosProfile({baseUrl:base});
    const inputs=inputSchema.parse({clientReference:'10001',accountReference:'SAV-1001'});
    const members='<mifosx-clients><table><tr><td class="mat-column-displayName">Alex Morgan</td><td class="mat-column-externalId"><mifosx-external-identifier><span>10001</span></mifosx-external-identifier></td></tr></table></mifosx-clients>';
    const accounts='<table><tr><th>Savings Product</th><th>Last Active</th></tr><tr><td><mifosx-account-number><span>SAV-1001</span></mifosx-account-number></td><td>Everyday Savings</td></tr></table>';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<style>mifosx-clients-view,mifosx-savings-account-view,mat-card-subtitle,mat-card-title{display:block}</style>${members}`}));
    await page.goto(`${base}/#/clients`);
    // The click returns while the old list is still mounted. The child accounts
    // view is rendered after the route and member header, as in the real SPA.
    await page.locator('td.mat-column-displayName').evaluate((el,table)=>el.addEventListener('click',()=>{
      setTimeout(()=>{location.hash='/clients/1/general';document.body.innerHTML='<mifosx-clients-view style="display:block"><mat-card-subtitle style="display:block">Member 10001</mat-card-subtitle></mifosx-clients-view>';},150);
      setTimeout(()=>{document.querySelector('mifosx-clients-view')!.insertAdjacentHTML('beforeend',table);},350);
    }),accounts);
    const memberStep=profile.capabilities()[0].steps.find(step=>step.id==='client')!;
    await locate(page,memberStep.target!,inputs).click();
    assert.equal(new URL(page.url()).hash,'#/clients');
    await profile.awaitObservationReady!(page,memberStep,inputs);
    const observed=await observe(page);
    assert.equal(new URL(observed.url).hash,'#/clients/1/general');
    assert.ok(observed.controls.some(control=>control.name==='View account SAV-1001'));

    const accountStep=profile.capabilities()[0].steps.find(step=>step.id==='account')!;
    await page.locator('mifosx-account-number').evaluate(el=>el.addEventListener('click',()=>{
      setTimeout(()=>{location.hash='/clients/1/savings-accounts/1/general';document.body.innerHTML='<mifosx-savings-account-view style="display:block"><mat-card-title><h3><mifosx-account-number>SAV-1001</mifosx-account-number></h3></mat-card-title></mifosx-savings-account-view>';},150);
      setTimeout(()=>{document.querySelector('mifosx-savings-account-view')!.insertAdjacentHTML('beforeend','<table class="account-overview"><tr><td>Current Balance</td><td>$12,540.75</td></tr></table>');},350);
    }));
    await locate(page,accountStep.target!,inputs).click();
    await profile.awaitObservationReady!(page,accountStep,inputs);
    assert.match((await observe(page)).text,/12,540\.75/);
  }finally{await browser.close();}
});

// These fixtures reflect the audited upstream templates. They test our visible-DOM
// parser and policy, not the full Angular app or a real Fineract server.
test('Mifos visible DOM checkpoints bind member, USD balance, preview, and outgoing request', {timeout:45_000}, async()=>{
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage();
    const base='http://127.0.0.1:4200';
    const profile=createMifosProfile({baseUrl:base,productIds:{'Everyday Savings':3}});
    const inputs=inputSchema.parse({clientReference:'10001',accountReference:'SAV-1001',externalReference:'CU-REVIEW-001'});
    const shell=(html:string)=>`<style>mifosx-clients-view,mifosx-savings-account-view,mifosx-savings-account-preview-step,mat-card-subtitle,mat-card-title{display:block}td,span{padding:3px}i{display:inline-block;width:15px;height:15px;background:green}</style>${html.replace(/(<mifosx-(?:account-number|external-identifier)>)([^<]+)(<\/mifosx-(?:account-number|external-identifier)>)/g, '$1<span class="m-l-5">$2</span>$3')}`;
    let html=shell(`<mifosx-clients-view><mat-card-title><mifosx-entity-name>Alex Morgan</mifosx-entity-name></mat-card-title><mat-card-subtitle><table><tr><td><b>Client</b></td><td><mifosx-account-number>10001</mifosx-account-number></td></tr><tr><td>External Id</td><td><mifosx-external-identifier>10001</mifosx-external-identifier></td></tr></table></mat-card-subtitle><table><tr><th>Savings Product</th><th>Last Active</th></tr><tr><td><mifosx-long-text>Everyday Savings</mifosx-long-text></td><td><i class="fa-stop status-active"></i><mifosx-account-number>SAV-1001</mifosx-account-number></td></tr></table></mifosx-clients-view>`);
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto(`${base}/clients/7/general`);
    assert.equal(await profile.atCheckpoint(page,'client'),true);
    assert.deepEqual(await profile.checkpoint(page,'client',inputs),{clientReference:'10001'});
    assert.equal(await profile.resolveAccount!(page,inputs),'SAV-1001');
    await assert.rejects(()=>profile.checkpoint(page,'client',{...inputs,clientReference:'10002'}),/do not match/);

    html=shell(`<mifosx-savings-account-view><mat-card-title><h3><i class="fa-stop"></i><span><mifosx-long-text>Everyday Savings</mifosx-long-text></span><mifosx-account-number>SAV-1001</mifosx-account-number></h3><span class="account-overview">Client name: Alex Morgan <mifosx-account-number>10001</mifosx-account-number></span></mat-card-title><table class="account-overview"><tr><td>Current Balance</td><td>$12,540.75</td></tr></table><table><tr><td>Currency</td><td>US Dollar [USD]</td></tr></table></mifosx-savings-account-view><div class="mat-tooltip">Active</div>`);
    await page.goto(`${base}/clients/7/savings-accounts/11/general`);
    const output=await profile.checkpoint(page,'account',inputs);
    assert.deepEqual(output,{clientReference:'10001',accountReference:'SAV-1001',balance:'12540.75',currency:'USD',status:'Active'});
    await assert.rejects(()=>profile.checkpoint(page,'account',{...inputs,accountReference:'SAV-9999'}),/Timeout|does not match/);
    html=html.replace('Client name: Alex Morgan <mifosx-account-number><span class="m-l-5">10001</span></mifosx-account-number>','Client Name: Alex Morgan');await page.reload();
    assert.equal((await profile.checkpoint(page,'account',inputs)).clientReference,'10001');
    html=html.replace('Client Name: Alex Morgan','Client Name: Taylor Reed');await page.reload();
    await assert.rejects(()=>profile.checkpoint(page,'account',inputs),/member name does not match/);
    html=html.replace('Client Name: Taylor Reed','Client Name: Alex Morgan');

    html=html.replace('[USD]','[CAD]');await page.reload();
    await assert.rejects(()=>profile.checkpoint(page,'account',inputs),/not USD/);

    // Reused Angular views can change while an asynchronous tooltip is read.
    // A new status/reference must never be returned with the old account number.
    html=shell(`<mifosx-savings-account-view><mat-card-title><h3><i class="fa-stop" onmouseenter="document.querySelector('h3 > mifosx-account-number').textContent='000000003'"></i><span><mifosx-long-text>Everyday Savings</mifosx-long-text></span><mifosx-account-number>SAV-1001</mifosx-account-number></h3><span class="account-overview">Client Name: Alex Morgan</span></mat-card-title><table><tr><td>Currency</td><td>US Dollar [USD]</td></tr><tr><td>External Id</td><td><mifosx-external-identifier>CU-REVIEW-001</mifosx-external-identifier></td></tr></table></mifosx-savings-account-view><div class="mat-tooltip">Submitted and pending approval</div>`);
    await page.mouse.move(700,700);
    await page.goto(`${base}/clients/7/savings-accounts/3/general`);
    await assert.rejects(()=>profile.checkpoint(page,'submitted',inputs),/changed during verification/);
    assert.equal((await profile.checkpoint(page,'submitted',inputs)).applicationReference,'000000003');

    const renderTerms=()=>Object.entries(terms).map(([key,value])=>`<div><span>${key}</span><span>${key==='External Id'?`<mifosx-external-identifier>${value}</mifosx-external-identifier>`:value}</span></div>`).join('');
    html=shell(`<mifosx-savings-account-preview-step>${renderTerms()}<button>Submit</button></mifosx-savings-account-preview-step>`);
    await page.goto(`${base}/clients/7/savings-accounts/create`);
    const summary=await profile.checkpoint(page,'preview',inputs) as Record<string,string>;
    assert.equal(summary.product,'Everyday Savings');
    assert.equal(summary.currency,'USD');
    assert.match(summary.previewText,/Nominal Annual Interest\s*0 %/);
    assert.equal(await profile.isCommitTarget(page,page.getByRole('button',{name:'Submit'})),true);
    const request=(payload:unknown)=>({url:()=>`${base}/fineract-provider/api/v1/savingsaccounts`,method:()=>'POST',postDataJSON:()=>payload,frame:()=>({page:()=>page})}) as unknown as Request;
    assert.equal(profile.validateCommit!(request(body),inputs,summary),true);
    for(const patch of [{clientId:8},{productId:4},{externalId:'CHANGED'},{nominalAnnualInterestRate:10}])assert.equal(profile.validateCommit!(request({...body,...patch}),inputs,summary),false);
    assert.equal(profile.validateCommit!(request(body),inputs,{...summary,product:'Growth Savings'}),false);
    await page.goto(`${base}/clients/8/savings-accounts/create`);
    await assert.rejects(()=>profile.checkpoint(page,'preview',inputs),/Verify this member/);

    html=shell(`<label for="member">Member reference</label><input id="member" value="10001"><input type="text" formcontrolname="password" value="synthetic-secret"><mifosx-clients><table><tr><td class="mat-column-displayName">Alex Morgan</td><td class="mat-column-externalId"><mifosx-external-identifier>10001</mifosx-external-identifier></td></tr><tr><td class="mat-column-displayName">Taylor Reed</td><td class="mat-column-externalId"><mifosx-external-identifier>10002</mifosx-external-identifier></td></tr></table></mifosx-clients><mifosx-clients-view><table><tr><th>Savings Product</th><th>Last Active</th></tr><tr><td><mifosx-account-number>SAV-1001</mifosx-account-number></td><td>Everyday Savings</td></tr></table></mifosx-clients-view><mifosx-savings-account-details-step><mat-form-field><mat-label>Product Name</mat-label><mat-select role="combobox" formcontrolname="productId"><span class="mat-select-value-text">Everyday Savings</span></mat-select></mat-form-field><button>Next</button></mifosx-savings-account-details-step><mifosx-savings-account-terms-step hidden><button>Next</button></mifosx-savings-account-terms-step><div role="option">Growth Savings</div>`);
    await page.goto(`${base}/clients`);
    const observation=await observe(page);
    assert.ok(!JSON.stringify(observation.controls).includes('synthetic-secret'));
    assert.equal(observation.controls.find(control=>control.name==='Member reference')?.locator.kind,'label');
    const combo=observation.controls.find(control=>control.name==='Product Name')!;
    assert.equal(combo.role,'combobox');
    assert.equal(combo.value,'Everyday Savings');
    assert.equal(await locate(page,combo.locator,inputs).count(),1);
    assert.ok(observation.controls.some(control=>control.role==='option'&&control.name==='Growth Savings'));
    assert.equal(observation.controls.filter(control=>control.name==='Next').length,1);
    assert.equal(observation.controls.find(control=>control.name==='Next')?.locator.scope,'mifosx-savings-account-details-step:visible');
    const member=observation.controls.find(control=>control.name==='Open member 10001 · Alex Morgan')!;
    const parameterized=profile.parameterize(member.locator,inputs);
    assert.match(parameterized.value,/\{\{clientReference\}\}/);
    assert.equal(await locate(page,parameterized,{...inputs,clientReference:'10002'}).innerText(),'Taylor Reed');
    const savings=observation.controls.find(control=>control.name==='View account SAV-1001')!;
    assert.match(profile.parameterize(savings.locator,inputs).value,/\{\{accountReference\}\}/);
  }finally{await browser.close();}
});
