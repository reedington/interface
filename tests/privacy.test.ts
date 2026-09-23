import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { createRunSchema, type Run } from '../src/shared/contracts.js';
import { ensureStateKey, openPrivate, sealPrivate, redactRun, evidenceScreenshot } from '../src/server/privacy.js';
import { launchBrowser } from '../src/server/surface.js';

function privateRun():Run{return {id:'privacy-canary',mode:'replay',task:'member',goal:'Create Canarysecret Personsecret using sk-test-secret-canary',status:'completed',result:'succeeded',outcomeCode:'VERIFIED',effect:'verified',inputs:{...createRunSchema.parse({idempotencyKey:'privacy-test'}).inputs,firstName:'Canarysecret',lastName:'Personsecret'},scenario:'normal',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sessionId:'test-session',owner:'none',epoch:4,stepIndex:1,steps:[{id:'check',label:'Canarysecret private label',state:'verified'}],events:[{id:1,timestamp:new Date().toISOString(),kind:'step',message:'Canarysecret sk-test-secret-canary',actor:'automation'}],frameRevision:0,viewport:{width:1120,height:760},modelCalls:0,output:{firstName:'Canarysecret',memberName:'Canarysecret Personsecret',balance:'91234.56'},error:'Canarysecret error'};}

test('audit allowlist removes free text, identifiers, balances and secrets while encrypted state retains recovery data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'interface-privacy-'));
 try{
  const run=privateRun();const projected=JSON.stringify(redactRun(run));
  for(const secret of ['Canarysecret','Personsecret','sk-test-secret-canary','91234.56','10001'])assert.ok(!projected.includes(secret));
  let store=new Store(dir);store.saveRun(run);assert.deepEqual(store.run(run.id),run);store.close();
  for(const name of readdirSync(dir).filter(name=>name.startsWith('workbench.sqlite')))assert.ok(!readFileSync(join(dir,name)).includes(Buffer.from('Canarysecret')),'SQLite/WAL must not contain private text');
  store=new Store(dir);assert.deepEqual(store.run(run.id),run);store.close();
  const key=ensureStateKey(dir),sealed=sealPrivate('Canarysecret',key,'run:a');
  assert.equal(openPrivate(sealed,key,'run:a'),'Canarysecret');
  assert.throws(()=>openPrivate(sealed,key,'run:b'),/authenticated/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('legacy plaintext rows migrate without changing history and checkpoint away plaintext database pages',()=>{
 const dir=mkdtempSync(join(tmpdir(),'interface-private-migration-'));
 try{
  const db=new DatabaseSync(join(dir,'workbench.sqlite'));db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  mkdirSync(join(dir,'evidence'));writeFileSync(join(dir,'evidence','orphan.json'),JSON.stringify({text:'Canarysecret private observation'}));
  writeFileSync(join(dir,'evidence','old.jpg'),Buffer.from('Canarysecret legacy frame'));
  const run=privateRun();db.prepare('INSERT INTO runs VALUES (?,?)').run(run.id,JSON.stringify(run));db.close();
  const store=new Store(dir);assert.deepEqual(store.run(run.id),run);store.close();
  assert.ok(!readFileSync(join(dir,'workbench.sqlite')).includes(Buffer.from('Canarysecret')));
  assert.equal(existsSync(join(dir,'evidence','orphan.json')),false);assert.equal(existsSync(join(dir,'evidence','old.jpg')),false);
  for(const file of readdirSync(join(dir,'evidence')))assert.ok(!readFileSync(join(dir,'evidence',file)).includes(Buffer.from('Canarysecret')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('persistent screenshots hide text and form canaries while retaining layout',async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:600,height:400}});
  const markup=(secret:string)=>`<body style="font-family:monospace"><h1 style="width:500px;height:50px">${secret}</h1><input value="${secret}"><textarea>${secret}</textarea><div style="width:200px;height:50px;background:#aabbcc">${secret}</div></body>`;
  await page.setContent(markup('Canarysecret'));const first=await evidenceScreenshot(page);
  await page.setContent(markup('Otherprivate'));const second=await evidenceScreenshot(page);
  assert.deepEqual(first,second,'Equal geometry with different private text must produce identical saved pixels');
  assert.ok(first.length>1000);
 }finally{await browser.close();}
});


test('interrupted migration resumes plaintext free-page cleanup even after every row is encrypted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'interface-private-interruption-'));
 try{
  let store=new Store(dir);store.saveRun(privateRun());store.close();
  const db=new DatabaseSync(join(dir,'workbench.sqlite'));
  db.exec("PRAGMA secure_delete=OFF; CREATE TABLE discarded (body TEXT); UPDATE privacy_meta SET state='pending' WHERE id='encrypted-state-v1'");
  db.prepare('INSERT INTO discarded VALUES (?)').run('Interruptedprivatecanary'.repeat(500));db.exec('DELETE FROM discarded');db.close();
  assert.ok(readFileSync(join(dir,'workbench.sqlite')).includes(Buffer.from('Interruptedprivatecanary')));
  store=new Store(dir);assert.equal(store.run('privacy-canary')?.inputs.firstName,'Canarysecret');store.close();
  assert.ok(!readFileSync(join(dir,'workbench.sqlite')).includes(Buffer.from('Interruptedprivatecanary')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
