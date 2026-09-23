import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authoredCapabilities, digest, makeRecord } from '../src/server/capabilities.js';
import { qualifyCapability } from '../src/server/qualification.js';
import { Store } from '../src/server/store.js';
import { startWorkbench } from '../src/server/index.js';
import { capabilitySchema, createRunSchema, type CapabilityRecord, type Run, type TaskKind } from '../src/shared/contracts.js';

// Synthetic history fixtures exercise qualification policy, not live model accuracy.
function fixture(task: TaskKind = 'balance') {
  const base = authoredCapabilities().find(capability => capability.task === (task==='member'?'submit':task))!;
  const capability = makeRecord(capabilitySchema.parse({ ...base, task,...(task==='member'?{target:'mifos-x',output:'member-v1'}:{}),id: `qualification-${task}`,
    provenance: { kind: 'discovered', runId: 'source', provider: 'openai', model: 'test-model' } }));
  const at = '2026-09-23T00:00:00.000Z';
  const source: Run = { id: 'source', mode: 'discovery', task, goal: 'Synthetic qualification source',
    ...(task==='member'?{targetId:'mifos-x' as const}:{}),status: 'completed', result: 'succeeded', effect: ['submit','member'].includes(task) ? 'verified' : 'none', outcomeCode: 'DISCOVERED',
    inputs: createRunSchema.parse({ idempotencyKey: 'qualification-source', inputs: { clientReference: '10001', accountReference: '', externalReference: 'SOURCE-001' } }).inputs,
    resolvedInputs: { accountReference: 'SAV-1001' }, scenario: 'normal', createdAt: at, updatedAt: at, finishedAt: at,
    sessionId: 'source-session', owner: 'none', epoch: 2, stepIndex: 4, steps: [], events: [], frameRevision: 1,
    viewport: { width: 1120, height: 760 }, provider: 'openai', model: 'test-model', modelCalls: 4, discoveredCapabilityId: capability.id };
  const replay: Run = { ...structuredClone(source), id: 'replay', mode: 'replay', outcomeCode: 'VERIFIED',
    inputs: { ...source.inputs, clientReference: '10002', product: 'Growth Savings', externalReference: 'REPLAY-002' },
    resolvedInputs: { accountReference: 'SAV-1002' }, modelCalls: 0, discoveredCapabilityId: undefined,
    capabilityId: capability.id, capabilityDigest: capability.digest, provider: undefined, model: undefined };
  if(task==='member'){source.inputs.firstName='Jordan';source.inputs.lastName='Ellis';replay.inputs.firstName='Casey';replay.inputs.lastName='Morgan';}
  return { capability, source, replay };
}

test('qualification uses unassisted different-input evidence bound to the exact digest', () => {
  const { capability, source, replay } = fixture();
  const result = qualifyCapability(capability, source, [replay]);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.replayRunIds, ['replay']);
  assert.equal(result.distinctMemberCount, 2);
  assert.equal(result.successfulReplays, 1);
  assert.equal(result.digestVerified, true);
  assert.equal(capability.successCount, 0, 'The policy must not depend on counters');
});

test('evidence from another banking target cannot qualify a capability', () => {
  const { capability, source, replay } = fixture();
  assert.equal(qualifyCapability(capability, { ...source, targetId: 'mifos-x' }, [replay]).eligible, false);
  assert.equal(qualifyCapability(capability, source, [{ ...replay, targetId: 'mifos-x' }]).eligible, false);
});

test('success counters, same inputs, another digest, model calls, manual repair and reconciliation cannot qualify', () => {
  const { capability, source, replay } = fixture();
  const sameInputs = { ...replay, inputs: source.inputs, resolvedInputs: source.resolvedInputs };
  const sameAccount = { ...replay, resolvedInputs: source.resolvedInputs };
  const event = { id: 1, timestamp: source.createdAt, message: 'Synthetic event', actor: 'human' as const };
  const ineligible = [sameInputs, sameAccount,
    { ...replay, capabilityDigest: 'different-digest' }, { ...replay, modelCalls: 1 },
    { ...replay, outcomeCode: 'RECONCILED' },
    ...['manual', 'recovery', 'reconcile'].map(kind => ({ ...replay, events: [{ ...event, kind }] })),
    { ...replay, result: 'business_outcome' as const }, { ...replay, status: 'running' as const },
  ];
  for (const run of ineligible) {
    assert.equal(qualifyCapability({ ...capability, successCount: 999 }, source, [run]).eligible, false, JSON.stringify(run));
  }
});

test('source provenance, content integrity and quarantine are required independently of replay evidence', () => {
  const { capability, source, replay } = fixture();
  for (const invalidSource of [undefined, { ...source, modelCalls: 0 }, { ...source, model: 'wrong-model' },
    { ...source, outcomeCode: 'VERIFIED_ASSISTED' }, { ...source, discoveredCapabilityId: 'wrong-artifact' }]) {
    assert.equal(qualifyCapability(capability, invalidSource, [replay]).eligible, false);
  }
  assert.equal(qualifyCapability({ ...capability, status: 'quarantined' }, source, [replay]).eligible, false);
  assert.equal(qualifyCapability({ ...capability, steps: capability.steps.slice(1) }, source, [replay]).digestVerified, false);
  assert.equal(qualifyCapability({ ...capability, qualification: { ...qualifyCapability(capability, source, [replay]), eligible: true } }, undefined, []).eligible, false);
});

