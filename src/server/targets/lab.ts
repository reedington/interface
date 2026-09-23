import type { RunInputs } from '../../shared/contracts.js';
import { authoredCapabilities } from '../capabilities.js';
import { field } from '../surface.js';
import type { TargetProfile } from './types.js';

export function createLabProfile(baseUrl: string): TargetProfile {
  return {
    id: 'local-banking-lab', name: 'Local Credit Union Lab', baseUrl, entryPath:'/', version: '1.1.0',
    async bootstrap(page, scenario, assertActive) { assertActive(); await page.goto(`${baseUrl}/?scenario=${scenario}`); assertActive(); },
    capabilities: authoredCapabilities,
    async atCheckpoint(page, kind) { return await page.locator(kind === 'account' ? '[data-field="current-balance"]' : `[data-page="${kind}"]`).count() === 1; },
    async checkpoint(page, kind, inputs, resolved) {
      const client = await field(page, 'client-reference');
      if (client !== inputs.clientReference) throw new Error('The visible member does not match the requested member.');
      if (kind === 'client') return { clientReference: client };
      if (kind === 'account') {
        const account = await field(page, 'account-reference');
        if (account !== (inputs.accountReference || resolved?.accountReference)) throw new Error('The visible account does not match the requested or UI-resolved account.');
        const balance = await field(page, 'current-balance'), currency = await field(page, 'currency');
        if (!/^-?\d+\.\d{2}$/.test(balance) || currency !== 'USD') throw new Error('The US savings capability requires a valid USD ledger balance.');
        return { clientReference: client, accountReference: account, balance, currency, status: await field(page, 'account-status') };
      }
      if (await page.locator(`[data-page="${kind}"]`).count() !== 1) throw new Error(`The target is not on its ${kind} page.`);
      const product = await field(page, 'product'), externalReference = await field(page, 'external-reference');
      if (product !== inputs.product || externalReference !== inputs.externalReference) throw new Error('The visible application differs from the requested inputs.');
      if (kind === 'preview') return { clientReference: client, product, externalReference };
      const applicationReference = await field(page, 'application-reference'), status = await field(page, 'application-status');
      if (!applicationReference || status !== 'Pending Approval') throw new Error('The target did not confirm a pending application.');
      return { clientReference: client, product, externalReference, applicationReference, status };
    },
    async resolveAccount(page) {
      const names = await page.getByRole('link', { name: /^View account / }).allTextContents();
      if (names.length !== 1) throw new Error('The member does not have exactly one visible savings account. Specify an account reference in your goal.');
      const account = names[0].trim().match(/^View account ([A-Za-z0-9-]{3,32})$/)?.[1];
      if (!account) throw new Error('The savings account reference could not be read unambiguously.');
      return account;
    },
    async detectState(page) {
      const states = await page.locator('[data-state]').evaluateAll(els => els.map(el => el.getAttribute('data-state')));
      for (const kind of ['not_found', 'validation', 'permission']) if (states.includes(kind)) return { kind: 'business', code: kind.toUpperCase(), message: kind };
      if (states.includes('outcome-unknown')) return { kind: 'unknown', code: 'OUTCOME_UNKNOWN', message: 'The target did not confirm the submission. Reconcile the persisted application before another business action.' };
      if (states.includes('session_expired')) return { kind: 'intervention', code: 'SESSION_EXPIRED', message: 'Take control and restore the synthetic session, then resume.' };
      if (states.includes('unexpected_dialog')) return { kind: 'intervention', code: 'UNEXPECTED_DIALOG', message: 'Take control and dismiss the unexpected notice, then resume.' };
      return undefined;
    },
    async isCommitTarget(_page, locator) { return await locator.evaluate(el => el.textContent?.trim() === 'Submit application'); },
    networkPolicy(request) {
      const url = new URL(request.url());
      if (url.origin !== baseUrl) return 'deny';
      if (request.method() === 'GET') return 'read';
      if (request.method() === 'POST' && url.pathname === '/applications') return 'commit';
      if (request.method() === 'POST' && (/^\/clients\/\d+\/applications\/review$/.test(url.pathname) || ['/restore-session', '/dismiss-notice'].includes(url.pathname))) return 'read';
      return 'deny';
    },
    validateCommit(request, inputs, summary) {
      try {
        const url = new URL(request.url());
        if (url.origin !== baseUrl || url.pathname !== '/applications' || url.search || request.method() !== 'POST') return false;
        if (request.headers()['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return false;
        const body = new URLSearchParams(request.postData() || '');
        const allowed = ['clientReference', 'product', 'externalReference', 'csrf', 'scenario'];
        if ([...body.keys()].length !== allowed.length || allowed.some(key => body.getAll(key).length !== 1)) return false;
        return (['clientReference', 'product', 'externalReference'] as const).every(key => body.get(key) === inputs[key] && summary[key] === inputs[key]);
      } catch { return false; }
    },
    parameterize(target, inputs, resolved) {
      if (target.value === `Open member ${inputs.clientReference}`) return { ...target, value: 'Open member {{clientReference}}' };
      if (target.value === `View account ${inputs.accountReference || resolved?.accountReference}`) return { ...target, value: 'View account {{accountReference}}' };
      return target;
    },
    async reconcile(page, inputs: RunInputs) {
      await page.goto(`${baseUrl}/applications?externalReference=${encodeURIComponent(inputs.externalReference)}`);
      const rows = page.locator('[data-application-row]');
      if (await rows.count() !== 1) return undefined;
      const data = await rows.evaluate(el => Object.fromEntries(Array.from(el.querySelectorAll('[data-field]')).map(field => [field.getAttribute('data-field'), field.textContent?.trim()])));
      if (data['client-reference'] !== inputs.clientReference || data['product'] !== inputs.product || data['external-reference'] !== inputs.externalReference) throw new Error('The persisted application does not match the requested inputs.');
      if (!data['application-reference'] || data['application-status'] !== 'Pending Approval') throw new Error('The persisted application is not a verified pending application.');
      return { clientReference: data['client-reference'], product: data['product'], externalReference: data['external-reference'], applicationReference: data['application-reference'], status: data['application-status'] };
    },
  };
}
