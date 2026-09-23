import type { Locator, Page, Request } from 'playwright-core';
import { capabilitySchema, type CapabilityRecord, type CapabilityStep, type RunInputs, type TargetLocator, type TaskKind } from '../../shared/contracts.js';
import { makeRecord } from '../capabilities.js';
import { AccountSelectionRequired, TargetBusinessError, type AccountChoice, type Checkpoint, type TargetProfile } from './types.js';
import { createMifosMemberAdapter, MEMBER_FAMILY, MEMBER_GENERAL, MEMBER_PREVIEW, mifosMemberCapability } from './mifos-member.js';

/** Selectors audited against this source release, not claimed as live qualification. */
export const MIFOS_SOURCE = 'https://github.com/openMF/web-app/tree/v1.0.0-fineract1.11';
export const MIFOS_RELEASE = 'v1.0.0-fineract1.11';
const CLIENT = 'mifosx-clients-view';
const ACCOUNT = 'mifosx-savings-account-view';
const PREVIEW = 'mifosx-savings-account-preview-step:visible';
const SEARCH = 'input[placeholder="Search by client name, external Id, mobile"]';
const SEARCH_RESULT = 'mifosx-clients tr:has(td.mat-column-externalId mifosx-external-identifier span:text-is("{{clientReference}}")) td.mat-column-displayName';
const SAVINGS_TABLE = `${CLIENT} table:has(th:text-is("Savings Product")):has(th:text-is("Last Active"))`;
const ACCOUNT_NUMBER = `${SAVINGS_TABLE} mifosx-account-number span:text-is("{{accountReference}}")`;
const API = '/fineract-provider/api/v1';

export interface MifosTargetOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Seed metadata is used only to bind a UI-reviewed product to the outgoing request. */
  productIds?: Partial<Record<RunInputs['product'], number>>;
  officeId?: number;
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
function pathOf(page: Page): string {
  const url = new URL(page.url());
  return url.hash.startsWith('#/') ? url.hash.slice(1).split('?')[0] : url.pathname;
}
function memberRoute(page: Page): string | undefined { return pathOf(page).match(/^\/clients\/(\d+)(?:\/|$)/)?.[1]; }
function accountRoute(page: Page): string | undefined { return pathOf(page).match(/^\/clients\/\d+\/savings-accounts\/(\d+)(?:\/|$)/)?.[1]; }
async function waitAccountNumber(page:Page,expected:string):Promise<void>{
  await page.waitForURL(url=>/^\/clients\/\d+\/savings-accounts\/\d+(?:\/|$)/.test(url.hash.startsWith('#/')?url.hash.slice(1):url.pathname),{timeout:10_000});
  const escaped=expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  await page.locator(`${ACCOUNT} mat-card-title h3 > mifosx-account-number`).filter({hasText:new RegExp(`^\\s*${escaped}\\s*$`)}).waitFor({state:'visible',timeout:10_000});
}

