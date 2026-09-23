import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import {
  configureProvider, getProviderStatuses, proposeAction, ProviderRequestCancelled, resolveProviderConfig,
} from '../src/server/providers.ts';
import type { DiscoveryProposal, ProviderConfig } from '../src/shared/contracts.ts';

const secret = 'synthetic-provider-test-secret';
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
const context = {
  goal: 'Find the requested client.',
  task: 'balance' as const,
  inputs: {
    clientReference: '10001', accountReference: 'SAV-1001',
    product: 'Everyday Savings' as const, externalReference: 'LOCAL-001',
  },
  history: [],
  observation: {
    url: 'http://127.0.0.1:3001/target', title: 'Synthetic banking lab', text: 'Client search', screenshot,
    controls: [{ id: 'client-search', role: 'textbox', name: 'Member reference',
      locator: { kind: 'label' as const, value: 'Member reference', exact: true } }],
  },
};

function config(provider: ProviderConfig['provider'] = 'openai'): ProviderConfig {
  const models = { openai: 'gpt-4.1', anthropic: 'claude-sonnet-4-6', google: 'gemini-2.5-flash' };
  return { provider, model: models[provider], apiKey: secret };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return { action: 'fill', targetId: 'client-search', value: null, inputKey: 'clientReference', reason: 'Find the client', ...overrides };
}

function openaiResponse(reply: unknown): Response {
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: JSON.stringify(reply) },
  ] }] });
}

function replyWith(reply: unknown): void {
  mock.method(globalThis, 'fetch', async () => openaiResponse(reply));
}

