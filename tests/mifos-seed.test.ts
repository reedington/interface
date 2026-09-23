import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const { seedMifos, createFineractApi } = await import(new URL('../scripts/mifos-seed.mjs', import.meta.url).href);

type Row = Record<string, any>;
function fakeApi() {
  const products: Row[] = [], clients: Row[] = [], accounts: Row[] = [];
  const writes: Array<{ path: string; body: Row }> = [];
  let depositFault: 'none' | 'accepted-response-lost' | 'not-accepted-response-lost' | 'rejected' = 'none';
  const api = async (path: string, body?: Row): Promise<any> => {
    const url = new URL(path, 'http://fixture.invalid'), route = url.pathname;
    const copy = (value: any) => structuredClone(value);
    if (body !== undefined) writes.push({ path, body: copy(body) });
    if (path === '/clients/template') return { activationDate: [2026, 9, 22] };
    if (path === '/paymenttypes') return [{ id: 1, name: 'Money Transfer', isSystemDefined: false }];
    if (route === '/savingsproducts') {
      if (!body) return copy(products);
      const product = { ...body, id: products.length + 1,
        currency: { code: body.currencyCode, decimalPlaces: body.digitsAfterDecimal },
        ...Object.fromEntries(['accountingRule', 'interestCompoundingPeriodType', 'interestPostingPeriodType', 'interestCalculationType', 'interestCalculationDaysInYearType'].map(key => [key, { id: body[key] }])),
      };
      products.push(product); return { resourceId: product.id };
    }
    if (route.startsWith('/savingsproducts/')) return copy(products.find(item => item.id === Number(route.split('/')[2])));
    if (route === '/clients') {
      if (!body) return { totalFilteredRecords: clients.length, pageItems: copy(clients) };
      const client = { ...body, id: clients.length + 1, active: true, status: { id: 300 } };
      clients.push(client); return { resourceId: client.id, clientId: client.id };
    }
    if (route.startsWith('/clients/')) return copy(clients.find(item => item.id === Number(route.split('/')[2])));
    if (route === '/savingsaccounts') {
      if (!body) return { totalFilteredRecords: accounts.length, pageItems: copy(accounts) };
      const account = { ...body, id: accounts.length + 1, savingsProductId: body.productId,
        currency: { code: 'USD' }, nominalAnnualInterestRate: 0, allowOverdraft: false, charges: [],
        status: { id: 100, active: false }, summary: { accountBalance: 0 }, transactions: [],
      };
      accounts.push(account);
      // Pinned API supports a bulk result envelope; creation must reconcile by reference.
      return { bulkResponses: [{ resourceId: account.id }] };
    }
    if (route.startsWith('/savingsaccounts/')) {
      const account = accounts.find(item => item.id === Number(route.split('/')[2]));
      assert.ok(account);
      if (!body) return copy(account);
      const command = url.searchParams.get('command');
      if (command === 'approve') {
        assert.equal(account.status.id, 100); account.status = { id: 200, active: false };
      } else if (command === 'activate') {
        assert.equal(account.status.id, 200); account.status = { id: 300, active: true };
      } else if (command === 'deposit') {
        assert.equal(account.status.id, 300); assert.equal(body.paymentTypeId, 1);
        const fault = depositFault; depositFault = 'none';
        if (fault === 'not-accepted-response-lost') throw new Error('Connection ended before an outcome was known');
        if (fault === 'rejected') throw Object.assign(new Error('Validation rejected'), { statusCode: 400 });
        const transaction = { id: account.transactions.length + 1, amount: Number(body.transactionAmount), transactionType: { deposit: true }, reversed: false };
        account.transactions.push(transaction); account.summary.accountBalance += transaction.amount;
        if (fault === 'accepted-response-lost') throw new Error('Confirmation was lost after persistence');
        return { resourceId: transaction.id };
      } else throw new Error(`Unexpected fixture command ${command}`);
      return { resourceId: account.id };
    }
    throw new Error(`Unexpected fixture API path ${path}`);
  };
  return { api, products, clients, accounts, writes, setDepositFault: (fault: typeof depositFault) => { depositFault = fault; } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'interface-mifos-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, environment: {}, output: () => {} };
}

test('seed prepares real API-shaped US fixtures and rereads account IDs from bulk creation responses', async t => {
  const options = await fixture(t), target = fakeApi();
  const manifest = await seedMifos({ ...options, api: target.api });
  assert.deepEqual(manifest.productIds, { 'Everyday Savings': 1, 'Growth Savings': 2 });
  assert.equal(manifest.seedDate, '2026-09-22');
  assert.equal(manifest.officeId, 1);
  assert.deepEqual(manifest.clients.map((client: Row) => [client.clientReference, client.accountReference]), [['10001', 'SAV-1001'], ['10002', 'SAV-1002']]);
  assert.deepEqual(target.clients.map(client => [client.accountNo, client.externalId, client.firstname, client.lastname]), [['10001', '10001', 'Alex', 'Morgan'], ['10002', '10002', 'Taylor', 'Reed']]);
  assert.deepEqual(target.accounts.map(account => [account.status.id, account.summary.accountBalance, account.transactions.length]), [[300, 12540.75, 1], [300, 840, 1]]);
  assert.equal(target.products.every(product => product.currency.code === 'USD' && product.allowOverdraft === false && product.charges.length === 0), true);
  const commands = target.writes.filter(write => write.path.includes('command=')).map(write => write.path.split('command=')[1]);
  assert.deepEqual(commands, ['approve', 'activate', 'deposit', 'approve', 'activate', 'deposit']);
  const file = join(options.root, '.local/mifos/fixtures.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), manifest);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('repeated setup performs zero writes and preserves subsequent operator transactions', async t => {
  const options = await fixture(t), target = fakeApi();
  const before = await seedMifos({ ...options, api: target.api });
  target.accounts[0].summary.accountBalance = 12000;
  target.accounts[0].transactions.push({ id: 99, transactionType: { withdrawal: true }, amount: 540.75 });
  const writeCount = target.writes.length;
  const after = await seedMifos({ ...options, api: target.api });
  assert.equal(target.writes.length, writeCount);
  assert.equal(target.accounts[0].summary.accountBalance, 12000);
  assert.deepEqual(after, before);
});

test('an older manifest gains the verified Head Office binding without API writes', async t => {
  const options = await fixture(t), target = fakeApi();
  const manifest = await seedMifos({ ...options, api: target.api });
  const legacy = { ...manifest }; delete legacy.officeId;
  const path = join(options.root, '.local/mifos/fixtures.json');
  await writeFile(path, JSON.stringify(legacy));
  const writeCount = target.writes.length;
  const upgraded = await seedMifos({ ...options, api: target.api });
  assert.deepEqual(upgraded, manifest);
  assert.equal(upgraded.officeId, 1);
  assert.equal(target.writes.length, writeCount);
  assert.equal(target.clients.every(client => client.officeId === upgraded.officeId), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), upgraded);
});

test('a conflicting manifest office is rejected before API use and is not overwritten', async t => {
  const options = await fixture(t), target = fakeApi();
  const manifest = await seedMifos({ ...options, api: target.api });
  const path = join(options.root, '.local/mifos/fixtures.json');
  const changed = JSON.stringify({ ...manifest, officeId: 2 });
  await writeFile(path, changed);
  let calls = 0;
  await assert.rejects(seedMifos({ ...options, api: async () => { calls++; throw new Error('No request allowed'); } }), /another office/);
  assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), changed);
});

