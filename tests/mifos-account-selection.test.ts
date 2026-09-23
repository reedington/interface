import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inputSchema} from '../src/shared/contracts.js';
import {createMifosProfile} from '../src/server/targets/mifos.js';
import {AccountSelectionRequired,TargetBusinessError} from '../src/server/targets/types.js';
import {launchBrowser} from '../src/server/surface.js';

test('account choices bind visible member, product and status and never choose among multiple accounts', {timeout:20_000},async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage();
  const base='http://127.0.0.1:4200',profile=createMifosProfile({baseUrl:base});
  const inputs=inputSchema.parse({clientReference:'10001',accountReference:''});
  let ref='10001';
  let accounts=[['SAV-1001','Everyday Savings','status-active'],['000000002','Everyday Savings','status-pending'],['SAV-1003','Growth Savings','status-active']];
  let html='';
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
  const render=async()=>{
   html=`<style>mifosx-clients-view,mat-card-title,mat-card-subtitle{display:block}i{display:inline-block;width:10px;height:10px;background:green}</style><mifosx-clients-view><mat-card-title><mifosx-entity-name>Alex Morgan</mifosx-entity-name></mat-card-title><mat-card-subtitle><table><tr><td>Client</td><td>000000001</td></tr><tr><td>External Id</td><td>${ref}</td></tr></table></mat-card-subtitle><table><tr><th>Savings Product</th><th>Last Active</th></tr>${accounts.map(([number,product,status])=>`<tr><td><i class="fa-stop ${status}"></i><mifosx-account-number>${number}</mifosx-account-number></td><td><mifosx-long-text>${product}</mifosx-long-text></td></tr>`).join('')}</table></mifosx-clients-view>`;
   await page.goto(`${base}/#/clients/1/general`);await page.reload();
  };
  await render();
  const choices=await profile.listAccountChoices!(page,inputs);
  assert.deepEqual(choices,[{accountReference:'SAV-1001',accountNumber:'SAV-1001',product:'Everyday Savings',status:'Active'},{accountReference:'000000002',accountNumber:'000000002',product:'Everyday Savings',status:'Submitted and pending approval'}]);
  await assert.rejects(()=>profile.resolveAccount!(page,inputs),error=>error instanceof AccountSelectionRequired&&error.boundClientReference==='10001'&&JSON.stringify(error.choices)===JSON.stringify(choices));
  accounts=[accounts[0]];await render();
  assert.equal(await profile.resolveAccount!(page,inputs),'SAV-1001');
  accounts=[['SAV-1004','Everyday Savings','status-active']];await render();
  assert.deepEqual((await profile.listAccountChoices!(page,inputs)).map(choice=>choice.accountReference),['SAV-1004']);
  ref='10002';await render();
  await assert.rejects(()=>profile.listAccountChoices!(page,inputs),/do not match/);
  ref='10001';accounts=[];await render();
  await assert.rejects(()=>profile.resolveAccount!(page,inputs),error=>error instanceof TargetBusinessError&&error.code==='NO_SAVINGS_ACCOUNT');
  accounts=[['SAV-1001','Everyday Savings','status-active'],['SAV-1001','Everyday Savings','status-active']];await render();
  await assert.rejects(()=>profile.listAccountChoices!(page,inputs),/duplicated/);
 }finally{await browser.close();}
});

test('Mifos expected business refusals remain distinct from reparable authentication', {timeout:15_000},async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage(),profile=createMifosProfile({baseUrl:'http://127.0.0.1:4200'});
  await page.setContent('<div class="alert-danger">Access denied. Insufficient permissions for this action.</div>');
  assert.equal((await profile.detectState(page))?.code,'PERMISSION_DENIED');assert.equal((await profile.detectState(page))?.kind,'business');
  await page.setContent('<mat-error>First name is required</mat-error>');
  assert.equal((await profile.detectState(page))?.code,'TARGET_VALIDATION');assert.equal((await profile.detectState(page))?.kind,'business');
  await page.setContent('<div>No client was found</div>');
  assert.equal((await profile.detectState(page))?.code,'NOT_FOUND');
  await page.setContent('<form id="login-form">Username and password</form>');
  assert.equal((await profile.detectState(page))?.code,'SESSION_EXPIRED');assert.equal((await profile.detectState(page))?.kind,'intervention');
 }finally{await browser.close();}
});
