import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startWorkbench } from '../src/server/index.js';
import type { CapabilityRecord, Run, RunInputs, TaskKind } from '../src/shared/contracts.js';

interface MockObservation {
  task: TaskKind;
  inputs: RunInputs;
  observation: { controls: Array<{ id: string; name: string; value?: string }> };
  recentActions: Array<{ action: string; reason: string }>;
}
interface ApplicationRecord {
  clientReference: string;
  product: string;
  externalReference: string;
  applicationReference: string;
}

// Only model transport is mocked. This suite runs the actual Chromium browser,
// observed-control contract, worker approval gate, recorder, replay and local target.
// It deliberately does not load .env or call a remote model endpoint.
test('application discovery with mocked OpenAI transport preserves replay and submission boundaries', { timeout: 120_000 }, async t => {
  const dataPath = await mkdtemp(join(tmpdir(), 'interface-application-discovery-'));
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    providerCalls++;
    try {
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer synthetic-application-test-key');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.input[0].content[1].type, 'input_image');
      const observed: MockObservation = JSON.parse(body.input[0].content[0].text);
      const control = (name: string) => observed.observation.controls.find(item => item.name === name);
      const member = control(`Open member ${observed.inputs.clientReference}`);
      const search = control('Search members');
      const reference = control('Member reference');
      const application = control('New savings application');
      const product = control('Product');
      const externalReference = control('External reference');
      const review = control('Review application');
      const submit = control('Submit application');
      let proposal: { action: string; targetId: string; inputKey: keyof RunInputs | null; value: null; reason: string };
      if (submit) {
        assert.equal(observed.task, 'submit', 'Prepare must terminate at the worker-verified preview without another model call');
        proposal = { action: 'click', targetId: submit.id, inputKey: null, value: null, reason: 'Request the bound submission approval' };
      } else if (product && !observed.recentActions.some(item => item.reason === 'Select the requested product')) {
        // Record the input contract even when the first fixture matches the default.
        proposal = { action: 'select', targetId: product.id, inputKey: 'product', value: null, reason: 'Select the requested product' };
      } else if (externalReference && externalReference.value !== observed.inputs.externalReference) {
        proposal = { action: 'fill', targetId: externalReference.id, inputKey: 'externalReference', value: null, reason: 'Enter the requested external reference' };
      } else if (review) {
        proposal = { action: 'click', targetId: review.id, inputKey: null, value: null, reason: 'Review the application details' };
      } else if (application || member) {
        proposal = { action: 'click', targetId: (application || member)!.id, inputKey: null, value: null, reason: application ? 'Start a savings application' : 'Open the requested member' };
      } else if (reference && reference.value !== observed.inputs.clientReference) {
        proposal = { action: 'fill', targetId: reference.id, inputKey: 'clientReference', value: null, reason: 'Enter the requested member reference' };
      } else if (search) {
        proposal = { action: 'click', targetId: search.id, inputKey: null, value: null, reason: 'Search for the requested member' };
      } else {
        throw new Error('Mock transport received an unexpected application observation');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(proposal) },
      ] }] }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Mock provider failed' }));
    }
  });
  let server: Awaited<ReturnType<typeof startWorkbench>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(16519, '127.0.0.1', () => { provider.off('error', reject); resolve(); });
    });
    server = await startWorkbench({ port: 16517, targetPort: 16518, dataPath });
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
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const run = await request<Run>(`/api/runs/${id}`);
        if (['completed', 'awaiting_approval', 'awaiting_human'].includes(run.status)) return run;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Application run did not settle: ${JSON.stringify(await request<Run>(`/api/runs/${id}`))}`);
    }
    async function create(task: 'prepare' | 'submit', mode: 'discovery' | 'replay', inputs: Partial<RunInputs>, capabilityId?: string): Promise<Run> {
      return request('/api/runs', { task, mode, replayPurpose: 'validation', capabilityId, scenario: 'normal',
        provider: 'openai', model: 'mock-application-observer', idempotencyKey: randomUUID(),
        inputs: { clientReference: '10001', product: 'Everyday Savings', externalReference: `TEST-${randomUUID().slice(0, 8)}`, ...inputs } });
    }
    async function records(): Promise<ApplicationRecord[]> {
      try { return JSON.parse(await readFile(join(dataPath, 'banking-lab/applications.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }
    async function approve(run: Run): Promise<void> {
      assert.equal(run.status, 'awaiting_approval', JSON.stringify(run));
      assert.ok(run.approval);
      await request(`/api/runs/${run.id}/approve`, { epoch: run.epoch, approvalId: run.approval.id });
    }
    function assertInputsParameterized(artifact: CapabilityRecord): void {
      for (const key of ['clientReference', 'product', 'externalReference'] as const) {
        assert.ok(artifact.steps.some(step => step.value?.source === 'input' && step.value.key === key), `Missing declared ${key} input in recorded steps`);
      }
      assert.ok(artifact.steps.some(step => step.target?.value === 'Open member {{clientReference}}'));
    }
    await request('/api/providers', { provider: 'openai', model: 'mock-application-observer',
      apiKey: 'synthetic-application-test-key', baseUrl: 'http://127.0.0.1:16519/v1' });

    await t.test('prepare discovers a parameterized draft and replays changed member, product and reference without a write', async () => {
      const discovery = await settle((await create('prepare', 'discovery', { externalReference: 'PREPARE-DISCOVERY' })).id);
      assert.equal(discovery.outcomeCode, 'DISCOVERED', JSON.stringify(discovery));
      assert.equal(discovery.result, 'succeeded');
      assert.equal(discovery.effect, 'none');
      assert.ok(discovery.discoveredCapabilityId);
      const artifact = await request<CapabilityRecord>(`/api/capabilities/${discovery.discoveredCapabilityId}`);
      assert.equal(artifact.status, 'draft');
      assert.equal(artifact.provenance.runId, discovery.id);
      assertInputsParameterized(artifact);
      assert.equal(artifact.steps.at(-1)?.checkpoint, 'preview');
      assert.equal(artifact.steps.some(step => step.effect === 'commit'), false);
      assert.equal((await records()).length, 0);

      const callsBeforeReplay = providerCalls;
      const replay = await settle((await create('prepare', 'replay', {
        clientReference: '10002', product: 'Growth Savings', externalReference: 'PREPARE-REPLAY',
      }, artifact.id)).id);
      assert.equal(replay.result, 'succeeded', JSON.stringify(replay));
      assert.equal(replay.effect, 'none');
      assert.equal(replay.modelCalls, 0);
      assert.equal(providerCalls, callsBeforeReplay);
      assert.deepEqual(replay.output, { clientReference: '10002', product: 'Growth Savings', externalReference: 'PREPARE-REPLAY' });
      assert.equal(await workbench.engine.sessions.get(replay.id)!.page.locator('[data-page="preview"]').count(), 1);
      assert.equal((await records()).length, 0, 'Prepare must never create a persisted application');
    });

    let submitArtifact: CapabilityRecord;
    await t.test('submit discovery and changed-input replay each require their own exact, single-use approval', async () => {
      const pending = await settle((await create('submit', 'discovery', { externalReference: 'SUBMIT-DISCOVERY' })).id);
      assert.equal(pending.status, 'awaiting_approval', JSON.stringify(pending));
      assert.equal(pending.effect, 'none');
      assert.equal(pending.discoveredCapabilityId, undefined, 'An unsubmitted preview cannot publish a submit artifact');
      assert.deepEqual(pending.approval?.summary, { clientReference: '10001', product: 'Everyday Savings', externalReference: 'SUBMIT-DISCOVERY' });
      assert.equal((await records()).length, 0);
      await request(`/api/runs/${pending.id}/approve`, { epoch: pending.epoch - 1, approvalId: pending.approval!.id }, 409);
      await request(`/api/runs/${pending.id}/approve`, { epoch: pending.epoch, approvalId: 'unrelated-approval' }, 409);
      assert.equal((await records()).length, 0);
      const callsBeforeApproval=providerCalls;
      await approve(pending);
      const discovered = await settle(pending.id);
      assert.equal(discovered.result, 'succeeded', JSON.stringify(discovered));
      assert.equal(discovered.outcomeCode, 'DISCOVERED');
      assert.equal(discovered.effect, 'verified');
      assert.equal(discovered.modelCalls,pending.modelCalls,'Approval must execute the retained proposal without another model decision');
      assert.equal(providerCalls,callsBeforeApproval);
      assert.equal(discovered.approval?.consumed, true);
      assert.equal(discovered.events.filter(event => event.kind === 'commit_sent').length, 1);
      assert.ok(discovered.discoveredCapabilityId);
      submitArtifact = await request<CapabilityRecord>(`/api/capabilities/${discovered.discoveredCapabilityId}`);
      assert.equal(submitArtifact.status, 'draft');
      assertInputsParameterized(submitArtifact);
      const commits = submitArtifact.steps.filter(step => step.effect === 'commit');
      assert.equal(commits.length, 1, 'The approval pause must not record duplicate commit steps');
      const previewIndex = submitArtifact.steps.findIndex(step => step.checkpoint === 'preview');
      assert.ok(previewIndex >= 0, 'A submit artifact requires a verified preview checkpoint');
      assert.ok(previewIndex < submitArtifact.steps.indexOf(commits[0]));
      assert.equal(submitArtifact.steps.at(-1)?.checkpoint, 'submitted');
      assert.equal((await records()).length, 1);

      const callsBeforeReplay = providerCalls;
      const pendingReplay = await settle((await create('submit', 'replay', {
        clientReference: '10002', product: 'Growth Savings', externalReference: 'SUBMIT-REPLAY',
      }, submitArtifact.id)).id);
      assert.equal(pendingReplay.status, 'awaiting_approval', JSON.stringify(pendingReplay));
      assert.equal(pendingReplay.modelCalls, 0);
      assert.equal(providerCalls, callsBeforeReplay);
      assert.notEqual(pendingReplay.approval?.id, pending.approval?.id);
      assert.notEqual(pendingReplay.approval?.digest, pending.approval?.digest);
      assert.deepEqual(pendingReplay.approval?.summary, { clientReference: '10002', product: 'Growth Savings', externalReference: 'SUBMIT-REPLAY' });
      await request(`/api/runs/${pendingReplay.id}/approve`, { epoch: pendingReplay.epoch, approvalId: pending.approval!.id }, 409);
      assert.equal((await records()).length, 1, 'A prior run approval cannot authorize the replay');
      await approve(pendingReplay);
      const replay = await settle(pendingReplay.id);
      assert.equal(replay.result, 'succeeded', JSON.stringify(replay));
      assert.equal(replay.effect, 'verified');
      assert.equal(replay.output?.clientReference, '10002');
      assert.equal(replay.output?.product, 'Growth Savings');
      assert.equal(replay.output?.externalReference, 'SUBMIT-REPLAY');
      assert.equal(replay.modelCalls, 0);
      assert.equal(providerCalls, callsBeforeReplay);
      assert.equal(replay.events.filter(event => event.kind === 'commit_sent').length, 1);
      await request(`/api/runs/${replay.id}/approve`, { epoch: replay.epoch, approvalId: pendingReplay.approval!.id }, 409);
      const saved = await records();
      assert.equal(saved.length, 2);
      assert.equal(saved.filter(record => record.externalReference === 'SUBMIT-DISCOVERY').length, 1);
      assert.equal(saved.filter(record => record.externalReference === 'SUBMIT-REPLAY').length, 1);
      assert.notEqual(saved[0].applicationReference, saved[1].applicationReference);
    });

    await t.test('expired approval cannot dispatch a submission', async () => {
      assert.ok(submitArtifact);
      const pending = await settle((await create('submit', 'replay', { externalReference: 'EXPIRED-APPROVAL' }, submitArtifact.id)).id);
      assert.equal(pending.status, 'awaiting_approval', JSON.stringify(pending));
      // Advance only this fixture's expiry; do not change the process clock.
      workbench.engine.get(pending.id).approval!.expiresAt = new Date(Date.now() - 1_000).toISOString();
      const rejection = await request<{ error: string }>(`/api/runs/${pending.id}/approve`, { epoch: pending.epoch, approvalId: pending.approval!.id }, 409);
      assert.match(rejection.error, /expired/i);
      assert.equal((await records()).length, 2);
      assert.equal(workbench.engine.get(pending.id).events.some(event => event.kind === 'commit_sent'), false);
      await request(`/api/runs/${pending.id}/stop`, { epoch: pending.epoch });
    });

    await t.test('changed visible preview cannot use the approval for the original details', async () => {
      assert.ok(submitArtifact);
      const pending = await settle((await create('submit', 'replay', { externalReference: 'ORIGINAL-PREVIEW' }, submitArtifact.id)).id);
      assert.equal(pending.status, 'awaiting_approval', JSON.stringify(pending));
      const page = workbench.engine.sessions.get(pending.id)!.page;
      // Test harness changes the actual UI behind a waiting approval to simulate
      // target-side drift. Production human input instead invalidates ownership.
      await page.getByRole('link', { name: 'Edit details', exact: true }).click();
      await page.getByLabel('Product', { exact: true }).selectOption({ label: 'Growth Savings' });
      await page.getByLabel('External reference', { exact: true }).fill('CHANGED-PREVIEW');
      await page.getByRole('button', { name: 'Review application', exact: true }).click();
      const response = await fetch(workbench.url + `/api/runs/${pending.id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ epoch: pending.epoch, approvalId: pending.approval!.id }),
      });
      assert.equal(response.ok, false, 'Approval must fail if the actual preview no longer matches');
      assert.equal(response.status,409,'A changed preview is an approval conflict, not a server failure');
      const rejection = await response.json() as { error: string };
      assert.match(rejection.error, /application differs|preview changed/i);
      assert.equal((await records()).length, 2);
      assert.equal(workbench.engine.get(pending.id).approval!.consumed, false);
      assert.equal(workbench.engine.get(pending.id).events.some(event => event.kind === 'commit_sent'), false);
      await request(`/api/runs/${pending.id}/stop`, { epoch: pending.epoch });
    });

    await t.test('a deadline crossed during the final preview check leaves no commit permit or dispatched submission', async () => {
      const pending=await settle((await create('submit','discovery',{externalReference:'DEADLINE-BEFORE-COMMIT'})).id);
      assert.equal(pending.status,'awaiting_approval',JSON.stringify(pending));
      const session=workbench.engine.sessions.get(pending.id)!;
      const internal=workbench.engine as unknown as {
        checkpoint(s:typeof session,name:'client'|'account'|'preview'|'submitted'):Promise<Record<string,unknown>>;
      };
      const original=internal.checkpoint.bind(workbench.engine);
      const budget=workbench.engine.get(pending.id).discoveryBudget!;
      budget.maxActiveMs=budget.activeMs+1_000;
      let previewReads=0;
      // The first preview read reviews the approval. The second belongs to the
      // worker's retained commit step. A slow target crosses its remaining
      // budget there, immediately before the actual input-dispatch boundary.
      internal.checkpoint=async(s,name)=>{
        const result=await original(s,name);
        if(s===session&&name==='preview'&&++previewReads===2)await new Promise(resolve=>setTimeout(resolve,1_100));
        return result;
      };
      try {
        await approve(pending);
        const interrupted=await settle(pending.id);
        assert.equal(interrupted.intervention?.code,'DISCOVERY_TIME_LIMIT',JSON.stringify(interrupted));
        assert.equal(previewReads,2);
        assert.ok(interrupted.events.some(event=>event.kind==='approval_consumed'));
        assert.equal(interrupted.events.some(event=>event.kind==='commit_sent'),false);
        assert.equal(interrupted.effect,'none');
        assert.equal(session.permitCommit,false,'A rejected pre-dispatch action must not leave a network submission permit');
        assert.equal(session.pendingStep,undefined);
        assert.equal((await records()).length,2);
        await request(`/api/runs/${pending.id}/stop`,{epoch:interrupted.epoch});
      } finally {internal.checkpoint=original;}
    });
  } finally {
    await server?.close();
    if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(dataPath, { recursive: true, force: true });
  }
});
