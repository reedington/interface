import { mkdir, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadLocalEnv, localEnvironmentPath } from './local-env.mjs';
import { localMifosOrigin, localMifosTenant, localMifosProject, mifosFixtureDirectory } from './mifos-stack.mjs';

// Setup-only API fixture preparation. Browser workers never import this module.
// Fields/commands checked against Fineract 1.11.0's integration test helpers and
// SavingsAccountDataValidator; accountNo permits nonblank strings <=20 chars.
const seedVersion = 'us-fixtures-v1';
const marker = 'Interface synthetic US fixture [us-fixtures-v1]';
const members = [
  { clientReference: '10001', firstname: 'Alex', lastname: 'Morgan', accountReference: 'SAV-1001', initialBalance: '12540.75' },
  { clientReference: '10002', firstname: 'Taylor', lastname: 'Reed', accountReference: 'SAV-1002', initialBalance: '840.00' },
];
const products = [ { name: 'Everyday Savings', shortName: 'IES1' }, { name: 'Growth Savings', shortName: 'IGS1' } ];
const dateFields = date => ({ locale: 'en', dateFormat: 'yyyy-MM-dd', ...date });
const externalId = value => typeof value === 'object' ? value?.value : value;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

export function createFineractApi({ origin, username = 'mifos', password = 'password', tenant = 'default', fetchImpl = fetch }) {
  const local = localMifosOrigin(origin).origin;
  return async (path, body) => {
    if (!/^\/[a-zA-Z0-9/?=&._%-]+$/.test(path)) throw new Error('Invalid setup API path.');
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetchImpl(`${local}/fineract-provider/api/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
          'Fineract-Platform-TenantId': tenant, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error(`Fineract ${method} ${path.split('?')[0]} did not return a response. Setup will not automatically repeat a write; rerun to reconcile its recorded intent.`); }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Fineract ${method} ${path.split('?')[0]} returned HTTP ${response.status}. Inspect local setup/API diagnostics; no raw response or credentials were logged.`);
      error.statusCode = response.status; throw error;
    }
    try { return await response.json(); } catch { throw new Error('Fineract returned an invalid JSON response. Setup stopped.'); }
  };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error(`Cannot read the local seed state at ${path}. It was not overwritten.`); }
}
async function saveJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function list(api, path) {
  const result = [], size = 200;
  for (let offset = 0; offset < 10_000; offset += size) {
    const body = await api(`${path}?limit=${size}&offset=${offset}`);
    if (Array.isArray(body)) return body;
    if (!Array.isArray(body.pageItems) || !Number.isInteger(body.totalFilteredRecords)) throw new Error(`Unexpected Fineract collection at ${path}.`);
    result.push(...body.pageItems);
    if (result.length >= body.totalFilteredRecords) return result;
    if (!body.pageItems.length) break;
  }
  throw new Error(`Cannot safely scan all records at ${path}; fixture collision checks were inconclusive.`);
}
function collision(kind, reference) { throw new Error(`Fixture collision for ${kind} ${reference}. Existing operator data was not changed. Use a separate local stack or resolve the collision explicitly.`); }
function requiredMatch(condition, kind, reference) { if (!condition) collision(kind, reference); }
function uniqueMatch(items, predicate, kind, reference) {
  const matches = items.filter(predicate);
  if (matches.length > 1) collision(kind, reference);
  return matches[0];
}
function productMatches(product, definition) {
  return product.name === definition.name && product.shortName === definition.shortName && product.description === marker
    && product.currency?.code === 'USD' && product.currency?.decimalPlaces === 2
    && Number(product.nominalAnnualInterestRate) === 0 && product.accountingRule?.id === 1
    && product.interestCompoundingPeriodType?.id === 1 && product.interestPostingPeriodType?.id === 4
    && product.interestCalculationType?.id === 1 && product.interestCalculationDaysInYearType?.id === 365
    && product.allowOverdraft === false && product.withdrawalFeeForTransfers === false
    && !product.withHoldTax && !product.enforceMinRequiredBalance
    && Number(product.minRequiredOpeningBalance || 0) === 0 && !(product.charges?.length);
}
function clientMatches(client, member) {
  return client.accountNo === member.clientReference && externalId(client.externalId) === member.clientReference
    && client.firstname === member.firstname && client.lastname === member.lastname
    && client.officeId === 1 && (client.active === true || client.status?.id === 300);
}
function accountMatches(account, member, clientId, productId) {
  return account.accountNo === member.accountReference && externalId(account.externalId) === `INTERFACE-SEED-${member.accountReference}`
    && account.clientId === clientId && account.savingsProductId === productId && account.currency?.code === 'USD'
    && Number(account.nominalAnnualInterestRate) === 0 && !account.allowOverdraft && !(account.charges?.length);
}
function serverDate(template) {
  const date = template.activationDate;
  if (!Array.isArray(date) || date.length !== 3 || date.some(value => !Number.isInteger(value))) throw new Error('The Fineract client template did not provide a valid server activation date.');
  return date.map((value, index) => String(value).padStart(index ? 2 : 4, '0')).join('-');
}

