import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'vite';
import type {AddressInfo} from 'node:net';
import type {AppState,Run} from '../src/shared/contracts.js';
import {launchBrowser} from '../src/server/surface.js';

test('account picker requires an explicit choice, clears stale ownership and submits the selected reference', {timeout:30_000},async()=>{
 const server=await createServer({configFile:false,root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
 const origin=`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
 const browser=await launchBrowser();
 try{
  const now=new Date().toISOString();
  const run:Run={id:'selection-run',targetId:'mifos-x',mode:'replay',task:'balance',goal:'Read member 10001 savings balance',status:'awaiting_human',effect:'none',inputs:{clientReference:'10001',accountReference:'',product:'Everyday Savings',externalReference:'LOCAL-001'},scenario:'normal',createdAt:now,updatedAt:now,sessionId:'selection-session',owner:'none',epoch:7,stepIndex:0,steps:[],events:[],frameRevision:0,viewport:{width:1280,height:800},modelCalls:0,intervention:{code:'ACCOUNT_SELECTION_REQUIRED',reason:'Choose one account.',createdAt:now,accountSelection:{clientReference:'10001',choices:[{accountReference:'SAV-1001',product:'Everyday Savings',status:'Active'},{accountReference:'000000002',product:'Everyday Savings',status:'Submitted and pending approval'}]}}};
  const state:AppState={runs:[run],capabilities:[],providers:[],target:{id:'mifos-x',name:'Mifos X local',url:'http://127.0.0.1:4200',kind:'local',synthetic:true},runtime:{mode:'local',dataPath:'.local/test',browserAvailable:true,version:'test'}};
  const requests:unknown[]=[];
  const page=await browser.newPage();
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/api/state')return route.fulfill({json:state});
   if(url.pathname.endsWith('/frame'))return route.fulfill({json:{error:'No frame'},status:404});
   if(url.pathname.endsWith('/select-account')){
    requests.push(route.request().postDataJSON());
    if(requests.length===1){run.epoch=8;return route.fulfill({status:409,json:{error:'Control ownership changed. Refresh the session before trying again.'}});}
    run.status='running';run.owner='automation';run.epoch=9;run.intervention=undefined;
    return route.fulfill({json:run});
   }
   if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{error:'Unexpected request'}});
   return route.continue();
  });
  await page.goto(origin);await page.getByRole('button',{name:'Balance lookup',exact:true}).click();
  const card=page.locator('#run-account-selection'),button=card.getByRole('button',{name:'Select account & continue',exact:true});
  await card.waitFor({state:'visible'});
  assert.equal(await card.locator('input:checked').count(),0);assert.equal(await button.isDisabled(),true);
  assert.match(await card.innerText(),/Member 10001/);assert.match(await card.innerText(),/Submitted and pending approval/);
  assert.equal(await page.getByRole('button',{name:'Validate & resume',exact:true}).count(),0);
  await card.locator('input[value="SAV-1001"]').check();await button.click();
  await page.getByText('Control ownership changed. Refresh the session before trying again.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('#run-account-selection input:checked').length===0);
  assert.equal(await button.isDisabled(),true);
  await card.locator('input[value="000000002"]').check();await button.click();
  await card.waitFor({state:'hidden'});
  assert.deepEqual(requests,[{epoch:7,accountReference:'SAV-1001'},{epoch:8,accountReference:'000000002'}]);
  run.status='completed';run.owner='none';run.result='business_outcome';run.outcomeCode='ACCOUNT_NOT_ACTIVE';run.error='This savings account is not active.';
  await page.locator('.result-message').waitFor({state:'visible'});
  assert.equal(await page.locator('.result-error').count(),0);
 }finally{await browser.close();await server.close();}
});