test('application qualification requires a different member and reference, while legitimate approval remains allowed', () => {
  for (const task of ['prepare', 'submit'] as const) {
    const { capability, source, replay } = fixture(task);
    replay.events = [{ id: 1, timestamp: source.createdAt, kind: 'approved', message: 'Exact preview approved', actor: 'human' }];
    const valid = qualifyCapability(capability, source, [replay]);
    assert.equal(valid.eligible, true);
    assert.deepEqual(valid.testedProducts, ['Everyday Savings', 'Growth Savings']);
    assert.equal(qualifyCapability(capability, source, [{ ...replay, inputs: { ...replay.inputs, externalReference: source.inputs.externalReference } }]).eligible, false);
    assert.equal(qualifyCapability(capability, source, [{ ...replay, inputs: { ...replay.inputs, clientReference: source.inputs.clientReference } }]).eligible, false);
    if (task === 'submit') assert.equal(qualifyCapability(capability, source, [{ ...replay, effect: 'unknown' }]).eligible, false);
  }
});

test('member qualification requires different identity data and verified creation on both source and replay',()=>{
  const {capability,source,replay}=fixture('member');
  const result=qualifyCapability(capability,source,[replay]);
  assert.equal(result.eligible,true);assert.deepEqual(result.testedProducts,[]);
  assert.equal(qualifyCapability(capability,{...source,effect:'none'},[replay]).eligible,false);
  assert.equal(qualifyCapability(capability,source,[{...replay,effect:'unknown'}]).eligible,false);
  for(const inputs of [{...replay.inputs,clientReference:source.inputs.clientReference},{...replay.inputs,firstName:source.inputs.firstName,lastName:source.inputs.lastName}])assert.equal(qualifyCapability(capability,source,[{...replay,inputs}]).eligible,false);
});

test('qualification evidence survives more than 100 later runs and worker restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'interface-qualification-'));
  let store: Store | undefined;
  try {
    const { capability, source, replay } = fixture();
    store = new Store(path);
    store.saveCapability(capability); store.saveRun(source); store.saveRun(replay);
    for (let index = 0; index < 105; index++) store.saveRun({ ...replay, id: `later-${index}`, capabilityId: 'other-capability' });
    assert.equal(store.runs().some(run => run.id === source.id), false);
    store.close(); store = new Store(path);
    const result = qualifyCapability(store.capability(capability.id)!, store.run(source.id), store.capabilityRuns(capability.id));
    assert.equal(result.eligible, true);
    assert.deepEqual(result.replayRunIds, [replay.id]);
  } finally { store?.close(); await rm(path, { recursive: true, force: true }); }
});

test('approval API checks reviewed digest and fresh evidence, then records the exact reviewed run IDs', async () => {
  const path = await mkdtemp(join(tmpdir(), 'interface-qualification-api-'));
  const server = await startWorkbench({ port: 16617, targetPort: 16618, dataPath: path });
  try {
    const { capability, source, replay } = fixture();
    server.store.saveCapability(capability); server.store.saveRun(source);
    const approve = (body: unknown) => server.app.inject({ method: 'POST', url: `/api/capabilities/${capability.id}/approve`,
      headers: { host: '127.0.0.1:16617', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    assert.equal((await approve({})).statusCode, 400);
    assert.equal((await approve({ expectedDigest: 'stale-digest' })).statusCode, 409);
    assert.equal((await approve({ expectedDigest: capability.digest })).statusCode, 409);
    server.store.saveRun(replay);
    const response = await approve({ expectedDigest: capability.digest });
    assert.equal(response.statusCode, 200, response.body);
    const reviewed = response.json() as CapabilityRecord;
    assert.equal(reviewed.status, 'approved');
    assert.deepEqual(reviewed.approvalReview?.replayRunIds, [replay.id]);
    assert.equal(reviewed.approvalReview?.discoveryRunId, source.id);
    assert.equal(reviewed.approvalReview?.digest, capability.digest);
    assert.equal(digest(capabilitySchema.parse(reviewed)), capability.digest, 'Review metadata must not mutate content identity');
    assert.equal(server.store.capability(capability.id)?.qualification, undefined, 'Qualification is recomputed, not persisted');
    const before = reviewed.approvalReview;
    assert.deepEqual((await approve({ expectedDigest: capability.digest })).json().approvalReview, before, 'Repeated approval is idempotent');
    const archived = await server.app.inject({ method: 'GET', url: `/api/runs/${source.id}`, headers: { host: '127.0.0.1:16617' } });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().id, source.id);
  } finally { await server.close(); await rm(path, { recursive: true, force: true }); }
});