test('a legacy manifest cannot gain an office binding when a fixture member moved offices', async t => {
  const options = await fixture(t), target = fakeApi();
  const manifest = await seedMifos({ ...options, api: target.api });
  const legacy = { ...manifest }; delete legacy.officeId;
  const path = join(options.root, '.local/mifos/fixtures.json');
  const saved = JSON.stringify(legacy); await writeFile(path, saved);
  target.clients[0].officeId = 2;
  const writeCount = target.writes.length;
  await assert.rejects(seedMifos({ ...options, api: target.api }), /Fixture collision for member/);
  assert.equal(target.writes.length, writeCount);
  assert.equal(target.clients[0].officeId, 2);
  assert.equal(await readFile(path, 'utf8'), saved);
});

test('an unowned member reference collision is rejected before any API mutation', async t => {
  const options = await fixture(t), target = fakeApi();
  target.clients.push({ id: 42, accountNo: '10001', externalId: '10001', firstname: 'Alex', lastname: 'Morgan', officeId: 1, active: true });
  await assert.rejects(seedMifos({ ...options, api: target.api }), /Fixture collision/);
  assert.equal(target.writes.length, 0, 'Matching names alone do not establish fixture ownership');
  assert.equal(target.clients[0].id, 42);
});

test('changed product terms or account ownership reject setup without resetting operator data', async t => {
  const options = await fixture(t), target = fakeApi();
  await seedMifos({ ...options, api: target.api });
  const writeCount = target.writes.length;
  target.products[0].allowOverdraft = true;
  await assert.rejects(seedMifos({ ...options, api: target.api }), /Fixture collision for product/);
  assert.equal(target.products[0].allowOverdraft, true);
  target.products[0].allowOverdraft = false;
  target.accounts[0].clientId = 999;
  await assert.rejects(seedMifos({ ...options, api: target.api }), /Fixture collision for account/);
  assert.equal(target.writes.length, writeCount);
});

