import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Deliberately synthetic fixtures; these are not bank/customer records. */
export const targetSeed = [
  { clientReference: '10001', name: 'Alex Morgan', accountReference: 'SAV-1001', currentBalance: '12540.75', currency: 'USD', accountStatus: 'Active' },
  { clientReference: '10002', name: 'Taylor Reed', accountReference: 'SAV-1002', currentBalance: '840.00', currency: 'USD', accountStatus: 'Active' },
] as const;

const scenarios = ['normal', 'not_found', 'validation', 'permission', 'session_expired', 'slow', 'unexpected_dialog', 'commit_unknown'] as const;
type Scenario = typeof scenarios[number];
type Client = typeof targetSeed[number];
interface Application {
  applicationReference: string;
  applicationStatus: 'Pending Approval';
  clientReference: string;
  product: string;
  externalReference: string;
  createdAt: string;
}
interface Session {
  scenario: Scenario;
  csrf: string;
  restored: boolean;
  dismissed: boolean;
  touchedAt: number;
}
interface Preview { clientReference: string; product: string; externalReference: string }
const products = ['Everyday Savings', 'Growth Savings'];
const usdAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const field = (name: string, value: unknown) => `<span data-field="${name}">${escapeHtml(value)}</span>`;
const detail = (label: string, name: string, value: unknown) => `<div class="detail"><dt>${escapeHtml(label)}</dt><dd>${field(name, value)}</dd></div>`;

const styles = `
:root{color-scheme:light;font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172a29;background:#f3f6f3}
*{box-sizing:border-box}body{margin:0}a{color:#176551;text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}
header{background:#102f2b;color:#f5fbf7;padding:22px 40px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:4px solid #bde5b4}
.brand{display:flex;align-items:center;gap:13px;color:inherit;font-weight:700;font-size:20px;letter-spacing:-.5px}.mark{width:35px;height:35px;border:2px solid #c0e3b9;display:grid;place-items:center;border-radius:10px;color:#c0e3b9;font-size:18px}
header nav{display:flex;gap:25px}header nav a{color:#e5efe8;font-size:14px}.synthetic{background:#e5eddf;color:#345936;text-transform:uppercase;font-size:11px;letter-spacing:1.3px;font-weight:750;padding:5px 9px;border-radius:5px;display:inline-block}
main{max-width:1060px;margin:0 auto;padding:38px 36px 70px}.eyebrow{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:1.7px;color:#697f75;margin-bottom:12px}h1{font-size:32px;line-height:1.15;letter-spacing:-1px;margin:0 0 12px}h2{font-size:20px;margin:0 0 12px;letter-spacing:-.4px}p{margin:0 0 18px}.muted{color:#67786e}.intro{max-width:650px;margin-bottom:28px}.card{background:#fff;border:1px solid #d9e2d9;border-radius:14px;padding:28px;box-shadow:0 3px 12px #223d2905;margin-bottom:20px}.card.narrow{max-width:720px}.row{display:flex;gap:16px;align-items:end;flex-wrap:wrap}.grow{flex:1;min-width:200px}label{font-weight:650;font-size:14px;display:block;margin-bottom:7px}input,select{display:block;width:100%;border:1px solid #bac9bf;border-radius:7px;padding:11px 12px;background:white;color:#19312a;min-height:46px}input:focus,select:focus,button:focus-visible,a:focus-visible{outline:3px solid #87b39e;outline-offset:3px}.form-field{margin-bottom:22px}button,.button{background:#1c654f;color:white;border:1px solid #1c654f;border-radius:7px;padding:11px 18px;font-weight:650;cursor:pointer;display:inline-block;min-height:46px;text-align:center}.button:hover{color:white;text-decoration:none;background:#164e3e}button:hover{background:#164e3e}.secondary{background:#fff;color:#245a47;border-color:#bccfc2}.secondary:hover{background:#f0f5ef;color:#245a47}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:0}.detail dt{font-size:12px;color:#6a7e73;margin-bottom:5px}.detail dd{margin:0;font-size:18px;font-weight:600;overflow-wrap:anywhere}.balance{font-size:45px;font-weight:650;letter-spacing:-1.7px;line-height:1.2;margin:10px 0}.balance .currency{font-size:18px;letter-spacing:0;color:#587668;font-weight:500;margin-right:9px}.badge{display:inline-block;background:#e9f3e9;border:1px solid #cce2cd;color:#326440;border-radius:20px;padding:4px 10px;font-size:12px;font-weight:650}.account{padding:21px 0;border-top:1px solid #e3e9e0;margin-top:23px;display:flex;align-items:center;justify-content:space-between;gap:15px}.hint{font-size:13px;color:#708078;margin-top:10px;margin-bottom:0}.notice{border-left:4px solid #b58a39;background:#fff9e9;padding:16px 18px;border-radius:5px;margin-bottom:23px;color:#685126}.success{border-left-color:#348358;background:#edf6ee;color:#315741}.error{border-left-color:#ba6254;background:#fff2ed;color:#813f31}.breadcrumb{font-size:13px;margin-bottom:28px}.steps{display:flex;gap:8px;margin:24px 0;color:#64786c;font-size:12px}.steps span{padding:6px 12px;background:#e8eee6;border-radius:20px}.steps .current{background:#173f33;color:white}.result-head{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:18px}.reference{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;color:#5b7164}footer{border-top:1px solid #dce4dc;padding:20px 36px;color:#738378;font-size:12px;text-align:center}.overlay{position:fixed;inset:0;background:#112d24aa;display:grid;place-items:center;padding:24px;z-index:20}.dialog{background:white;border-radius:15px;max-width:470px;padding:32px;box-shadow:0 20px 90px #0004}.empty{padding:15px 0}.reference-pill{display:inline-block;background:#eef3ec;padding:4px 9px;border-radius:5px}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:15px 10px;border-bottom:1px solid #e3e9e0;font-size:14px}th{font-size:12px;color:#607264;font-weight:600}.table-wrap{overflow-x:auto}
@media(max-width:650px){header{padding:20px}header nav{gap:12px}.brand{font-size:17px}.mark{display:none}main{padding:28px 20px}.card{padding:22px}.detail-grid{grid-template-columns:1fr}h1{font-size:28px}.balance{font-size:36px}.account{align-items:start;flex-direction:column}.synthetic{font-size:10px}}
`;

