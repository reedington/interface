import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildEvidenceBundle, exportEvidence, parseExportArgs, readEvidenceSelection, type ExportOptions } from '../scripts/export-evidence.js';
import { authoredCapabilities, digest, makeRecord } from '../src/server/capabilities.js';
import { capabilitySchema, inputSchema, type Run } from '../src/shared/contracts.js';
import { Store } from '../src/server/store.js';

// Fabricated history tests the exporter. These records are never published as
// live-model evidence; real assessment evidence must come from selected runs.
function fixture(){
  const capability=makeRecord(capabilitySchema.parse({...authoredCapabilities()[0],id:'export-fixture',provenance:{kind:'discovered',runId:'source',provider:'openai',model:'test-model'}}));
  const time='2026-09-23T00:00:00.000Z';
  const discovery:Run={id:'source',targetId:'local-banking-lab',mode:'discovery',task:'balance',goal:'PRIVATE-GOAL-CANARY',status:'completed',result:'succeeded',effect:'none',outcomeCode:'DISCOVERED',
    inputs:inputSchema.parse({clientReference:'10001',accountReference:'SAV-1001'}),output:{clientReference:'10001',accountReference:'SAV-1001',balance:'12540.75',currency:'USD',status:'Active'},scenario:'normal',
    createdAt:time,updatedAt:time,finishedAt:time,sessionId:'source-session',owner:'none',epoch:2,stepIndex:7,steps:capability.steps.map(step=>({id:step.id,label:step.label,state:'verified'})),
    events:[{id:1,timestamp:time,kind:'model',actor:'automation',message:'Bearer sk-PRIVATE-PROVIDER-CANARY'}],frameRevision:1,viewport:{width:1120,height:760},provider:'openai',model:'test-model',modelCalls:4,discoveredCapabilityId:capability.id};
  const replay:Run={...structuredClone(discovery),id:'replay',mode:'replay',outcomeCode:'VERIFIED',capabilityId:capability.id,capabilityDigest:capability.digest,discoveredCapabilityId:undefined,modelCalls:0,provider:undefined,model:undefined,
    inputs:{...discovery.inputs,clientReference:'10002',accountReference:'SAV-1002'},output:{...discovery.output,clientReference:'10002',accountReference:'SAV-1002',balance:'840.00'},events:[]};
  return {capability,discovery,replay};
}

test('export preserves the exact artifact while projecting logs and publishing only explicit fictional fixtures',()=>{
  const selected=fixture(),original=JSON.stringify(selected);
  const files=buildEvidenceBundle(selected);
  assert.equal(JSON.stringify(selected),original);
  const artifact=files['artifact.json'] as Record<string,unknown>;
  assert.equal(digest(capabilitySchema.parse(artifact)),selected.capability.digest);
  const serialized=JSON.stringify(files);
  assert.equal(serialized.includes('PRIVATE-GOAL-CANARY'),false);assert.equal(serialized.includes('sk-PRIVATE-PROVIDER-CANARY'),false);
  assert.equal((files['discovery.json'] as Record<string,unknown>).goal,'[redacted]');
  assert.equal((files['manifest.json'] as Record<string,unknown>).replayModelCalls,0);
  const fake=files['fictional-fixtures.json'] as {dataClassification:string;replay:{inputs:{clientReference:string};output:{balance:string}}};
  assert.equal(fake.dataClassification,'fictional-test-data-only');assert.equal(fake.replay.inputs.clientReference,'10002');assert.equal(fake.replay.output.balance,'840.00');
});

test('export rejects forged qualification, incorrect output binding and private literals without rewriting history',()=>{
  const original=fixture();
  for(const change of [
    {replay:{...original.replay,modelCalls:1}},
    {replay:{...original.replay,inputs:original.discovery.inputs,output:original.discovery.output}},
    {capability:{...original.capability,digest:'wrong'}},
    {replay:{...original.replay,output:{...original.replay.output,clientReference:'99999'}}},
  ])assert.throws(()=>buildEvidenceBundle({...original,...change}));
  for(const label of ['Enter member 10001','Authorization Bearer sk-PRIVATE-ARTIFACT-CANARY']){
    const changed=fixture();changed.capability.steps[0].label=label;
    changed.capability.digest=digest(capabilitySchema.parse(changed.capability));changed.replay.capabilityDigest=changed.capability.digest;
    assert.throws(()=>buildEvidenceBundle(changed),/literal|credential-like/);
    assert.equal(changed.capability.steps[0].label,label);
  }
});

