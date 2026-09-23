import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startTarget, targetSeed } from '../src/server/target.js';

interface PageResponse {
  status: number;
  html: string;
  headers: Headers;
}
interface SavedApplication {
  applicationReference: string;
  applicationStatus: string;
  clientReference: string;
  product: string;
  externalReference: string;
}
type Form = Record<string, string>;
type TargetSession = (path: string, form?: Form, headers?: Record<string, string>) => Promise<PageResponse>;

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'interface-target-test-'));
  let server: Awaited<ReturnType<typeof startTarget>> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  // Ephemeral ports make this suite independent of the app and other test files.
  server = await startTarget(0, dataDir);
  function session(): TargetSession {
    let cookie = '';
    return async (path, form, extraHeaders = {}) => {
      assert.ok(server, 'The test target must be running');
      const response = await fetch(server.url + path, {
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...extraHeaders,
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, html: await response.text(), headers: response.headers };
    };
  }
  return {
    session,
    get url() { assert.ok(server); return server.url; },
    async saved(): Promise<SavedApplication[]> {
      try { return JSON.parse(await readFile(join(dataDir, 'banking-lab', 'applications.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    async restart() {
      await server?.close();
      server = undefined;
      server = await startTarget(0, dataDir);
    },
  };
}

function csrf(page: PageResponse) {
  const match = page.html.match(/name="csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'A target form must supply a CSRF token');
  return match[1];
}
function rowCount(page: PageResponse) {
  return [...page.html.matchAll(/<tr data-application-row>/g)].length;
}
function visibleField(page: PageResponse, field: string) {
  const match = page.html.match(new RegExp(`data-field="${field}">([^<]*)<`));
  assert.ok(match, `Missing visible ${field}`);
  return match[1];
}
async function prepare(session: TargetSession, externalReference: string, scenario = 'normal') {
  assert.equal((await session(`/?scenario=${scenario}`)).status, 200);
  const details = await session('/clients/10001/applications/new');
  assert.equal(details.status, 200);
  const fields = { csrf: csrf(details), clientReference: '10001', product: 'Everyday Savings', externalReference };
  const preview = await session('/clients/10001/applications/review', fields);
  assert.equal(preview.status, 200);
  assert.match(preview.html, /data-page="preview"/);
  return { fields, preview };
}

test('US credit union target preserves member/account identity and raw USD balances', async (t) => {
  const target = await fixture(t);
  assert.notEqual(new URL(target.url).port, '0');
  const session = target.session();
  const home = await session('/');
  assert.match(home.html, /Local Credit Union Lab/);
  assert.match(home.html, /<html lang="en-US">/);
  assert.match(home.html, /<label for="reference">Member reference<\/label>/);
  assert.match(home.html, /<button type="submit">Search members<\/button>/);
  assert.ok(targetSeed.every((member) => member.currency === 'USD'));
  for (const [client, account, balance, formatted, memberName] of [
    ['10001', 'SAV-1001', '12540.75', '$12,540.75', 'Alex Morgan'],
    ['10002', 'SAV-1002', '840.00', '$840.00', 'Taylor Reed'],
  ]) {
    const results = await session(`/clients?reference=${client}`);
    assert.match(results.html, new RegExp(`Open member ${client}`));
    const details = await session(`/clients/${client}`);
    assert.equal(visibleField(details, 'client-reference'), client);
    assert.ok(details.html.includes(`<h1>${memberName}</h1>`));
    assert.match(details.html, /Member profile/);
    const accountPage = await session(`/accounts/${account}`);
    assert.equal(visibleField(accountPage, 'client-reference'), client);
    assert.equal(visibleField(accountPage, 'account-reference'), account);
    assert.equal(visibleField(accountPage, 'current-balance'), balance);
    assert.equal(visibleField(accountPage, 'currency'), 'USD');
    assert.ok(accountPage.html.includes(`<div class="balance">${formatted}</div>`));
  }
});

test('reviewing an application does not persist a write', async (t) => {
  const target = await fixture(t);
  const session = target.session();
  const { preview } = await prepare(session, 'PREVIEW-ONLY');
  assert.equal(visibleField(preview, 'external-reference'), 'PREVIEW-ONLY');
  assert.match(preview.html, /action="\/applications" method="post"/);
  assert.deepEqual(await target.saved(), []);
  assert.equal(rowCount(await session('/applications?externalReference=PREVIEW-ONLY')), 0);
  await target.restart();
  assert.deepEqual(await target.saved(), []);
  assert.equal(rowCount(await target.session()('/applications?externalReference=PREVIEW-ONLY')), 0);
});

test('lost confirmation persists a record that can be reconciled without another submission', async (t) => {
  const target = await fixture(t);
  const session = target.session();
  const { fields } = await prepare(session, 'UNKNOWN-OUTCOME', 'commit_unknown');
  const submitted = await session('/applications', fields);
  assert.equal(submitted.status, 503);
  assert.match(submitted.html, /data-state="outcome-unknown"/);
  assert.doesNotMatch(submitted.html, /data-page="submitted"/);
  const saved = await target.saved();
  assert.equal(saved.length, 1);
  const reconciled = await session('/applications?externalReference=UNKNOWN-OUTCOME');
  assert.equal(rowCount(reconciled), 1);
  assert.equal(visibleField(reconciled, 'application-reference'), saved[0].applicationReference);
  assert.equal(visibleField(reconciled, 'application-status'), 'Pending Approval');
  assert.equal(visibleField(reconciled, 'client-reference'), '10001');
  assert.equal(visibleField(reconciled, 'product'), 'Everyday Savings');
  assert.equal(visibleField(reconciled, 'external-reference'), 'UNKNOWN-OUTCOME');
});

test('two concurrent submissions with one external reference create only one record', async (t) => {
  const target = await fixture(t);
  // Distinct browser sessions prevent a session-local guard from hiding a race.
  const first = target.session();
  const second = target.session();
  const a = await prepare(first, 'SHARED-REFERENCE');
  const b = await prepare(second, 'SHARED-REFERENCE');
  const responses = await Promise.all([first('/applications', a.fields), second('/applications', b.fields)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await target.saved()).length, 1);
  assert.equal(rowCount(await first('/applications?externalReference=SHARED-REFERENCE')), 1);
  assert.equal((await second('/applications', b.fields)).status, 409);
  assert.equal((await target.saved()).length, 1);
});

test('CSRF tokens are required, session-bound, and do not override a foreign origin', async (t) => {
  const target = await fixture(t);
  const owner = target.session();
  const other = target.session();
  const { fields } = await prepare(owner, 'CSRF-PROTECTED');
  await other('/');
  const { csrf: _token, ...withoutToken } = fields;
  for (const [session, form, headers] of [
    [owner, withoutToken, {}],
    [owner, { ...fields, csrf: 'wrong-token' }, {}],
    [other, fields, {}],
    [owner, fields, { origin: 'https://untrusted.example' }],
    [owner, fields, { origin: 'null' }],
  ] as Array<[TargetSession, Form, Record<string, string>]>) {
    assert.equal((await session('/applications', form, headers)).status, 403);
  }
  assert.deepEqual(await target.saved(), []);
  // Non-browser clients may omit Origin, but must still prove session + token.
  const accepted = await owner('/applications', fields);
  assert.equal(accepted.status, 200);
  assert.match(accepted.html, /data-page="submitted"/);
  assert.equal((await target.saved()).length, 1);
  const sameOrigin = await prepare(owner, 'SAME-ORIGIN');
  assert.equal((await owner('/applications', sameOrigin.fields, { origin: target.url })).status, 200);
});

test('confirmed applications survive a server restart with their original identity', async (t) => {
  const target = await fixture(t);
  const session = target.session();
  const { fields } = await prepare(session, 'SURVIVES-RESTART');
  const submitted = await session('/applications', fields);
  assert.equal(submitted.status, 200);
  const originalReference = visibleField(submitted, 'application-reference');
  await target.restart();
  const freshSession = target.session();
  const persisted = await freshSession('/applications?externalReference=SURVIVES-RESTART');
  assert.equal(rowCount(persisted), 1);
  assert.equal(visibleField(persisted, 'application-reference'), originalReference);
  assert.equal(visibleField(persisted, 'application-status'), 'Pending Approval');
  const repeated = await prepare(freshSession, 'SURVIVES-RESTART');
  assert.equal((await freshSession('/applications', repeated.fields)).status, 409);
  assert.equal((await target.saved()).length, 1);
});

test('reflected search, application filters, and invalid form values are HTML-escaped', async (t) => {
  const target = await fixture(t);
  const session = target.session();
  const payload = '\"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const encoded = encodeURIComponent(payload);
  const search = await session(`/clients?reference=${encoded}`);
  const filter = await session(`/applications?externalReference=${encoded}`);
  const form = await session('/clients/10001/applications/new');
  const invalid = await session('/clients/10001/applications/review', { csrf: csrf(form), product: 'Everyday Savings', externalReference: payload });
  assert.equal(invalid.status, 422);
  for (const response of [search, filter, invalid]) {
    assert.doesNotMatch(response.html, /<script>|<img\s/i);
    assert.match(response.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(response.html, /&quot;&gt;/);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  }
  assert.deepEqual(await target.saved(), []);
});

test('session restoration and notice dismissal repair the same cookie-backed session', async (t) => {
  const target = await fixture(t);
  const session = target.session();
  const expired = await session('/clients/10001?scenario=session_expired');
  assert.match(expired.html, /data-state="session_expired"/);
  const restored = await session('/restore-session', { csrf: csrf(expired), next: '/clients/10001?scenario=session_expired' });
  assert.equal(restored.status, 303);
  const client = await session(restored.headers.get('location')!);
  assert.equal(visibleField(client, 'client-reference'), '10001');
  assert.doesNotMatch(client.html, /data-state="session_expired"/);
  const notice = await session('/?scenario=unexpected_dialog');
  assert.match(notice.html, /role="dialog"/);
  const dismissed = await session('/dismiss-notice', { csrf: csrf(notice), next: '/' });
  assert.equal(dismissed.status, 303);
  const repaired = await session('/');
  assert.doesNotMatch(repaired.html, /role="dialog"/);
  assert.match(repaired.html, /data-page="search"/);
});
