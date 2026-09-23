import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Locator } from 'playwright-core';
import { startWorkbench } from '../src/server/index.js';
import type { AppState, CapabilityRecord, HumanInput, Run } from '../src/shared/contracts.js';

interface StubObservation {
  inputs: { clientReference: string; accountReference: string };
  observation: { controls: Array<{ id: string; name: string; value?: string }> };
}

// This is a deterministic test double for model transport, never a production
// discovery fallback or evidence of live model quality. The real browser,
// observations, policy checks, recording, replay and input gateway are exercised.
test('mocked model orchestration discovers a parameterized artifact and enforces discovery bounds', { timeout: 120_000 }, async t => {
  const dataPath = await mkdtemp(join(tmpdir(), 'interface-discovery-test-'));
  let providerCalls = 0;
  let behavior: 'propose' | 'unauthorized' | 'delayed' | 'wait' | 'no_progress' = 'propose';
  const pendingResponses: Array<{ response:ServerResponse; proposal:unknown }> = [];
  let abortedResponses = 0;
  const provider = createServer(async (req, res) => {
    providerCalls++;
    try {
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer synthetic-integration-key');
      if (behavior === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Raw sensitive upstream message: synthetic-integration-key' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.input[0].content[1].type, 'input_image');
      const observed: StubObservation = JSON.parse(body.input[0].content[0].text);
      const controls = observed.observation.controls;
      const account = controls.find(control => control.name === `View account ${observed.inputs.accountReference}`);
      const client = controls.find(control => control.name === `Open member ${observed.inputs.clientReference}`);
      const search = controls.find(control => control.name === 'Search members');
      const reference = controls.find(control => control.name === 'Member reference');
      let proposal: { action: string; targetId: string | null; inputKey: string | null; value: null; reason: string };
      if (account || client) {
        proposal = { action: 'click', targetId: (account || client)!.id, inputKey: null, value: null, reason: account ? 'Open the requested account' : 'Open the requested client' };
      } else if (reference && reference.value !== observed.inputs.clientReference) {
        proposal = { action: 'fill', targetId: reference.id, inputKey: 'clientReference', value: null, reason: 'Enter the requested client reference' };
      } else if (search) {
        proposal = { action: 'click', targetId: search.id, inputKey: null, value: null, reason: 'Search for the requested client' };
      } else {
        throw new Error('The test provider received an unexpected observation');
      }
      if (behavior === 'delayed') {
        pendingResponses.push({response:res,proposal});
        res.once('close',()=>{if(!res.writableEnded)abortedResponses++;});
        return;
      }
      if (behavior === 'wait') proposal = {action:'wait',targetId:null,inputKey:null,value:null,reason:'Wait for the application'};
      if (behavior === 'no_progress') proposal = {action:'fill',targetId:reference!.id,inputKey:'clientReference',value:null,reason:'Enter the same member again'};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(proposal) },
      ] }] }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Test provider failed' }));
    }
  });
  let server: Awaited<ReturnType<typeof startWorkbench>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(16319, '127.0.0.1', () => { provider.off('error', reject); resolve(); });
    });
    server = await startWorkbench({ port: 16317, targetPort: 16318, dataPath });
    const workbench = server;

    async function request<T>(path: string, body?: unknown, expected = 200): Promise<T> {
      const response = await fetch(workbench.url + path, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result as T;
    }
    async function settle(id: string): Promise<Run> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const run = await request<Run>(`/api/runs/${id}`);
        if (run.status === 'completed' || run.status === 'awaiting_human') return run;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Run did not settle: ${JSON.stringify(await request<Run>(`/api/runs/${id}`))}`);
    }
    async function createDiscovery(): Promise<Run> {
      return request('/api/runs', { mode: 'discovery', task: 'balance', scenario: 'normal',
        provider: 'openai', model: 'test-observation-model', idempotencyKey: randomUUID(),
        inputs: { clientReference: '10001', accountReference: 'SAV-1001' } });
    }
    async function waitForPending(): Promise<{ response:ServerResponse; proposal:unknown }> {
      const deadline=Date.now()+10_000;
      while(Date.now()<deadline){const next=pendingResponses.shift();if(next)return next;await new Promise(resolve=>setTimeout(resolve,20));}
      throw new Error('No provider request reached the test server.');
    }
    function release(pending:{response:ServerResponse;proposal:unknown}) {
      pending.response.writeHead(200,{'content-type':'application/json'});
      pending.response.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(pending.proposal)}]}]}));
    }
    async function stop(run:Run) {return request<Run>(`/api/runs/${run.id}/stop`,{epoch:run.epoch});}

    await request('/api/providers', { provider: 'openai', model: 'test-observation-model',
      apiKey: 'synthetic-integration-key', baseUrl: 'http://127.0.0.1:16319/v1' });

    await t.test('observed actions become a draft that replays different inputs without model calls', async () => {
      const discovered = await settle((await createDiscovery()).id);
      assert.equal(discovered.result, 'succeeded', JSON.stringify(discovered));
      assert.equal(discovered.outcomeCode, 'DISCOVERED');
      assert.equal(discovered.output?.clientReference, '10001');
      assert.equal(discovered.output?.accountReference, 'SAV-1001');
      assert.equal(discovered.modelCalls, 4);
      assert.equal(providerCalls, 4);
      assert.ok(discovered.discoveredCapabilityId);
      const artifact = await request<CapabilityRecord>(`/api/capabilities/${discovered.discoveredCapabilityId}`);
      assert.equal(artifact.status, 'draft');
      assert.equal(artifact.provenance.kind, 'discovered');
      assert.equal(artifact.provenance.runId, discovered.id);
      assert.deepEqual(artifact.steps.find(step => step.action === 'fill')?.value, { source: 'input', key: 'clientReference' });
      assert.ok(artifact.steps.some(step => step.target?.value === 'Open member {{clientReference}}'));
      assert.ok(artifact.steps.some(step => step.target?.value === 'View account {{accountReference}}'));
      assert.equal(artifact.steps.at(-1)?.checkpoint, 'account');
      assert.equal(JSON.stringify(artifact.steps).includes('10001'), false);
      assert.equal(JSON.stringify(artifact.steps).includes('SAV-1001'), false);
      await request(`/api/capabilities/${artifact.id}/approve`, {expectedDigest:artifact.digest}, 409);

      const replay = await request<Run>('/api/runs', { mode: 'replay', replayPurpose: 'validation', task: 'balance', capabilityId: artifact.id,
        idempotencyKey: randomUUID(), inputs: { clientReference: '10002', accountReference: 'SAV-1002' } });
      const verified = await settle(replay.id);
      assert.equal(verified.result, 'succeeded', JSON.stringify(verified));
      assert.equal(verified.output?.clientReference, '10002');
      assert.equal(verified.output?.accountReference, 'SAV-1002');
      assert.equal(verified.output?.balance, '840.00');
      assert.equal(verified.modelCalls, 0);
      assert.equal(providerCalls, 4, 'Replay must never request the provider');
      const approved = await request<CapabilityRecord>(`/api/capabilities/${artifact.id}/approve`, {expectedDigest:artifact.digest});
      assert.equal(approved.status, 'approved');
      assert.equal(approved.successCount, 1);
    });

    await t.test('401 enters intervention and manual completion cannot masquerade as a discovered artifact', async () => {
      behavior = 'unauthorized';
      const before = await request<AppState>('/api/state');
      const interrupted = await settle((await createDiscovery()).id);
      assert.equal(interrupted.status, 'awaiting_human');
      assert.match(interrupted.intervention?.reason || '', /Authentication failed/);
      assert.equal(interrupted.modelCalls, 1);
      assert.equal(interrupted.stepIndex, 0);
      assert.equal(interrupted.discoveredCapabilityId, undefined);
      assert.equal(JSON.stringify(interrupted).includes('synthetic-integration-key'), false);
      assert.equal(JSON.stringify(interrupted).includes('Raw sensitive upstream message'), false);
      const callsAtIntervention = providerCalls;
      const human = await request<Run>(`/api/runs/${interrupted.id}/takeover`, { epoch: interrupted.epoch });
      const session = workbench.engine.sessions.get(interrupted.id)!;
      assert.equal(human.owner, 'human');
      assert.equal(human.sessionId, interrupted.sessionId);

      async function input(action: Partial<HumanInput>) {
        const frame = await request<{ revision: number }>(`/api/runs/${human.id}/frame`);
        await request(`/api/runs/${human.id}/input`, { epoch: human.epoch, frameRevision: frame.revision,
          commandId: randomUUID(), ...action });
      }
      async function click(locator: Locator) {
        await locator.waitFor({ state: 'visible' });
        const box = await locator.boundingBox();
        assert.ok(box);
        await input({ action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      await click(session.page.getByLabel('Member reference', { exact: true }));
      await input({ action: 'type', text: '10001' });
      await click(session.page.getByRole('button', { name: 'Search members', exact: true }));
      await click(session.page.getByRole('link', { name: 'Open member 10001', exact: true }));
      await click(session.page.getByRole('link', { name: 'View account SAV-1001', exact: true }));
      await request(`/api/runs/${human.id}/resume`, { epoch: human.epoch });
      const completed = await settle(human.id);
      assert.equal(completed.result, 'succeeded', JSON.stringify(completed));
      assert.equal(completed.outcomeCode, 'VERIFIED_ASSISTED');
      assert.equal(completed.output?.accountReference, 'SAV-1001');
      assert.equal(completed.discoveredCapabilityId, undefined);
      assert.ok(completed.events.some(event => event.kind === 'artifact_withheld'));
      assert.equal(providerCalls, callsAtIntervention, 'An already verified manual outcome must not require another model call');
      const after = await request<AppState>('/api/state');
      assert.equal(after.capabilities.length, before.capabilities.length);
    });

    await t.test('pause, takeover and stop abort a slow provider and reject its late action', async () => {
      behavior='delayed';
      for(const action of ['pause','takeover','stop']) {
        const run=await createDiscovery();
        const pending=await waitForPending();
        const started=Date.now(),calls=providerCalls,abortedBefore=abortedResponses;
        const controlled=await request<Run>(`/api/runs/${run.id}/${action}`,{epoch:run.epoch});
        assert.ok(Date.now()-started<2_000,`${action} waited for the provider instead of cancelling it`);
        assert.equal(controlled.status,action==='stop'?'completed':action==='takeover'?'human_control':'awaiting_human');
        assert.equal(controlled.owner,action==='takeover'?'human':'none');
        const epoch=controlled.epoch;
        release(pending);
        await new Promise(resolve=>setTimeout(resolve,100));
        const after=await request<Run>(`/api/runs/${run.id}`);
        assert.equal(after.status,controlled.status);
        assert.equal(after.epoch,epoch,'A cancelled proposal cannot replace the new ownership state');
        assert.equal(after.stepIndex,0);
        assert.equal(after.discoveredCapabilityId,undefined);
        assert.equal(providerCalls,calls);
        assert.ok(abortedResponses>abortedBefore,'The HTTP request should actually abort');
        assert.equal(await workbench.engine.sessions.get(run.id)!.page.getByLabel('Member reference',{exact:true}).inputValue(),'');
        if(action!=='stop')await stop(after);
      }
    });

    await t.test('stop during a pending UI transition prevents another model call or recorded action', async () => {
      behavior='propose';
      const original=workbench.engine.profile.awaitObservationReady;
      let releaseReady!:()=>void,entered!:()=>void;
      const ready=new Promise<void>(resolve=>{releaseReady=resolve;});
      const waiting=new Promise<void>(resolve=>{entered=resolve;});
      workbench.engine.profile.awaitObservationReady=async()=>{entered();await ready;};
      try {
        const run=await createDiscovery();
        await waiting;
        const calls=providerCalls;
        const stopping=stop(run);
        const deadline=Date.now()+2_000;
        while(workbench.engine.get(run.id).owner==='automation'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(workbench.engine.get(run.id).owner,'none');
        releaseReady();
        await stopping;
        const stopped=await request<Run>(`/api/runs/${run.id}`);
        assert.equal(stopped.result,'cancelled');
        assert.equal(stopped.stepIndex,0,'A transition interrupted before observation must not be recorded as verified');
        assert.equal(stopped.discoveredCapabilityId,undefined);
        assert.equal(providerCalls,calls);
      } finally {releaseReady();workbench.engine.profile.awaitObservationReady=original;}
    });

    await t.test('repeated waits enter a bounded intervention and resume does not spend another call without progress', async () => {
      behavior='wait';
      const interrupted=await settle((await createDiscovery()).id);
      assert.equal(interrupted.intervention?.code,'DISCOVERY_WAIT_LIMIT');
      assert.equal(interrupted.modelCalls,3);
      assert.equal(interrupted.discoveryBudget?.actions,0);
      assert.equal(interrupted.discoveryBudget?.consecutiveWaits,3);
      await request(`/api/runs/${interrupted.id}/resume`,{epoch:interrupted.epoch});
      const resumed=await settle(interrupted.id);
      assert.equal(resumed.intervention?.code,'DISCOVERY_WAIT_LIMIT');
      assert.equal(resumed.modelCalls,3);
      await stop(resumed);
    });

    await t.test('repeating a successful UI command without changing the page stops as stalled', async () => {
      behavior='no_progress';
      const interrupted=await settle((await createDiscovery()).id);
      assert.equal(interrupted.intervention?.code,'DISCOVERY_STALLED');
      assert.equal(interrupted.modelCalls,5);
      assert.equal(interrupted.discoveryBudget?.actions,5);
      assert.equal(interrupted.discoveryBudget?.unchangedObservations,4);
      assert.equal(interrupted.discoveredCapabilityId,undefined);
      await stop(interrupted);
    });

    await t.test('model and action budgets persist across resume and remain independent', async () => {
      for(const kind of ['model','action'] as const){
        behavior='delayed';
        const run=await createDiscovery(),pending=await waitForPending();
        const internal=workbench.engine.get(run.id);
        // These are worker-owned settings; the public create API cannot alter them.
        if(kind==='model')internal.discoveryBudget!.maxModelCalls=1;
        else internal.discoveryBudget!.maxActions=1;
        behavior='propose';release(pending);
        const interrupted=await settle(run.id);
        assert.equal(interrupted.intervention?.code,kind==='model'?'DISCOVERY_MODEL_LIMIT':'DISCOVERY_ACTION_LIMIT');
        assert.equal(interrupted.modelCalls,1);
        assert.equal(interrupted.discoveryBudget?.actions,1);
        await request(`/api/runs/${run.id}/resume`,{epoch:interrupted.epoch});
        const resumed=await settle(run.id);
        assert.equal(resumed.modelCalls,1);
        assert.equal(resumed.discoveryBudget?.actions,1);
        await stop(resumed);
      }
    });

    await t.test('the remaining active-time budget cancels a slow model request', async () => {
      behavior='delayed';
      const run=await createDiscovery(),first=await waitForPending();
      // Allow the first action, then leave only a short decision budget. Time
      // sleeping at an intervention is not charged and cannot replenish it.
      const budget=workbench.engine.get(run.id).discoveryBudget!;
      budget.maxActiveMs=700;
      release(first);
      const second=await waitForPending();
      const interrupted=await settle(run.id);
      assert.equal(interrupted.intervention?.code,'DISCOVERY_TIME_LIMIT');
      assert.equal(interrupted.modelCalls,2);
      assert.equal(interrupted.discoveryBudget?.actions,1);
      assert.ok(interrupted.discoveryBudget!.activeMs>=budget.maxActiveMs);
      release(second);
      await request(`/api/runs/${run.id}/resume`,{epoch:interrupted.epoch});
      const resumed=await settle(run.id);
      assert.equal(resumed.modelCalls,2);
      await stop(resumed);
    });

    await t.test('closing the worker aborts an in-flight model request promptly', async () => {
      behavior='delayed';
      await createDiscovery();
      const pending=await waitForPending(),started=Date.now();
      await server!.close();server=undefined;
      assert.ok(Date.now()-started<2_000,'Shutdown waited for the provider timeout');
      release(pending);
    });
  } finally {
    await server?.close();
    if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(dataPath, { recursive: true, force: true });
  }
});