async function oneText(locator: Locator, label: string): Promise<string> {
  await locator.waitFor({state:'visible', timeout:10_000});
  if (await locator.count() !== 1) throw new Error(`Expected one visible ${label}.`);
  const value = normalize(await locator.innerText());
  if (!value) throw new Error(`The visible ${label} is empty.`);
  return value;
}
async function tableValue(root: Locator, label: string): Promise<string> {
  const row = root.locator('tr:visible').filter({has:root.page().locator('td:first-child').filter({hasText:new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`)})});
  return oneText(row.locator('td').nth(1), label);
}
async function expandedIdentifier(locator: Locator, expected: string): Promise<string> {
  let text = await oneText(locator, 'external reference');
  if (text !== expected && expected.length>15) {
    await locator.locator('span.m-l-5').click();
    text = await oneText(locator, 'expanded external reference');
  }
  return text;
}
async function statusText(page: Page): Promise<string> {
  // matTooltip's hidden description is deliberately not used as evidence.
  const icon = page.locator(`${ACCOUNT} mat-card-title h3 i.fa-stop:visible`);
  if (await icon.count() !== 1) throw new Error('The savings status indicator is ambiguous.');
  await icon.hover();
  const tooltip = page.locator('.mat-tooltip:visible, .mat-mdc-tooltip-surface:visible, [role="tooltip"]:visible');
  return oneText(tooltip, 'savings status tooltip');
}
export function parseMifosUsdBalance(text: string): string {
  const value = normalize(text);
  if (!/^-?\$(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}$/.test(value)) throw new Error('The visible USD balance is not an unambiguous US dollar amount.');
  return value.replace('$','').replaceAll(',','');
}

/** Fail closed if an application adds fields not represented by this pinned preview. */
export function mifosTermsMatch(body:Record<string,unknown>, terms:Record<string,string>):boolean {
  const allowed=new Set(['clientId','productId','externalId','fieldOfficerId','submittedOnDate','dateFormat','monthDayFormat','locale','charges','nominalAnnualInterestRate','interestCompoundingPeriodType','interestPostingPeriodType','interestCalculationType','interestCalculationDaysInYearType','minRequiredOpeningBalance','withdrawalFeeForTransfers','lockinPeriodFrequency','lockinPeriodFrequencyType','allowOverdraft','enforceMinRequiredBalance','minRequiredBalance']);
  if(Object.keys(body).some(key=>!allowed.has(key)))return false;
  if(body.locale!=='en'||body.dateFormat!=='dd MMMM yyyy'||body.monthDayFormat!=='dd MMMM'||normalize(String(body.submittedOnDate))!==terms['Submitted On'])return false;
  if(!Array.isArray(body.charges)||body.charges.length!==0)return false;
  if(body.fieldOfficerId!==''&&body.fieldOfficerId!==null&&body.fieldOfficerId!==undefined)return false;
  if(body.allowOverdraft!==false||body.enforceMinRequiredBalance!==false||terms['Is Overdraft Allowed']!=='No'||terms['Enforce Minimum Balance']!=='No')return false;
  const blankOrZero=(value:unknown)=>value===undefined||value===null||value===''||value===0;
  if(!blankOrZero(body.lockinPeriodFrequency)||!blankOrZero(body.lockinPeriodFrequencyType)||terms['Lock-in Period'])return false;
  const amountMatches=(key:string,label:string,suffix='')=>{
    // The pinned FormatNumberPipe renders numeric zero as an empty string.
    const visible=(terms[label]||'0').replaceAll(',','').replace(suffix,'').trim()||'0';
    const actual=blankOrZero(body[key])?'0':String(body[key]);
    return /^\d+(?:\.\d+)?$/.test(visible)&&/^\d+(?:\.\d+)?$/.test(actual)&&Number(visible)===Number(actual);
  };
  if(!amountMatches('nominalAnnualInterestRate','Nominal Annual Interest','%')||!amountMatches('minRequiredOpeningBalance','Minimum Opening Balance')||!amountMatches('minRequiredBalance','Minimum Balance'))return false;
  if(typeof body.withdrawalFeeForTransfers!=='boolean'||terms['Apply Withdrawal Fee for Transfers']!==(body.withdrawalFeeForTransfers?'Yes':'No'))return false;
  // Published Fineract enum values: https://fineract.apache.org/docs/legacy/#savingsproducts_template
  const periods:Record<string,string>={'1':'Daily','2':'Weekly','3':'Bi-Weekly','4':'Monthly','5':'Quarterly','6':'Semi-Annual','7':'Annually','8':'No Compounding - Simple Interest'};
  const calculations:Record<string,string>={'1':'Daily Balance','2':'Average Daily Balance'};
  return !!terms['Interest Compounding Period'] && !!terms['Interest Posting Period'] && !!terms['Interest Calculated using']
    && periods[String(body.interestCompoundingPeriodType)]===terms['Interest Compounding Period']
    && periods[String(body.interestPostingPeriodType)]===terms['Interest Posting Period']
    && calculations[String(body.interestCalculationType)]===terms['Interest Calculated using']
    && `${body.interestCalculationDaysInYearType} Days`===terms['Days in Year'];
}

export function mifosNetworkPolicy(baseUrl: string, request: Pick<Request, 'url'|'method'>): 'read'|'authentication'|'commit'|'deny' {
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return 'deny';
  if (['GET','HEAD','OPTIONS'].includes(request.method())) return 'read';
  // Official ClientsService.searchByText uses POST for a read-only paged query.
  // ApiPrefixInterceptor strips the default /v1 prefix for explicit /v2 routes.
  if (request.method()==='POST' && url.pathname==='/fineract-provider/api/v2/clients/search' && !url.search) return 'read';
  if (request.method() === 'POST' && url.pathname === `${API}/authentication`) return 'authentication';
  if (request.method() === 'POST' && url.pathname === `${API}/savingsaccounts` && !url.search) return 'commit';
  if (request.method() === 'POST' && url.pathname === `${API}/clients` && !url.search) return 'commit';
  return 'deny';
}

export function mifosCapabilities(): CapabilityRecord[] {
  const checkpoint = (kind:Checkpoint):CapabilityStep => ({id:`verify-${kind}`, label:`Verify Mifos ${kind === 'client' ? 'member' : kind}`, action:'checkpoint', checkpoint:kind, effect:'read'});
  const common:CapabilityStep[] = [
    {id:'open',label:'Open Mifos members',action:'navigate',path:'/#/clients',effect:'read'},
    {id:'search-value',label:'Search the member external reference',action:'fill',target:{kind:'css',value:SEARCH,exact:true},value:{source:'input',key:'clientReference'},effect:'form'},
    {id:'search',label:'Search Mifos members',action:'press',target:{kind:'css',value:SEARCH,exact:true},value:{source:'literal',value:'Enter'},effect:'read'},
    {id:'client',label:'Open the exact matching member',action:'click',target:{kind:'css',value:SEARCH_RESULT,exact:true},effect:'read'},
    checkpoint('client'),
  ];
  const preparation:CapabilityStep[] = [
    {id:'menu',label:'Open member actions',action:'click',target:{kind:'role',role:'button',value:'Client actions',exact:true},effect:'read'},
    {id:'applications-menu',label:'Open account applications',action:'click',target:{kind:'role',role:'menuitem',value:'Applications',exact:true},effect:'read'},
    {id:'new',label:'Start a savings application',action:'click',target:{kind:'role',role:'menuitem',value:'New Savings Account',exact:true},effect:'form'},
    {id:'product',label:'Choose the requested product',action:'select',target:{kind:'css',value:'mat-select[formcontrolname="productId"]',exact:true},value:{source:'input',key:'product'},effect:'form'},
    {id:'reference',label:'Set the application reference',action:'fill',target:{kind:'label',value:'External ID',exact:true},value:{source:'input',key:'externalReference'},effect:'form'},
    ...['details','terms','charges'].map((part):CapabilityStep=>({id:`next-${part}`,label:`Review savings ${part}`,action:'click',target:{kind:'role',role:'button',value:'Next',exact:true,scope:`mifosx-savings-account-${part}-step:visible`},effect:'form'})),
    checkpoint('preview'),
  ];
  const savings=(['balance','prepare','submit'] as const).map(task=>{
    const steps:CapabilityStep[] = task==='balance' ? [...common,{id:'account',label:'Open the requested savings account',action:'click',target:{kind:'css',value:ACCOUNT_NUMBER,exact:true},effect:'read'},checkpoint('account')] : [...common,...preparation];
    if (task==='submit') steps.push({id:'submit',label:'Submit the approved application once',action:'click',target:{kind:'role',role:'button',value:'Submit',exact:true,scope:PREVIEW},effect:'commit'},checkpoint('submitted'));
    return makeRecord(capabilitySchema.parse({schemaVersion:1,id:`mifos-${task}-v1`,version:'1.1.0',name:{balance:'Mifos · Read savings balance',prepare:'Mifos · Prepare savings application',submit:'Mifos · Submit reviewed application'}[task],description:`Authored from the Mifos X ${MIFOS_RELEASE} UI source. Run against the local pinned stack to qualify this draft.`,task,target:'mifos-x',inputs:'banking-inputs-v1',output:`${task==='balance'?'balance':task==='prepare'?'prepared':'submitted'}-v1`,steps,provenance:{kind:'authored'}}),'draft');
  });
  return [...savings,mifosMemberCapability(MIFOS_RELEASE)];
}

export function createMifosProfile(options:MifosTargetOptions): TargetProfile {
  const baseUrl = new URL(options.baseUrl).origin;
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('The Mifos profile requires a local loopback target.');
  const identities = new WeakMap<Page, {reference:string;memberAccountNumber:string;routeId:string;displayName:string}>();
  const previews = new WeakMap<Page, {summary:Record<string,string>;terms:Record<string,string>}>();
  const tasks=new WeakMap<Page,TaskKind>();
  const members=createMifosMemberAdapter({baseUrl,officeId:options.officeId});

  async function client(page:Page, inputs:RunInputs):Promise<Record<string,unknown>> {
    const root=page.locator(CLIENT);
    const reference=await tableValue(root.locator('mat-card-subtitle'),'Client');
    const external=await tableValue(root.locator('mat-card-subtitle'),'External Id');
    const displayName=await oneText(root.locator('mat-card-title mifosx-entity-name'),'member name');
    const routeId=memberRoute(page);
    if (!/^[A-Za-z0-9-]{1,32}$/.test(reference) || external!==inputs.clientReference || !routeId) throw new Error('The visible Mifos member and external reference do not match the requested member.');
    identities.set(page,{reference:external,memberAccountNumber:reference,routeId,displayName});
    return {clientReference:external};
  }
  function assertIdentity(page:Page, inputs:RunInputs):void {
    const identity=identities.get(page);
    if (!identity || identity.reference!==inputs.clientReference || identity.routeId!==memberRoute(page)) throw new Error('Verify this member in the visible Mifos client screen before preparing an application.');
  }
  async function preview(page:Page,inputs:RunInputs):Promise<Record<string,string>> {
    assertIdentity(page,inputs);
    if (!pathOf(page).endsWith('/savings-accounts/create')) throw new Error('The browser is not on a new savings application.');
    const root=page.locator(PREVIEW);
    await root.waitFor({state:'visible'});
    const external=root.locator('mifosx-external-identifier');
    if (await expandedIdentifier(external,inputs.externalReference)!==inputs.externalReference) throw new Error('The preview external reference does not match.');
    // All visible terms (including fees and interest) are included in the approval binding.
    const values = await root.evaluate(el=>Array.from(el.querySelectorAll('div')).flatMap(div=>{
      if (!(div as HTMLElement).getClientRects().length) return [];
      const spans=Array.from(div.children).filter(child=>child.tagName==='SPAN');
      if(spans.length!==2)return [];
      return [[(spans[0] as HTMLElement).innerText.replace(/\s+/g,' ').trim().replace(/\s*:$/,''),(spans[1] as HTMLElement).innerText.replace(/\s+/g,' ').trim()]];
    }));
    const entries=Object.fromEntries(values);
    if (entries.Product!==inputs.product || entries.Currency!=='USD') throw new Error('The preview product or currency does not match the requested USD application.');
    if (!entries['Submitted On']||!Object.hasOwn(entries,'Nominal Annual Interest')) throw new Error('The preview submission date or interest field is missing.');
    const summary:Record<string,string>={clientReference:inputs.clientReference,product:inputs.product,externalReference:inputs.externalReference,currency:'USD',submittedOn:entries['Submitted On'],nominalAnnualInterest:entries['Nominal Annual Interest']==='%'?'0 %':entries['Nominal Annual Interest'],previewText:normalize(await root.innerText())};
    previews.set(page,{summary,terms:entries});
    return summary;
  }
  async function account(page:Page,inputs:RunInputs,resolved?:Partial<RunInputs>, submitted=false,expectedAccount?:string):Promise<Record<string,unknown>> {
    const root=page.locator(ACCOUNT);
    await root.waitFor({state:'visible'});
    const expected=expectedAccount||(!submitted&&(inputs.accountReference||resolved?.accountReference));
    if(expected)await waitAccountNumber(page,expected);
    const observedRoute=pathOf(page);
    if(!accountRoute(page))throw new Error('The browser has not reached an account detail route.');
    assertIdentity(page,inputs);
    const memberName=await oneText(root.locator('span.account-overview'),'account member name');
    const identity=identities.get(page)!;
    const accountMemberNumber=root.locator('span.account-overview mifosx-account-number');
    if(await accountMemberNumber.count()){
      if(await oneText(accountMemberNumber,'account member reference')!==identity.memberAccountNumber)throw new Error('The savings account belongs to a different member.');
    }else if(memberName!==`Client Name: ${identity.displayName}`)throw new Error('The savings account member name does not match the previously verified member.');
    const clientReference=identity.reference;
    const accountReference=await oneText(root.locator('mat-card-title h3 > mifosx-account-number'),'savings account reference');
    const product=await oneText(root.locator('mat-card-title h3 mifosx-long-text'),'savings product');
    if(product!==inputs.product)throw new Error('The savings product does not match the reviewed task.');
    const currency=await tableValue(root,'Currency');
    if(!/\[USD\]$/.test(currency))throw new Error('The visible savings currency is not USD.');
    const status=await statusText(page);
    async function assertStableView(){
      const finalReference=await oneText(root.locator('mat-card-title h3 > mifosx-account-number'),'savings account reference');
      if(finalReference!==accountReference||pathOf(page)!==observedRoute)throw new Error('The visible savings account changed during verification.');
    }
    if(submitted){
      const external=await expandedIdentifier(root.locator('tr:visible').filter({has:page.locator('td:first-child').filter({hasText:/^\s*External Id\s*$/})}).locator('mifosx-external-identifier'),inputs.externalReference);
      if(external!==inputs.externalReference)throw new Error('The submitted application reference does not match.');
      if(status!=='Submitted and pending approval')throw new Error('The application is not visibly submitted and pending approval.');
      if(!accountRoute(page))throw new Error('The submitted account route is missing.');
      await assertStableView();
      return {clientReference,product,externalReference:external,applicationReference:accountReference,currency:'USD',status};
    }
    if(accountReference!==(inputs.accountReference||resolved?.accountReference))throw new Error('The visible savings account does not match the requested account.');
    if(status!=='Active')throw new TargetBusinessError('ACCOUNT_NOT_ACTIVE',`Savings account ${accountReference} is ${status}; this workflow reads an active account's current balance.`);
    const balance=parseMifosUsdBalance(await tableValue(root.locator('table.account-overview'),'Current Balance'));
    await assertStableView();
    return {clientReference,accountReference,balance,currency:'USD',status};
  }
  async function openMember(page:Page,inputs:RunInputs):Promise<void>{
    await page.goto(`${baseUrl}/#/clients`);
    await page.locator(SEARCH).fill(inputs.clientReference);
    await page.locator(SEARCH).press('Enter');
    const match=page.locator(SEARCH_RESULT.replace('{{clientReference}}',inputs.clientReference));
    await match.waitFor({state:'visible'});
    if(await match.count()!==1)throw new Error('The member search did not return one exact external reference.');
    await match.click();
    await client(page,inputs);
  }
  async function listAccountChoices(page:Page,inputs:RunInputs):Promise<AccountChoice[]>{
    await client(page,inputs);
    const memberPath=pathOf(page);
    await page.locator(SAVINGS_TABLE).waitFor({state:'visible',timeout:10_000});
    const rows=page.locator(SAVINGS_TABLE).locator('tr:has(td)');
    const count=await rows.count();
    if(count>50)throw new Error('Too many visible savings accounts for a bounded account selection. Inspect this member manually.');
    const choices:AccountChoice[]=[];
    const seen=new Set<string>();
    // These labels come from the pinned UI's rendered StatusLookupPipe classes.
    // The overdue class intentionally represents either inactive or dormant.
    const statusLabels:Record<string,string>={'status-active':'Active','status-pending':'Submitted and pending approval','status-approved':'Approved','status-active-overdue':'Inactive or dormant','status-matured':'Matured'};
    for(let i=0;i<count;i++){
      const row=rows.nth(i);
      const product=await oneText(row.locator('mifosx-long-text'),'savings product');
      if(product!==inputs.product)continue;
      const accountReference=await oneText(row.locator('mifosx-account-number'),'savings account number');
      if(!/^[A-Za-z0-9-]{3,32}$/.test(accountReference)||seen.has(accountReference))throw new Error('The visible savings account references are invalid or duplicated.');
      const indicator=row.locator('i.fa-stop:visible');
      let status='Status unavailable';
      if(await indicator.count()===1){
        const classes=(await indicator.getAttribute('class')||'').split(/\s+/).filter(value=>Object.hasOwn(statusLabels,value));
        if(classes.length!==1)throw new Error('The savings account status indicator is not recognized.');
        status=statusLabels[classes[0]];
      }else throw new Error('The savings account status indicator is missing or ambiguous.');
      choices.push({accountReference,accountNumber:accountReference,product,status});seen.add(accountReference);
    }
    await client(page,inputs);
    if(pathOf(page)!==memberPath)throw new Error('The visible member changed while savings account choices were being verified.');
    return choices;
  }
  const profile:TargetProfile={
    id:'mifos-x',name:'Mifos X · Local US credit union',baseUrl,entryPath:'/#/clients',version:MIFOS_RELEASE,
    async bootstrap(page,scenario,assertActive){
      if(scenario!=='normal')throw new Error('Fault injection scenarios are available only in the local lab.');
      assertActive();await page.goto(`${baseUrl}/#/login`);
      const user=page.locator('#login-form input[formcontrolname="username"]');
      await user.waitFor({state:'visible',timeout:20_000});
      assertActive();await user.fill(options.username||'mifos');
      assertActive();await page.locator('#login-form input[formcontrolname="password"]').fill(options.password||'password');
      assertActive();await page.getByRole('button',{name:'Login',exact:true}).click();
      await page.locator('#login-form').waitFor({state:'hidden',timeout:30_000});
      // The pinned published UI displays an informational authorized-use notice.
      const notice=page.getByRole('dialog',{name:'Warning',exact:true});
      try{await notice.waitFor({state:'visible',timeout:2_000});}catch{/* The notice may be disabled in local settings. */}
      if(await notice.isVisible()){
        if(!(await notice.innerText()).includes('This system is for authorized use only.'))throw new Error('An unexpected Mifos sign-in notice requires review.');
        assertActive();await notice.getByRole('button',{name:'Close',exact:true}).click();
      }
      assertActive();await page.goto(`${baseUrl}/#/clients`);
      await page.locator(SEARCH).waitFor({state:'visible',timeout:20_000});
    },
    async awaitObservationReady(page,step,inputs){
      // Angular's router can still be on the old page when click() returns.
      // Await the visible destination of the observed action, not network idle
      // or a fixed sleep; background requests do not prove UI readiness.
      const target=step.target;
      const value=target?.value;
      if(step.action==='press'&&value===SEARCH&&step.value?.source==='literal'&&step.value.value==='Enter'){
        await members.waitSearch(page,inputs);
        if(tasks.get(page)!=='member'&&await page.getByText('No client was found',{exact:true}).isVisible())throw new TargetBusinessError('NOT_FOUND','Mifos did not find a member with the requested external reference.');
      }
      if(tasks.get(page)==='member'){
        if(step.action==='click'&&value==='Create Client'){
          await page.waitForURL(url=>url.hash==='#/clients/create',{timeout:10_000});
          await page.locator(`${MEMBER_GENERAL} input[formcontrolname="firstname"]`).waitFor({state:'visible',timeout:10_000});
        }
        if(step.action==='click'&&value==='Next'&&target?.scope===MEMBER_GENERAL)await page.locator(MEMBER_FAMILY).waitFor({state:'visible',timeout:10_000});
        if(step.action==='click'&&value==='Next'&&target?.scope===MEMBER_FAMILY)await page.locator(MEMBER_PREVIEW).waitFor({state:'visible',timeout:10_000});
        if(step.action==='click'&&value==='Submit'&&target?.scope===MEMBER_PREVIEW){
          await page.waitForURL(url=>/^#\/clients\/\d+\/general$/.test(url.hash),{timeout:10_000});
          await page.locator(`${CLIENT} mat-card-subtitle`).waitFor({state:'visible',timeout:10_000});
        }
      }
      if(step.action==='navigate'){
        await page.locator(SEARCH).waitFor({state:'visible',timeout:10_000});
        return;
      }
      if(step.action==='click'&&target?.kind==='css'&&[SEARCH_RESULT,SEARCH_RESULT.replace('{{clientReference}}',inputs.clientReference)].includes(value!)){
        await page.waitForURL(url=>/^#\/clients\/\d+\/general$/.test(url.hash),{timeout:10_000});
        await page.locator(`${CLIENT} mat-card-subtitle`).waitFor({state:'visible',timeout:10_000});
        await page.locator(SAVINGS_TABLE).waitFor({state:'visible',timeout:10_000});
        return;
      }
      if(step.action==='click'&&target?.kind==='css'&&[ACCOUNT_NUMBER,ACCOUNT_NUMBER.replace('{{accountReference}}',inputs.accountReference)].includes(value!)){
        await waitAccountNumber(page,inputs.accountReference);
        await page.locator(`${ACCOUNT} table.account-overview`).waitFor({state:'visible',timeout:10_000});
        return;
      }
      if(step.action==='click'&&target?.kind==='role'){
        if(value==='Client actions')await page.getByRole('menuitem',{name:'Applications',exact:true}).waitFor({state:'visible',timeout:10_000});
        if(value==='Applications')await page.getByRole('menuitem',{name:'New Savings Account',exact:true}).waitFor({state:'visible',timeout:10_000});
        if(value==='New Savings Account'){
          await page.waitForURL(url=>/^#\/clients\/\d+\/savings-accounts\/create$/.test(url.hash),{timeout:10_000});
          await page.locator('mifosx-savings-account-details-step:visible mat-select[formcontrolname="productId"]').waitFor({state:'visible',timeout:10_000});
        }
        const next:Record<string,string>={details:'terms',terms:'charges',charges:'preview'};
        const from=target.scope?.match(/^mifosx-savings-account-(details|terms|charges)-step:visible$/)?.[1];
        if(value==='Next'&&from)await page.locator(`mifosx-savings-account-${next[from]}-step:visible`).waitFor({state:'visible',timeout:10_000});
        if(value==='Submit'&&target.scope===PREVIEW){
          await page.waitForURL(url=>/^#\/clients\/\d+\/savings-accounts\/\d+(?:\/|$)/.test(url.hash),{timeout:10_000});
          await page.locator(`${ACCOUNT} mat-card-title h3 > mifosx-account-number`).waitFor({state:'visible',timeout:10_000});
        }
      }
    },
    async resolveInputs(page,task,inputs){tasks.set(page,task);return task==='member'?members.resolveInputs(page,inputs):{};},
    async checkpoint(page,kind,inputs,resolved){
      if(kind==='member_absent')return members.absent(page,{...inputs,...resolved});
      if(kind==='member_preview')return members.preview(page,{...inputs,...resolved});
      if(kind==='member_created')return members.created(page,{...inputs,...resolved});
      if(kind==='client')return client(page,inputs);
      if(kind==='preview')return preview(page,inputs);
      return account(page,inputs,resolved,kind==='submitted');
    },
    async atCheckpoint(page,kind){
      if(kind==='member_absent')return pathOf(page)==='/clients'&&await page.getByText('No client was found',{exact:true}).isVisible();
      if(kind==='member_preview')return await page.locator(MEMBER_PREVIEW).count()===1;
      if(kind==='member_created')return /^\/clients\/\d+\/general$/.test(pathOf(page))&&await page.locator(`${CLIENT} mat-card-subtitle:visible`).count()===1;
      if(kind==='client')return /^\/clients\/\d+\/general$/.test(pathOf(page))&&await page.locator(`${CLIENT} mat-card-subtitle:visible`).count()===1;
      if(kind==='preview')return await page.locator(PREVIEW).count()===1;
      return !!accountRoute(page)&&await page.locator(`${ACCOUNT}:visible`).count()===1;
    },
    async detectState(page){
      if(await page.locator('#login-form:visible').count())return {kind:'intervention',code:'SESSION_EXPIRED',message:'Sign in to the local Mifos session before returning control.'};
      if(tasks.get(page)!=='member'&&await page.getByText('No client was found',{exact:true}).filter({visible:true}).count())return {kind:'business',code:'NOT_FOUND',message:'Mifos did not find a matching member.'};
      const errors=page.locator('mat-error:visible, .alert-danger:visible');
      const notices=page.locator('.alert-danger:visible, .mat-snack-bar-container:visible, .mat-mdc-snack-bar-container:visible, .toast-error:visible, [role="alert"]:visible');
      const noticeText=normalize((await notices.allInnerTexts()).join(' '));
      if(/\b(?:permission denied|access denied|not authorized|unauthorized|forbidden|insufficient permissions)\b/i.test(noticeText))return {kind:'business',code:'PERMISSION_DENIED',message:noticeText.slice(0,500)};
      if(await errors.count())return {kind:'business',code:'TARGET_VALIDATION',message:normalize((await errors.allInnerTexts()).join(' ')).slice(0,500)};
      return undefined;
    },
    async isCommitTarget(_page,locator){return locator.evaluate(el=>!!el.closest('mifosx-savings-account-preview-step,mifosx-client-preview-step') && el.tagName==='BUTTON' && el.textContent?.trim()==='Submit');},
    networkPolicy(request){return mifosNetworkPolicy(baseUrl,request);},
    validateCommit(request,inputs,summary){
      try{
        if(mifosNetworkPolicy(baseUrl,request)!=='commit')return false;
        if(new URL(request.url()).pathname===`${API}/clients`)return tasks.get(request.frame().page())==='member'&&members.validateCommit(request,inputs,summary);
        const page=request.frame().page(),identity=identities.get(page),prepared=previews.get(page),body=request.postDataJSON();
        if(!identity||!prepared||JSON.stringify(prepared.summary)!==JSON.stringify(summary)||identity.reference!==inputs.clientReference||identity.routeId!==memberRoute(page))return false;
        if(!options.productIds?.[inputs.product])return false;
        return String(body.clientId)===identity.routeId && body.productId===options.productIds[inputs.product] && body.externalId===inputs.externalReference && mifosTermsMatch(body,prepared.terms);
      }catch{return false;}
    },
    parameterize(target,inputs,resolved){
      const actual={...inputs,...resolved};
      let value=target.value;
      if(target.kind==='css'){
        if(value===SEARCH_RESULT.replace('{{clientReference}}',actual.clientReference))return {...target,value:SEARCH_RESULT};
        if(value===ACCOUNT_NUMBER.replace('{{accountReference}}',actual.accountReference))return {...target,value:ACCOUNT_NUMBER};
      }
      for(const key of ['clientReference','accountReference','externalReference','product','firstName','lastName','memberActivationDate'] as const){if(actual[key]&&value===actual[key])value=`{{${key}}}`;}
      return {...target,value};
    },
    capabilities:mifosCapabilities,
    listAccountChoices,
    async resolveAccount(page,inputs){
      const choices=await listAccountChoices(page,inputs);
      if(choices.length===0)throw new TargetBusinessError('NO_SAVINGS_ACCOUNT',`Member ${inputs.clientReference} has no visible open ${inputs.product} account.`);
      if(choices.length>1)throw new AccountSelectionRequired(inputs.clientReference,choices);
      return choices[0].accountReference;
    },
    async reconcile(page,inputs,task){
      if(task==='member')return members.reconcile(page,inputs);
      await openMember(page,inputs);
      const memberUrl=page.url();
      await page.locator(SAVINGS_TABLE).waitFor({state:'visible'});
      const rows=page.locator(SAVINGS_TABLE).locator('tr:has(td)');
      const accountNumbers=await rows.locator('mifosx-account-number').allInnerTexts();
      if(accountNumbers.length>50)throw new Error('Too many savings accounts for bounded reconciliation. Inspect the application manually.');
      let match:{url:string;output:Record<string,unknown>}|undefined;
      for(const number of accountNumbers){
        await page.goto(memberUrl);
        await client(page,inputs);
        const row=page.locator(SAVINGS_TABLE).locator('mifosx-account-number').filter({hasText:new RegExp(`^\\s*${normalize(number).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`)});
        await row.click();
        const root=page.locator(ACCOUNT);await root.waitFor({state:'visible'});
        await waitAccountNumber(page,normalize(number));
        const ref=root.locator('tr:visible').filter({has:page.locator('td:first-child').filter({hasText:/^\s*External Id\s*$/})}).locator('mifosx-external-identifier');
        if(await ref.count()!==1)continue;
        if(await expandedIdentifier(ref,inputs.externalReference)!==inputs.externalReference)continue;
        const output=await account(page,inputs,undefined,true,normalize(number));
        if(match)throw new Error('Multiple applications have this external reference; reconciliation is ambiguous.');
        match={url:page.url(),output};
      }
      if(match){await page.goto(match.url);return account(page,inputs,undefined,true,String(match.output.applicationReference));}
      return undefined;
    },
  };
  return profile;
}