test('export CLI requires explicit selected runs, fresh output and synthetic-data acknowledgement',()=>{
  const args=['--data','/tmp/history','--discovery','source','--replay','replay','--out','/tmp/export'];
  assert.throws(()=>parseExportArgs(args),/synthetic/);
  assert.deepEqual(parseExportArgs([...args,'--synthetic']),{dataPath:'/tmp/history',discoveryId:'source',replayId:'replay',outPath:'/tmp/export',failureId:undefined,synthetic:true});
  assert.deepEqual(parseExportArgs(['--help']),{help:true});
  for(const bad of [['--synthetic'],[...args,'--synthetic','--synthetic'],[...args,'--synthetic','--out','again'],[...args,'--synthetic','--failure','../private']])assert.throws(()=>parseExportArgs(bad));
});

test('encrypted evidence is read without invoking worker recovery or modifying active history; output is never overwritten',async t=>{
  const root=await mkdtemp(join(tmpdir(),'interface-evidence-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataPath=join(root,'data'),store=new Store(dataPath);t.after(()=>store.close());
  const selected=fixture();store.saveCapability(selected.capability);store.saveRun(selected.discovery);store.saveRun(selected.replay);
  store.saveRun({...selected.replay,id:'active',status:'running',result:undefined,outcomeCode:undefined});
  const activeBefore=JSON.stringify(store.run('active'));
  const options:ExportOptions={dataPath,discoveryId:'source',replayId:'replay',outPath:join(root,'export'),synthetic:true};
  const read=await readEvidenceSelection(options);assert.deepEqual(read,JSON.parse(JSON.stringify(selected)));
  await exportEvidence(options);
  assert.equal(JSON.stringify(store.run('active')),activeBefore,'Export must not mark the live owner’s run SESSION_LOST');
  assert.equal((await readdir(options.outPath)).length,6);
  const before=await readFile(join(options.outPath,'artifact.json'),'utf8');
  await assert.rejects(exportEvidence(options),/EEXIST/);
  assert.equal(await readFile(join(options.outPath,'artifact.json'),'utf8'),before);
});

test('failure export requires same-artifact replay and a strictly redacted structural snapshot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'interface-evidence-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataPath=join(root,'data'),store=new Store(dataPath);t.after(()=>store.close());
  const selected=fixture();store.saveCapability(selected.capability);store.saveRun(selected.discovery);store.saveRun(selected.replay);
  const failure:Run={...selected.replay,id:'failure',result:'business_outcome',outcomeCode:'NOT_FOUND',output:{status:'not_found'}};store.saveRun(failure);
  assert.throws(()=>buildEvidenceBundle({...selected,failure:{...failure,capabilityDigest:'another'}}),/exact artifact/);
  const folder=join(dataPath,'evidence');await mkdir(folder);
  const snapshot={policy:'geometry-only-v1',stepIndex:3,outcomeCode:'NOT_FOUND',structure:{title:'[redacted]',controls:[{tag:'input',type:'text',disabled:false}]}};
  await writeFile(join(folder,'failure.json'),JSON.stringify({...snapshot,rawPageText:'SENSITIVE-CANARY'}));
  const options:ExportOptions={dataPath,discoveryId:'source',replayId:'replay',failureId:'failure',outPath:join(root,'export'),synthetic:true};
  await assert.rejects(exportEvidence(options));
  await writeFile(join(folder,'failure.json'),JSON.stringify(snapshot));
  await exportEvidence(options);
  assert.equal((await readdir(options.outPath)).length,8);
  assert.deepEqual(JSON.parse(await readFile(join(options.outPath,'failure-state.json'),'utf8')),{runId:'failure',...snapshot});
});

test('legacy history is readable without schema migration, key creation or touching other records',async t=>{
  const root=await mkdtemp(join(tmpdir(),'interface-evidence-legacy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const db=new DatabaseSync(join(root,'workbench.sqlite'));t.after(()=>db.close());
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE capabilities (id TEXT PRIMARY KEY, body TEXT NOT NULL);');
  const selected=fixture();
  db.prepare('INSERT INTO capabilities VALUES (?,?)').run(selected.capability.id,JSON.stringify(selected.capability));
  for(const run of [selected.discovery,selected.replay])db.prepare('INSERT INTO runs VALUES (?,?)').run(run.id,JSON.stringify(run));
  const options:ExportOptions={dataPath:root,discoveryId:'source',replayId:'replay',outPath:join(root,'export'),synthetic:true};
  assert.deepEqual(await readEvidenceSelection(options),JSON.parse(JSON.stringify(selected)));
  assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name='private_state'").get(),undefined);
  assert.equal((await readdir(root)).includes('state.key'),false);
});