export async function seedMifos({ root = resolve(import.meta.dirname, '..'), environment = process.env, api: suppliedApi,
  output = console.log } = {}) {
  const { origin } = localMifosOrigin(environment.MIFOS_URL || undefined);
  const tenant = localMifosTenant(environment.MIFOS_TENANT);
  const composeProject = localMifosProject(environment.MIFOS_COMPOSE_PROJECT);
  const transport = suppliedApi || createFineractApi({ origin, tenant, username: environment.MIFOS_USERNAME || 'mifos', password: environment.MIFOS_PASSWORD || 'password' });
  let apiWrites = 0;
  const api = (path, body) => { if (body !== undefined) apiWrites++; return transport(path, body); };
  const directory = mifosFixtureDirectory(root, environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directory, 'seed.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another fixture setup is running, or an interrupted setup left ${lockPath}. Verify no setup process is active before removing that lock.`); throw error; }
  try {
    await lock.writeFile(String(process.pid));
    const statePath = resolve(directory, 'seed-state.json'), manifestPath = resolve(directory, 'fixtures.json');
    const priorManifest = await readJson(manifestPath);
    let state = await readJson(statePath);
    const firstSetup = !state;
    for (const prior of [state, priorManifest]) if (prior && (prior.seedVersion !== seedVersion || prior.origin !== origin || prior.tenant !== tenant)) {
      throw new Error('Existing fixture state belongs to another target, tenant, or seed version. It was not overwritten. Use a separate checkout or explicitly migrate the state.');
    }
    for (const prior of [state, priorManifest]) if (prior && (prior.composeProject ?? 'interface-mifos') !== composeProject) {
      throw new Error('Existing fixture state belongs to another Compose project. It was not overwritten. Set a separate MIFOS_FIXTURE_DIR for each isolated stack.');
    }
    if (priorManifest?.officeId !== undefined && priorManifest.officeId !== 1) {
      throw new Error('Existing fixture manifest names another office. It was not overwritten; the local fixture members must belong to Head Office 1.');
    }
    if (!state && priorManifest) throw new Error('The fixture manifest exists but its ownership journal is missing. Setup will not infer ownership or reset these records.');
    const template = await api('/clients/template');
    const paymentTypes = await api('/paymenttypes');
    const paymentType = Array.isArray(paymentTypes) && paymentTypes.find(item => item.name === 'Money Transfer' && item.isSystemDefined !== true);
    if (!paymentType || !positiveId(paymentType.id)) throw new Error('The pinned local Money Transfer payment type is unavailable; no funding request was sent.');
    state ||= { schemaVersion: 1, seedVersion, origin, tenant, createdAt: new Date().toISOString(), seedDate: serverDate(template), products: {}, clients: {} };
    state.composeProject = composeProject;
    if (!state.products || !state.clients || !/^\d{4}-\d{2}-\d{2}$/.test(state.seedDate)) throw new Error('The fixture ownership journal is invalid and was not overwritten.');
    const persist = () => saveJson(statePath, state);
    const allProducts = await list(api, '/savingsproducts');
    const allClients = await list(api, '/clients');
    const allAccounts = await list(api, '/savingsaccounts');
    if (firstSetup) state.initialRecordCounts = { members: allClients.length, savingsAccounts: allAccounts.length, savingsProducts: allProducts.length };
    // Check all reference collisions before the first mutation. Existing objects
    // must belong to this setup's durable journal, not merely look similar.
    for (const definition of products) {
      const existing = uniqueMatch(allProducts, item => item.name === definition.name || item.shortName === definition.shortName, 'product', definition.name);
      if (existing) requiredMatch(state.products[definition.name] && productMatches(await api(`/savingsproducts/${existing.id}`), definition), 'product', definition.name);
      else if (state.products[definition.name]?.id) collision('missing product', definition.name);
    }
    for (const member of members) {
      const existing = uniqueMatch(allClients, item => item.accountNo === member.clientReference || externalId(item.externalId) === member.clientReference, 'member', member.clientReference);
      if (existing) requiredMatch(state.clients[member.clientReference] && clientMatches(await api(`/clients/${existing.id}`), member), 'member', member.clientReference);
      else if (state.clients[member.clientReference]?.id) collision('missing member', member.clientReference);
      const account = uniqueMatch(allAccounts, item => item.accountNo === member.accountReference || externalId(item.externalId) === `INTERFACE-SEED-${member.accountReference}`, 'account', member.accountReference);
      if (account) {
        const owned = state.clients[member.clientReference];
        requiredMatch(owned?.accountIntent && (!owned.accountId || owned.accountId === account.id)
          && accountMatches(await api(`/savingsaccounts/${account.id}?associations=transactions`), member, owned.id, state.products['Everyday Savings']?.id),
        'account', member.accountReference);
      }
      else if (state.clients[member.clientReference]?.accountId) collision('missing account', member.accountReference);
    }
    await persist();
    const productIds = {};
    for (const definition of products) {
      let product = allProducts.find(item => item.name === definition.name);
      if (!product) {
        state.products[definition.name] = { creating: true }; await persist();
        const created = await api('/savingsproducts', { ...definition, description: marker, currencyCode: 'USD', digitsAfterDecimal: 2,
          inMultiplesOf: 1, nominalAnnualInterestRate: 0, interestCompoundingPeriodType: 1, interestPostingPeriodType: 4,
          interestCalculationType: 1, interestCalculationDaysInYearType: 365, accountingRule: 1, minRequiredOpeningBalance: 0,
          withdrawalFeeForTransfers: false, allowOverdraft: false, enforceMinRequiredBalance: false, withHoldTax: false, charges: [], locale: 'en' });
        if (!positiveId(created.resourceId)) throw new Error('Fineract did not return a product resource ID.');
        product = await api(`/savingsproducts/${created.resourceId}`);
      } else product = await api(`/savingsproducts/${product.id}`);
      requiredMatch(productMatches(product, definition), 'product', definition.name);
      if (state.products[definition.name]?.id && state.products[definition.name].id !== product.id) collision('product identity', definition.name);
      state.products[definition.name] = { id: product.id }; productIds[definition.name] = product.id; await persist();
    }
    const clientFixtures = [];
    for (const member of members) {
      let client = allClients.find(item => item.accountNo === member.clientReference);
      if (!client) {
        state.clients[member.clientReference] = { creating: true }; await persist();
        const created = await api('/clients', { officeId: 1, accountNo: member.clientReference, externalId: member.clientReference,
          firstname: member.firstname, lastname: member.lastname, active: true, legalFormId: 1, ...dateFields({ activationDate: state.seedDate }) });
        if (!positiveId(created.clientId || created.resourceId)) throw new Error('Fineract did not return a client resource ID.');
        client = await api(`/clients/${created.clientId || created.resourceId}`);
      } else client = await api(`/clients/${client.id}`);
      requiredMatch(clientMatches(client, member), 'member', member.clientReference);
      const owned = state.clients[member.clientReference];
      if (owned.id && owned.id !== client.id) collision('member identity', member.clientReference);
      owned.id = client.id; await persist();
      let account = allAccounts.find(item => item.accountNo === member.accountReference);
      if (!account) {
        owned.accountIntent = true; await persist();
        await api('/savingsaccounts', { clientId: client.id, productId: productIds['Everyday Savings'],
          accountNo: member.accountReference, externalId: `INTERFACE-SEED-${member.accountReference}`, ...dateFields({ submittedOnDate: state.seedDate }) });
        // The pinned savings endpoint can wrap creation results for bulk support;
        // discover the persisted ID by its unique seed references, never resend.
        const persisted = uniqueMatch(await list(api, '/savingsaccounts'), item => item.accountNo === member.accountReference,
          'created account', member.accountReference);
        if (!persisted || !positiveId(persisted.id)) throw new Error('The newly created savings account could not be reconciled. No create request was repeated.');
        account = await api(`/savingsaccounts/${persisted.id}?associations=transactions`);
      } else account = await api(`/savingsaccounts/${account.id}?associations=transactions`);
      requiredMatch(accountMatches(account, member, client.id, productIds['Everyday Savings']), 'account', member.accountReference);
      if (owned.accountId && owned.accountId !== account.id) collision('account identity', member.accountReference);
      owned.accountId = account.id; await persist();
      if (owned.funded) {
        requiredMatch(account.status?.active === true || account.status?.id === 300, 'account status', member.accountReference);
        // Preserve all operator deposits/withdrawals after initial seeding.
      } else {
        if (account.status?.id === 100) {
          await api(`/savingsaccounts/${account.id}?command=approve`, dateFields({ approvedOnDate: state.seedDate }));
          account = await api(`/savingsaccounts/${account.id}?associations=transactions`);
        }
        if (account.status?.id === 200) {
          await api(`/savingsaccounts/${account.id}?command=activate`, dateFields({ activatedOnDate: state.seedDate }));
          account = await api(`/savingsaccounts/${account.id}?associations=transactions`);
        }
        requiredMatch(account.status?.active === true || account.status?.id === 300, 'account status', member.accountReference);
        if (owned.depositIntent) {
          // A lost response is reconciled through persisted transactions. Never
          // send the funding request twice, even if the read is inconclusive.
          const transactions = (account.transactions || []).filter(item => !item.reversed);
          requiredMatch(transactions.length === 1 && transactions[0].transactionType?.deposit === true
            && Number(transactions[0].amount) === Number(member.initialBalance)
            && Number(account.summary?.accountBalance) === Number(member.initialBalance), 'uncertain initial funding', member.accountReference);
          owned.funded = true; owned.transactionId = transactions[0].id; await persist();
        } else {
          requiredMatch(!(account.transactions?.length) && Number(account.summary?.accountBalance || 0) === 0, 'unfunded account', member.accountReference);
          owned.depositIntent = true; await persist();
          let deposit;
          try {
            deposit = await api(`/savingsaccounts/${account.id}/transactions?command=deposit`, { ...dateFields({ transactionDate: state.seedDate }),
              transactionAmount: member.initialBalance, paymentTypeId: paymentType.id, note: marker });
          } catch (error) {
            // A schema rejection is definite nonacceptance. Network errors and
            // server failures retain intent for read-only reconciliation.
            if ([400, 422].includes(error.statusCode)) { owned.depositIntent = false; await persist(); }
            throw error;
          }
          account = await api(`/savingsaccounts/${account.id}?associations=transactions`);
          requiredMatch(Number(account.summary?.accountBalance) === Number(member.initialBalance), 'initial funding', member.accountReference);
          owned.funded = true; owned.transactionId = deposit.resourceId; await persist();
        }
      }
      clientFixtures.push({ id: client.id, clientReference: member.clientReference, name: `${member.firstname} ${member.lastname}`,
        accountId: account.id, accountReference: member.accountReference, currency: 'USD', initialBalance: member.initialBalance });
      output(`Verified synthetic member ${member.clientReference}, account ${member.accountReference}; existing funded accounts were preserved.`);
    }
    const manifest = { schemaVersion: 1, target: 'mifos-x', seedVersion, origin, tenant, composeProject, createdAt: state.createdAt,
      ...(state.initialRecordCounts ? { initialRecordCounts: state.initialRecordCounts } : {}),
      seedDate: state.seedDate, officeId: 1, productIds, clients: clientFixtures };
    await saveJson(manifestPath, manifest);
    output(`Local US fixtures verified. References saved in ${manifestPath}.`);
    output(`Fixture API writes: ${apiWrites}.`);
    return manifest;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function main() {
  const root = resolve(import.meta.dirname, '..'); loadLocalEnv(localEnvironmentPath(root));
  await seedMifos({ root });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Mifos fixture setup: ${error.message}`); process.exitCode = 1; });
}