test('lost deposit confirmation is reconciled from persisted transactions without duplicate funding', async t => {
  const options = await fixture(t), target = fakeApi();
  target.setDepositFault('accepted-response-lost');
  await assert.rejects(seedMifos({ ...options, api: target.api }), /Confirmation was lost/);
  assert.equal(target.accounts[0].transactions.length, 1);
  await seedMifos({ ...options, api: target.api });
  assert.equal(target.writes.filter(write => write.path.includes('/transactions?command=deposit')).length, 2);
  assert.deepEqual(target.accounts.map(account => account.transactions.length), [1, 1]);
});

test('an inconclusive funding intent is not retried; definite HTTP400 rejection can be corrected and resumed', async t => {
  const options = await fixture(t), target = fakeApi();
  target.setDepositFault('not-accepted-response-lost');
  await assert.rejects(seedMifos({ ...options, api: target.api }), /outcome was known/);
  const writes = target.writes.length;
  await assert.rejects(seedMifos({ ...options, api: target.api }), /uncertain initial funding/);
  assert.equal(target.writes.length, writes);
  assert.equal(target.accounts[0].summary.accountBalance, 0);
  const second = await fixture(t), rejected = fakeApi();
  rejected.setDepositFault('rejected');
  await assert.rejects(seedMifos({ ...second, api: rejected.api }), /Validation rejected/);
  await seedMifos({ ...second, api: rejected.api });
  assert.deepEqual(rejected.accounts.map(account => account.transactions.length), [1, 1]);
});

test('target/tenant mismatch and remote URLs are rejected before any API use', async t => {
  const options = await fixture(t), target = fakeApi();
  await seedMifos({ ...options, api: target.api });
  let calls = 0;
  const api = async () => { calls++; throw new Error('No request allowed'); };
  await assert.rejects(seedMifos({ ...options, api, environment: { MIFOS_URL: 'http://127.0.0.1:4201' } }), /another target/);
  await assert.rejects(seedMifos({ ...options, api, environment: { MIFOS_TENANT: 'another' } }), /tenant/);
  await assert.rejects(seedMifos({ ...options, api, environment: { MIFOS_URL: 'https://example.com' } }), /loopback/);
  assert.equal(calls, 0);
});

test('setup API transport refuses redirects and sanitizes rejected response details', async () => {
  const secret = 'synthetic-private-password';
  const api = createFineractApi({ origin: 'http://127.0.0.1:4200', password: secret,
    fetchImpl: async (url: string, request: RequestInit) => {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:4200');
      assert.equal(request.redirect, 'error');
      return new Response(JSON.stringify({ error: secret }), { status: 401 });
    },
  });
  await assert.rejects(api('/clients'), (error: any) => {
    assert.equal(error.statusCode, 401); assert.equal(error.message.includes(secret), false); return true;
  });
});

test('an isolated fixture directory records initial emptiness and repeat setup sends zero API writes', async t => {
  const options = await fixture(t), target = fakeApi(), messages: string[] = [];
  const environment = { MIFOS_COMPOSE_PROJECT: 'interface-assessment-test', MIFOS_URL: 'http://127.0.0.1:4201', MIFOS_FIXTURE_DIR: '.local/isolated' };
  const before = await seedMifos({ ...options, environment, api: target.api, output: (value: string) => messages.push(value) });
  assert.deepEqual(before.initialRecordCounts, { members: 0, savingsAccounts: 0, savingsProducts: 0 });
  assert.equal(before.composeProject, environment.MIFOS_COMPOSE_PROJECT);
  assert.deepEqual(JSON.parse(await readFile(join(options.root, '.local/isolated/fixtures.json'), 'utf8')), before);
  await assert.rejects(stat(join(options.root, '.local/mifos/fixtures.json')), { code: 'ENOENT' });
  const after = await seedMifos({ ...options, environment, api: target.api, output: (value: string) => messages.push(value) });
  assert.deepEqual(after, before);
  assert.equal(messages.at(-1), 'Fixture API writes: 0.');
});

test('fixture state cannot be reused by another Compose project even on the same origin', async t => {
  const options = await fixture(t), target = fakeApi();
  await seedMifos({ ...options, api: target.api });
  let calls = 0;
  await assert.rejects(seedMifos({ ...options, environment: { MIFOS_COMPOSE_PROJECT: 'other-project' }, api: async () => { calls++; } }), /another Compose project/);
  assert.equal(calls, 0);
});