function page(title: string, body: string, options: { page?: string; state?: string; dialog?: string } = {}) {
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Local Credit Union Lab</title><style>${styles}</style></head><body${options.page ? ` data-page="${options.page}"` : ''}${options.state ? ` data-state="${options.state}"` : ''}><header><a class="brand" href="/"><span class="mark">L</span>Local Credit Union Lab</a><nav aria-label="Main navigation"><a href="/">Members</a><a href="/applications">Applications</a></nav><span class="synthetic">Synthetic data only</span></header><main${options.dialog ? ' inert' : ''}>${body}</main>${options.dialog ?? ''}<footer>Local Credit Union Lab · Isolated testing environment · No real members or money</footer></body></html>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error('FORM_TOO_LARGE');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function safeReturn(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  const parsed = new URL(value, 'http://localhost');
  return parsed.origin === 'http://localhost' ? parsed.pathname + parsed.search : '/';
}

export async function startTarget(port: number, dataDir: string): Promise<{ close: () => Promise<void>; url: string }> {
  const targetDir = join(dataDir, 'banking-lab');
  const dataPath = join(targetDir, 'applications.json');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  let applications: Application[] = [];
  try {
    const saved: unknown = JSON.parse(await readFile(dataPath, 'utf8'));
    if (!Array.isArray(saved) || !saved.every((entry) => entry && typeof entry === 'object' && typeof entry.applicationReference === 'string' && entry.applicationStatus === 'Pending Approval' && typeof entry.clientReference === 'string' && typeof entry.product === 'string' && typeof entry.externalReference === 'string' && typeof entry.createdAt === 'string')) {
      throw new Error('Invalid Local Credit Union Lab data file; refusing to overwrite it.');
    }
    applications = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let writes: Promise<void> = Promise.resolve();
  const sessions = new Map<string, Session>();
  let baseUrl = '';

  function hidden(session: Session) {
    return `<input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="scenario" value="${session.scenario}">`;
  }
  function searchForm(reference = '') {
    return `<form action="/clients" method="get"><div class="row"><div class="grow"><label for="reference">Member reference</label><input id="reference" name="reference" value="${escapeHtml(reference)}" placeholder="e.g. 10001" autocomplete="off" required maxlength="12" pattern="[0-9]{4,12}"></div><button type="submit">Search members</button></div></form>`;
  }
  function applicationForm(client: Client, session: Session, values: Partial<Preview> = {}, message?: string) {
    return `<div class="breadcrumb"><a href="/clients/${client.clientReference}">← Back to member ${client.clientReference}</a></div><div class="eyebrow">Savings applications</div><h1>New savings application</h1><p class="intro muted">Prepare an application for ${escapeHtml(client.name)}. Review all details before submitting.</p><div class="steps"><span class="current">1 · Details</span><span>2 · Review</span><span>3 · Submitted</span></div><section class="card narrow">${message ? `<div class="notice error" role="alert">${escapeHtml(message)}</div>` : ''}<p class="reference">Member reference: ${field('client-reference', client.clientReference)}</p><form action="/clients/${client.clientReference}/applications/review" method="post">${hidden(session)}<div class="form-field"><label for="product">Product</label><select id="product" name="product" required>${products.map((product) => `<option value="${product}"${values.product === product ? ' selected' : ''}>${product}</option>`).join('')}</select></div><div class="form-field"><label for="externalReference">External reference</label><input id="externalReference" name="externalReference" value="${escapeHtml(values.externalReference ?? '')}" placeholder="e.g. LOCAL-001" autocomplete="off" maxlength="40" pattern="[A-Za-z0-9-]{1,40}" required><p class="hint">A unique reference to help reconcile this application.</p></div><button type="submit">Review application</button></form></section>`;
  }
  function applicationDetails(values: Preview | Application) {
    return `<dl class="detail-grid">${'applicationReference' in values ? detail('Application reference', 'application-reference', values.applicationReference) + detail('Status', 'application-status', values.applicationStatus) : ''}${detail('Member reference', 'client-reference', values.clientReference)}${detail('Product', 'product', values.product)}${detail('External reference', 'external-reference', values.externalReference)}</dl>`;
  }
  function validation(values: Preview, session: Session): string | undefined {
    if (!targetSeed.some((client) => client.clientReference === values.clientReference)) return 'The member could not be found.';
    if (!products.includes(values.product)) return 'Select an available savings product.';
    if (!/^[A-Za-z0-9-]{1,40}$/.test(values.externalReference)) return 'External reference must contain 1–40 letters, numbers, or hyphens.';
    if (session.scenario === 'validation' && !values.externalReference.startsWith('LAB-')) return 'This test product requires an external reference beginning with LAB-. Correct the reference and review again.';
    return undefined;
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, html: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'same-origin' });
      res.end(html);
    };
    const redirect = (location: string) => { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }); res.end(); };
    try {
      if (!req.url || !['GET', 'POST'].includes(req.method ?? '')) {
        send(405, page('Method not allowed', '<h1>Method not allowed</h1>'));
        return;
      }
      const url = new URL(req.url, baseUrl || 'http://127.0.0.1');
      // Local-only service: reject browser requests addressed through another host.
      const host = req.headers.host?.split(':')[0];
      if (host !== 'localhost' && host !== '127.0.0.1') { send(403, page('Access denied', '<h1>Local access only</h1>')); return; }
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { send(403, page('Access denied', '<h1>Cross-origin request denied</h1>')); return; }
      const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('lab_session='))?.slice('lab_session='.length);
      let session = cookie ? sessions.get(cookie) : undefined;
      if (session && session.touchedAt < Date.now() - 24 * 60 * 60 * 1000) session = undefined;
      if (!session) {
        const sessionId = randomBytes(24).toString('hex');
        session = { scenario: 'normal', csrf: randomBytes(24).toString('hex'), restored: false, dismissed: false, touchedAt: Date.now() };
        sessions.set(sessionId, session);
        res.setHeader('Set-Cookie', `lab_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
        if (sessions.size > 1000) for (const [id, entry] of sessions) if (entry.touchedAt < Date.now() - 24 * 60 * 60 * 1000) sessions.delete(id);
      }
      session.touchedAt = Date.now();
      const requestedScenario = url.searchParams.get('scenario');
      if (requestedScenario && scenarios.includes(requestedScenario as Scenario) && session.scenario !== requestedScenario) {
        session.scenario = requestedScenario as Scenario;
        session.restored = false;
        session.dismissed = false;
      }
      let form = new URLSearchParams();
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { send(415, page('Unsupported form', '<h1>Unsupported form format</h1>')); return; }
        form = await readForm(req);
        const token = Buffer.from(form.get('csrf') ?? '');
        const expected = Buffer.from(session.csrf);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) { send(403, page('Form expired', '<h1>This form has expired</h1><p>Return to the member and prepare the application again.</p><a class="button" href="/">Find a member</a>', { state: 'session_expired' })); return; }
      }
      const next = safeReturn(url.pathname + url.search);
      if (url.pathname === '/restore-session' && req.method === 'POST') { session.restored = true; redirect(safeReturn(form.get('next'))); return; }
      if (url.pathname === '/dismiss-notice' && req.method === 'POST') { session.dismissed = true; redirect(safeReturn(form.get('next'))); return; }
      if (session.scenario === 'session_expired' && !session.restored) {
        send(200, page('Session expired', `<div class="eyebrow">Human assistance required</div><h1>Your session has expired</h1><p class="intro muted">Restore this synthetic browser session to continue at the same location.</p><section class="card narrow"><form action="/restore-session" method="post">${hidden(session)}<input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Restore session</button></form><p class="hint">Local test session only. No credit union credentials are required.</p></section>`, { state: 'session_expired' }));
        return;
      }
      if (session.scenario === 'unexpected_dialog' && !session.dismissed) {
        const dialog = `<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="notice-title"><div class="eyebrow">Service notice</div><h2 id="notice-title">A quick notice before you continue</h2><p class="muted">This synthetic notice interrupts the workflow. Dismiss it to return to the current page.</p><form action="/dismiss-notice" method="post">${hidden(session)}<input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Dismiss notice</button></form></section></div>`;
        send(200, page('Service notice', '<div class="eyebrow">Member services</div><h1>Find a member</h1><section class="card narrow">' + searchForm() + '</section>', { state: 'unexpected_dialog', dialog }));
        return;
      }
      if (session.scenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 1000));
      if (url.pathname === '/' && req.method === 'GET') {
        send(200, page('Members', `<div class="eyebrow">Member services</div><h1>A clear view of every account.</h1><p class="intro muted">Find a synthetic member, review a savings balance, or prepare a new savings application.</p><section class="card narrow"><h2>Find a member</h2>${searchForm()}<p class="hint">Test members: <span class="reference-pill">10001</span> and <span class="reference-pill">10002</span></p></section><div class="notice">Every record in this environment is fictional. Submitted applications persist locally for verification.</div>`, { page: 'search' }));
        return;
      }
      if (url.pathname === '/clients' && req.method === 'GET') {
        const reference = url.searchParams.get('reference') ?? '';
        const client = session.scenario !== 'not_found' ? targetSeed.find((item) => item.clientReference === reference) : undefined;
        const result = client ? `<section class="card"><div class="result-head"><div><h2>${escapeHtml(client.name)}</h2><p class="reference">Member ${escapeHtml(client.clientReference)} · Synthetic record</p></div><span class="badge">Active member</span></div><a class="button" href="/clients/${client.clientReference}">Open member ${client.clientReference}</a></section>` : `<section class="card" data-state="not_found"><h2>No member found</h2><p class="muted">No member matches reference ${escapeHtml(reference)}. Check the reference before continuing.</p></section>`;
        send(200, page('Search results', `<div class="eyebrow">Member services</div><h1>Search results</h1><section class="card narrow">${searchForm(reference)}</section>${result}`, { page: 'results', ...(!client ? { state: 'not_found' } : {}) }));
        return;
      }
      const clientMatch = url.pathname.match(/^\/clients\/(\d{4,12})(?:\/applications\/(new|review))?$/);
      const accountMatch = url.pathname.match(/^\/accounts\/([A-Za-z0-9-]{3,32})$/);
      if (session.scenario === 'permission' && (clientMatch || accountMatch || (url.pathname === '/applications' && req.method === 'POST'))) {
        send(403, page('Permission required', '<div class="eyebrow">Access restricted</div><h1>Permission required</h1><section class="card narrow"><p>Your synthetic operator role cannot access this record or submit applications.</p><p class="muted">An authorized operator must resolve access in the target application.</p><a class="button secondary" href="/">Return to member search</a></section>', { state: 'permission' }));
        return;
      }
      if (clientMatch) {
        const client = targetSeed.find((item) => item.clientReference === clientMatch[1]);
        if (!client || session.scenario === 'not_found') { send(404, page('Member not found', '<h1>Member not found</h1><a href="/">Find a member</a>', { state: 'not_found' })); return; }
        if (!clientMatch[2] && req.method === 'GET') {
          send(200, page(client.name, `<div class="breadcrumb"><a href="/">← Member search</a></div><div class="eyebrow">Member profile</div><h1>${escapeHtml(client.name)}</h1><p class="intro muted">Synthetic member record · Personal banking</p><section class="card"><dl class="detail-grid">${detail('Member reference', 'client-reference', client.clientReference)}${detail('Member status', 'client-status', 'Active')}</dl><div class="account"><div><h2>Everyday Savings</h2><p class="reference">${client.accountReference} · ${client.currency}</p></div><a class="button secondary" href="/accounts/${client.accountReference}">View account ${client.accountReference}</a></div></section><a class="button" href="/clients/${client.clientReference}/applications/new">New savings application</a>`, { page: 'client' }));
          return;
        }
        if (clientMatch[2] === 'new' && req.method === 'GET') { send(200, page('New savings application', applicationForm(client, session), { page: 'application-form' })); return; }
        if (clientMatch[2] === 'review' && req.method === 'POST') {
          const values: Preview = { clientReference: client.clientReference, product: form.get('product') ?? '', externalReference: form.get('externalReference') ?? '' };
          const problem = validation(values, session);
          if (problem) { send(422, page('Check application details', applicationForm(client, session, values, problem), { page: 'application-form', state: 'validation' })); return; }
          send(200, page('Review application', `<div class="eyebrow">Savings applications</div><h1>Review application</h1><p class="intro muted">Check the details below. Submitting creates a saved application awaiting approval.</p><div class="steps"><span>1 · Details</span><span class="current">2 · Review</span><span>3 · Submitted</span></div><section class="card narrow">${applicationDetails(values)}<div class="actions"><form action="/applications" method="post">${hidden(session)}<input type="hidden" name="clientReference" value="${escapeHtml(values.clientReference)}"><input type="hidden" name="product" value="${escapeHtml(values.product)}"><input type="hidden" name="externalReference" value="${escapeHtml(values.externalReference)}"><button type="submit">Submit application</button></form><a href="/clients/${client.clientReference}/applications/new">Edit details</a></div><p class="hint">This preview has not been saved as an application.</p></section>`, { page: 'preview' }));
          return;
        }
      }
      if (accountMatch && req.method === 'GET') {
        const client = targetSeed.find((item) => item.accountReference === accountMatch[1]);
        if (!client || session.scenario === 'not_found') { send(404, page('Account not found', '<h1>Account not found</h1><a href="/">Find a member</a>', { state: 'not_found' })); return; }
        send(200, page('Savings account', `<div class="breadcrumb"><a href="/clients/${client.clientReference}">← Back to member ${client.clientReference}</a></div><div class="eyebrow">Savings account</div><h1>Everyday Savings</h1><p class="intro muted">${escapeHtml(client.name)} · Synthetic account</p><section class="card"><div class="result-head"><span class="reference">${field('account-reference', client.accountReference)}</span><span class="badge">${field('account-status', client.accountStatus)}</span></div><div class="eyebrow">Current balance</div><div class="balance">${escapeHtml(usdAmount.format(Number(client.currentBalance)))}</div><p class="hint">Ledger amount: ${field('current-balance', client.currentBalance)} ${field('currency', client.currency)}. This is not an available-to-withdraw balance.</p><div class="account"><dl class="detail-grid">${detail('Member reference', 'client-reference', client.clientReference)}${detail('Account type', 'account-type', 'Savings')}</dl></div></section>`, { page: 'account' }));
        return;
      }
      if (url.pathname === '/applications' && req.method === 'POST') {
        const values: Preview = { clientReference: form.get('clientReference') ?? '', product: form.get('product') ?? '', externalReference: form.get('externalReference') ?? '' };
        const problem = validation(values, session);
        if (problem) { send(422, page('Check application details', `<h1>Application could not be submitted</h1><div class="notice error">${escapeHtml(problem)}</div><a href="/">Return to members</a>`, { state: 'validation' })); return; }
        // Serialize uniqueness checking and the durable write, including concurrent POSTs.
        const operation = writes.then(async () => {
          const existing = applications.find((entry) => entry.externalReference === values.externalReference);
          if (existing) return { duplicate: true as const, application: existing };
          const application: Application = { ...values, applicationReference: `APP-${randomUUID().slice(0, 8).toUpperCase()}`, applicationStatus: 'Pending Approval', createdAt: new Date().toISOString() };
          const updated = [...applications, application];
          const temporaryPath = join(targetDir, `applications.${randomUUID()}.tmp`);
          try { await writeFile(temporaryPath, JSON.stringify(updated, null, 2), { mode: 0o600 }); await rename(temporaryPath, dataPath); }
          catch (error) { await unlink(temporaryPath).catch(() => undefined); throw error; }
          applications = updated;
          return { duplicate: false as const, application };
        });
        writes = operation.then(() => undefined, () => undefined);
        const result = await operation;
        const reconciliationUrl = `/applications?externalReference=${encodeURIComponent(values.externalReference)}`;
        if (result.duplicate) { send(409, page('Reference already exists', `<h1>This external reference already exists</h1><section class="card narrow"><p>A saved application uses this reference. No second application was created.</p><a class="button" href="${escapeHtml(reconciliationUrl)}">Find existing application</a></section>`, { state: 'validation' })); return; }
        if (session.scenario === 'commit_unknown') { send(503, page('Confirmation unavailable', `<div class="eyebrow">Confirmation unavailable</div><h1>We could not confirm the outcome.</h1><section class="card narrow"><p>The submission response is unavailable. Do not submit again until you have checked existing applications.</p><p class="reference">External reference: ${field('external-reference', values.externalReference)}</p><a class="button" href="${escapeHtml(reconciliationUrl)}">Check existing applications</a></section>`, { state: 'outcome-unknown' })); return; }
        send(200, page('Application submitted', `<div class="eyebrow">Savings applications</div><h1>Application submitted</h1><div class="notice success">The synthetic application is saved and awaiting approval.</div><section class="card narrow">${applicationDetails(result.application)}<div class="actions"><a class="button secondary" href="${escapeHtml(reconciliationUrl)}">View saved application</a><a href="/clients/${values.clientReference}">Back to member</a></div></section>`, { page: 'submitted' }));
        return;
      }
      if (url.pathname === '/applications' && req.method === 'GET') {
        const reference = url.searchParams.get('externalReference') ?? '';
        const matches = reference ? applications.filter((entry) => entry.externalReference === reference) : applications;
        const columns = [['applicationReference', 'application-reference'], ['clientReference', 'client-reference'], ['product', 'product'], ['externalReference', 'external-reference'], ['applicationStatus', 'application-status']] as const;
        const rows = matches.map((entry) => `<tr data-application-row>${columns.map(([key, name]) => `<td>${field(name, entry[key])}</td>`).join('')}</tr>`).join('');
        send(200, page('Saved applications', `<div class="eyebrow">Application register</div><h1>Saved applications</h1><p class="intro muted">Verify the persisted record after a submission. Records survive target restarts.</p><section class="card"><form method="get" action="/applications"><div class="row"><div class="grow"><label for="externalReference">External reference</label><input id="externalReference" name="externalReference" value="${escapeHtml(reference)}" placeholder="e.g. LOCAL-001" maxlength="40"></div><button type="submit">Find applications</button></div></form></section><section class="card"><div class="result-head"><h2>${matches.length} ${matches.length === 1 ? 'application' : 'applications'}</h2></div>${matches.length ? `<div class="table-wrap"><table><thead><tr><th>Application</th><th>Member</th><th>Product</th><th>External reference</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty" data-state="not_found"><p class="muted">No saved applications match this reference.</p></div>'}</section>`, { page: 'applications' }));
        return;
      }
      send(404, page('Page not found', '<h1>Page not found</h1><a class="button" href="/">Return to members</a>', { state: 'not_found' }));
    } catch (error) {
      if (!res.headersSent) send((error as Error).message === 'FORM_TOO_LARGE' ? 413 : 500, page('Unable to complete request', '<h1>Unable to complete this request</h1><p>No confirmation is available. Check saved applications before retrying a submission.</p><a href="/applications">Saved applications</a>'));
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to determine Local Credit Union Lab port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    close: async () => { await writes; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