describe('provider configuration and bounded discovery contracts', { concurrency: false }, () => {
  beforeEach(() => {
    // Every test replaces transport explicitly. An accidental live call fails locally.
    mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in provider test'); });
  });
  afterEach(() => mock.restoreAll());

  test('rejects unknown providers and missing keys without requesting a model', async () => {
    const invalid = 'unknown-provider' as ProviderConfig['provider'];
    assert.throws(() => resolveProviderConfig(invalid), /Unknown discovery provider/);
    assert.throws(() => configureProvider({ ...config(), provider: invalid }), /Unknown discovery provider/);
    assert.throws(() => configureProvider({ ...config(), apiKey: '' }), /No valid openai API key/);
    await assert.rejects(proposeAction({ ...config(), apiKey: '   ' }, context), /No valid openai API key/);
  });

  test('normalizes OpenAI structured output and sends the screenshot with a bounded action schema', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.model, 'gpt-4.1');
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: screenshot, detail: 'auto' });
      const prompt = JSON.parse(body.input[0].content[0].text);
      assert.equal(prompt.observation.controls[0].id, 'client-search');
      assert.equal('locator' in prompt.observation.controls[0], false);
      assert.equal(String(init?.body).includes(secret), false);
      return openaiResponse(proposal());
    });
    assert.deepEqual(await proposeAction(config(), context), {
      action: 'fill', targetId: 'client-search', inputKey: 'clientReference', reason: 'Find the client',
    });
    assert.equal(calls, 1);
  });

  test('normalizes an Anthropic proposal tool call and sends an inline image', async () => {
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
      assert.equal(new Headers(init?.headers).get('x-api-key'), secret);
      assert.equal(new Headers(init?.headers).get('anthropic-version'), '2023-06-01');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[0].content[0].type, 'image');
      assert.equal(body.messages[0].content[0].source.media_type, 'image/png');
      assert.equal(body.messages[0].content[0].source.data, screenshot.split(',')[1]);
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].name, 'propose_ui_action');
      assert.equal(body.tool_choice.disable_parallel_tool_use, true);
      return Response.json({ stop_reason: 'tool_use', content: [
        { type: 'tool_use', name: 'propose_ui_action', input: proposal() },
      ] });
    });
    assert.deepEqual(await proposeAction(config('anthropic'), context), {
      action: 'fill', targetId: 'client-search', inputKey: 'clientReference', reason: 'Find the client',
    });
  });

  test('normalizes Google JSON output, ignoring thought text, and sends an inline image', async () => {
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), secret);
      assert.equal(String(url).includes(secret), false);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.generationConfig.responseJsonSchema.additionalProperties, false);
      assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: screenshot.split(',')[1] } });
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, text: 'This is not the action response.' }, { text: JSON.stringify(proposal()) },
      ] } }] });
    });
    assert.deepEqual(await proposeAction(config('google'), context), {
      action: 'fill', targetId: 'client-search', inputKey: 'clientReference', reason: 'Find the client',
    });
  });

  test('rejects invented or ambiguous target IDs', async () => {
    replyWith(proposal({ targetId: 'unobserved-control' }));
    await assert.rejects(proposeAction(config(), context), /absent or ambiguous control/);
    replyWith(proposal());
    const ambiguous = { ...context, observation: { ...context.observation,
      controls: [...context.observation.controls, ...context.observation.controls] } };
    await assert.rejects(proposeAction(config(), ambiguous), /absent or ambiguous control/);
  });

  test('fill and select require declared parameter references and reject literal values', async () => {
    for (const action of ['fill', 'select']) {
      for (const overrides of [{ inputKey: null }, { value: '10001' }]) {
        replyWith(proposal({ action, ...overrides }));
        await assert.rejects(proposeAction(config(), context), /declared inputKey instead of a literal value/);
      }
      replyWith(proposal({ action, inputKey: 'undeclaredParameter' }));
      await assert.rejects(proposeAction(config(), context), /invalid action contract/);
    }
  });

  test('only accepts bounded keyboard actions and rejects unsupported payload fields', async () => {
    replyWith(proposal({ action: 'press', inputKey: null, value: 'Control+L' }));
    await assert.rejects(proposeAction(config(), context), /unsupported keyboard action/);
    replyWith(proposal({ code: 'arbitrary code must never be accepted' }));
    await assert.rejects(proposeAction(config(), context), /invalid action contract/);
    replyWith(proposal({ action: 'click', inputKey: null, value: 'arbitrary value' }));
    await assert.rejects(proposeAction(config(), context), /literal value outside a keyboard action/);
    replyWith(proposal({ action: 'press', inputKey: null, value: 'Tab' }));
    assert.equal((await proposeAction(config(), context)).value, 'Tab');
  });

  test('normalizes human intervention without a target or value', async () => {
    replyWith(proposal({ action: 'ask_human', targetId: null, inputKey: null, reason: 'Authentication requires an operator' }));
    const expected: DiscoveryProposal = { action: 'ask_human', reason: 'Authentication requires an operator' };
    assert.deepEqual(await proposeAction(config(), context), expected);
    replyWith(proposal({ action: 'done', inputKey: null }));
    await assert.rejects(proposeAction(config(), context), /control to an untargeted action/);
  });

  test('removes declared input values from persisted proposal reasons', async () => {
    replyWith(proposal({ reason: 'Find 10001 / SAV-1001; prepare Everyday Savings with LOCAL-001 for 10001' }));
    const result = await proposeAction(config(), context);
    assert.equal(result.reason, 'Find [input] / [input]; prepare [input] with [input] for [input]');
    for (const input of Object.values(context.inputs)) assert.equal(JSON.stringify(result).includes(input), false);
  });

  test('rejects provider refusals and incomplete responses instead of fabricating an action', async () => {
    const cases: Array<[ProviderConfig['provider'], unknown, RegExp]> = [
      ['openai', { status: 'incomplete' }, /did not complete/],
      ['openai', { output: [{ content: [{ type: 'refusal', refusal: secret }] }] }, /declined this discovery request/],
      ['anthropic', { stop_reason: 'max_tokens', content: [] }, /did not complete/],
      ['anthropic', { content: [{ type: 'tool_use', name: 'other_tool', input: {} }] }, /exactly one permitted/],
      ['google', { candidates: [{ finishReason: 'SAFETY' }] }, /did not complete/],
    ];
    for (const [provider, envelope, expected] of cases) {
      mock.method(globalThis, 'fetch', async () => Response.json(envelope));
      await assert.rejects(proposeAction(config(provider), context), expected);
    }
  });

  test('API failures give useful diagnostics without echoing provider bodies or keys', async () => {
    const cases: Array<[number, RegExp]> = [
      [401, /Authentication failed/], [403, /does not have permission/], [404, /model or endpoint was not found/],
      [429, /Rate or spending limit/], [400, /request format or model settings/], [503, /temporarily unavailable/],
    ];
    for (const [status, expected] of cases) {
      mock.method(globalThis, 'fetch', async () => new Response(`raw-sensitive-server-message ${secret}`, { status }));
      await assert.rejects(proposeAction(config(), context), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes('raw-sensitive-server-message'), false);
        return true;
      });
    }
  });

  test('transport and malformed response errors never expose raw response details', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error(`connect to https://host.example/?key=${secret}`); });
    await assert.rejects(proposeAction(config(), context), /could not be reached; check connectivity/);
    mock.method(globalThis, 'fetch', async () => new Response(`raw provider response ${secret}`));
    await assert.rejects(proposeAction(config(), context), /invalid JSON envelope/);
    mock.method(globalThis, 'fetch', async () => Response.json({ output: [
      { content: [{ type: 'output_text', text: `malformed action ${secret}` }] },
    ] }));
    await assert.rejects(proposeAction(config(), context), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /valid action object/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  });

  test('an already cancelled request never reaches any provider', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => { calls++; return openaiResponse(proposal()); });
    const controller = new AbortController();
    controller.abort(new Error(secret));
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      await assert.rejects(proposeAction(config(provider), context, controller.signal), ProviderRequestCancelled);
    }
    assert.equal(calls, 0);
  });

  test('cancelling an in-flight request aborts transport without exposing its reason', async () => {
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let transportSignal: AbortSignal | undefined;
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      transportSignal = init!.signal!;
      start();
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener('abort', () => reject(new Error(`Aborted ${secret}`)), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = proposeAction(config(), context, controller.signal);
    await started;
    controller.abort(new Error(secret));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProviderRequestCancelled);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(transportSignal?.aborted, true);
  });

  test('a response arriving after cancellation is never returned as a usable proposal', async () => {
    let release!: (response: Response) => void;
    mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = proposeAction(config(), context, controller.signal);
    controller.abort();
    release(openaiResponse(proposal()));
    await assert.rejects(pending, ProviderRequestCancelled);
  });

  test('rejects remote screenshot URLs before transport and oversized provider responses', async () => {
    await assert.rejects(proposeAction(config(), { ...context,
      observation: { ...context.observation, screenshot: 'https://untrusted.example/image.png' } }), /base64 data URL/);
    mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(1024 * 1024 + 1)));
    await assert.rejects(proposeAction(config(), context), /response exceeded the size limit/);
  });

  test('validates endpoints and exposes only configuration metadata', () => {
    for (const baseUrl of ['http://remote.example/v1', 'https://user:password@remote.example/v1',
      'https://remote.example/v1?apiKey=secret', 'https://remote.example/v1#fragment']) {
      assert.throws(() => configureProvider({ ...config(), baseUrl }), /Provider base URL requires HTTPS/);
    }
    configureProvider({ ...config(), baseUrl: 'http://127.0.0.1:9999/' });
    const resolved = resolveProviderConfig('openai', 'gpt-4.1-mini');
    assert.equal(resolved.baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(resolved.model, 'gpt-4.1-mini');
    const statuses = getProviderStatuses();
    assert.deepEqual(statuses.find(status => status.id === 'openai'), { id: 'openai', configured: true, model: 'gpt-4.1' });
    for (const status of statuses) assert.deepEqual(Object.keys(status).sort(), ['configured', 'id', 'model']);
    assert.equal(JSON.stringify(statuses).includes(secret), false);
  });
});
