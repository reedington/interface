import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Activity, ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check,
  CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Code2,
  Download, ExternalLink, FileCheck2, Fingerprint, FlaskConical, Hand, History,
  KeyRound, Keyboard, Layers3, LayoutDashboard, Loader2, Monitor, MousePointer2,
  Pause, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square,
  Terminal, TriangleAlert, WifiOff, X, XCircle,
} from 'lucide-react';
import { type AppState, type CapabilityRecord, type CreateRun, type GoalResolution, type HumanInput,
  type Run, type RunInputs, type Scenario, type TaskKind } from '../shared/contracts';

type View = 'workspace' | 'capabilities' | 'history' | 'settings';
type Provider = 'openai' | 'anthropic' | 'google';
type Frame = { dataUrl: string; revision: number; at: string; width: number; height: number };
const TASKS: Record<TaskKind, { name: string; short: string; detail: string }> = {
  balance: { name: 'Read savings balance', short: 'Balance lookup', detail: 'Find a member, open the account, and verify the balance.' },
  prepare: { name: 'Prepare savings application', short: 'Prepare application', detail: 'Fill an application and stop at the verified preview.' },
  submit: { name: 'Submit with approval', short: 'Approved submission', detail: 'Review the exact application, approve it, then submit once.' },
  member: { name: 'Create a new member', short: 'New member', detail: 'Review the exact member details, approve them, then create the member once.' },
};
const SCENARIOS: Record<Scenario, { label: string; detail: string }> = {
  normal: { label: 'Normal operation', detail: 'Run against the standard application state.' },
  not_found: { label: 'Member not found', detail: 'Exercise a legitimate business outcome.' },
  validation: { label: 'Validation error', detail: 'The application rejects a field value.' },
  permission: { label: 'Permission denied', detail: 'The application blocks access to the operation.' },
  session_expired: { label: 'Session expired', detail: 'The session requires an operator to restore access.' },
  slow: { label: 'Slow response', detail: 'Exercise bounded waits against a delayed application.' },
  unexpected_dialog: { label: 'Unexpected dialog', detail: 'An interruption requires the live session to be inspected.' },
  commit_unknown: { label: 'Unconfirmed submission', detail: 'Exercise reconciliation after an uncertain commit.' },
};
const PROVIDERS: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
const MODEL_DEFAULTS: Record<Provider, string> = { openai: 'gpt-4.1', anthropic: 'claude-sonnet-4-6', google: 'gemini-2.5-flash' };
const GOAL_EXAMPLES = [
  'Look up member 10001 and read their current savings balance',
  'Prepare a new savings sub-account for member 10002 and stop at review',
  'Submit a savings application for member 10001 after my approval',
];
function goalForTask(task: TaskKind, inputs: RunInputs) {
  if (task === 'member') return inputs.firstName && inputs.lastName && inputs.clientReference
    ? `Create a new member with first name ${JSON.stringify(inputs.firstName.trim())} and last name ${JSON.stringify(inputs.lastName.trim())}, member reference ${inputs.clientReference}, after my approval`
    : 'Create a new member after my approval';
  if (task === 'balance') return `Look up member ${inputs.clientReference} and read their current savings balance${inputs.accountReference ? ` for account ${inputs.accountReference}` : ''}`;
  if (task === 'prepare') return `Prepare a new ${inputs.product} sub-account for member ${inputs.clientReference} and stop at review`;
  return `Submit a ${inputs.product} application for member ${inputs.clientReference} after my approval`;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function time(value?: string) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
function elapsed(run: Run, now: number) {
  const seconds = Math.max(0, Math.round(((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function humanize(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/client/gi, 'member').toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}
function status(run: Run): { label: string; tone: string } {
  if (run.effect === 'unknown') return { label: 'Outcome unconfirmed', tone: 'warning' };
  if (run.status === 'completed') {
    if (run.result === 'succeeded') return { label: 'Verified success', tone: 'success' };
    if (run.result === 'business_outcome') return { label: 'Business outcome', tone: 'neutral' };
    if (run.result === 'cancelled') return { label: 'Stopped', tone: 'neutral' };
    return { label: 'Failed', tone: 'danger' };
  }
  const states: Record<Exclude<Run['status'], 'completed'>, { label: string; tone: string }> = {
    queued: { label: 'Queued', tone: 'neutral' }, running: { label: 'Running', tone: 'active' },
    pausing: { label: 'Pausing', tone: 'warning' }, awaiting_human: { label: 'Needs attention', tone: 'warning' },
    human_control: { label: 'You have control', tone: 'active' }, awaiting_approval: { label: 'Approval required', tone: 'warning' },
  };
  return states[run.status];
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}><span className="badge-dot" />{children}</span>;
}
function Spinner() { return <Loader2 size={15} className="spin" aria-hidden="true" />; }
function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(true);
  const [view, setView] = useState<View>('workspace');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evidenceRun, setEvidenceRun] = useState<Run | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<'replay' | 'discovery'>('replay');
  const [task, setTask] = useState<TaskKind>('balance');
  const [goal, setGoal] = useState('');
  const [resolution, setResolution] = useState<GoalResolution | null>(null);
  const currentGoal = useRef('');
  const [capabilityId, setCapabilityId] = useState('');
  const explicitCapabilityId = useRef<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [inputs, setInputs] = useState<RunInputs>({ clientReference: '10001', accountReference: '', product: 'Everyday Savings', externalReference: 'LOCAL-001' });
  const [provider, setProvider] = useState<Provider>('openai');
  const firstLoad = useRef(true);
  const composerRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const run = state?.runs.find((item) => item.id === selectedId) ?? (evidenceRun?.id === selectedId ? evidenceRun : undefined);
  const availableCapabilities = state?.capabilities.filter((item) => item.task === task && item.status !== 'quarantined') ?? [];
  const chosenCapability = availableCapabilities.find((item) => item.id === capabilityId) ?? availableCapabilities[0];
  const chosenProvider = state?.providers.find((item) => item.id === provider);
  const attention = state?.runs.filter((item) => item.status === 'awaiting_human' || item.status === 'awaiting_approval' || item.effect === 'unknown') ?? [];

  const refresh = useCallback(async () => {
    const next = await api<AppState>('/api/state'); setState(next); setConnected(true);
    if (firstLoad.current) {
      firstLoad.current = false;
      const configured = next.providers.find((item) => item.configured);
      if (configured) setProvider(configured.id);
    }
    return next;
  }, []);
  useEffect(() => {
    let cancelled = false, busy = false;
    const poll = async () => {
      setNow(Date.now());
      if (busy) return; busy = true;
      try { if (!cancelled) await refresh(); } catch { if (!cancelled) setConnected(false); } finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    setFrame(null); setFrameError('');
    if (!selectedId || view !== 'workspace') return;
    let cancelled = false, busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      try {
        const next = await api<Frame>(`/api/runs/${encodeURIComponent(selectedId)}/frame`);
        if (!cancelled) { setFrame(next); setFrameError(''); }
      } catch (problem) { if (!cancelled) setFrameError((problem as Error).message); }
      finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId, view]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);

  async function perform(name: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(name); setError('');
    try { await action(); await refresh(); }
    catch (problem) { setError((problem as Error).message); }
    finally { inFlight.current = false; setPending(''); }
  }
  function selectRun(item: Run) { setSelectedId(item.id); setView('workspace'); setError(''); }
  async function inspectEvidenceRun(id: string) {
    await perform('evidence', async () => {
      const saved = await api<Run>(`/api/runs/${encodeURIComponent(id)}`);
      setEvidenceRun(saved); selectRun(saved);
    });
  }
  function changeGoal(value: string) {
    currentGoal.current = value; setGoal(value); setResolution(null); setError('');
  }
  function newRun() {
    setSelectedId(null); setView('workspace'); setError(''); changeGoal('');
    setCapabilityId(''); explicitCapabilityId.current = null;
    setTimeout(() => composerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 50);
  }
  function changeTask(value: TaskKind) {
    const nextInputs = value === 'member' ? { ...inputs, clientReference: '', accountReference: '', firstName: undefined, lastName: undefined } : inputs;
    setTask(value); setInputs(nextInputs); changeGoal(goalForTask(value, nextInputs)); setCapabilityId('');
    explicitCapabilityId.current = null;
    if ((scenario === 'commit_unknown' && value !== 'submit') || (scenario === 'validation' && value === 'balance')) setScenario('normal');
  }
  async function reviewGoal(override?: string) {
    const submittedGoal = override ?? goal;
    if (!submittedGoal.trim() || inFlight.current) return;
    if (override !== undefined) changeGoal(submittedGoal);
    await perform('resolve', async () => {
      const next = await api<GoalResolution>('/api/goals/resolve', { goal: submittedGoal });
      if (currentGoal.current !== submittedGoal) return;
      setResolution(next);
      if (next.status === 'ready' && next.task && next.inputs) {
        const selected = state?.capabilities.find((item) => item.id === explicitCapabilityId.current && item.task === next.task && item.status !== 'quarantined');
        const resolvedCapabilityId = selected?.id ?? next.capabilityId;
        if (!selected) explicitCapabilityId.current = null;
        setTask(next.task); setInputs(next.inputs); setCapabilityId(resolvedCapabilityId ?? '');
        setMode(resolvedCapabilityId ? 'replay' : 'discovery');
        if ((scenario === 'commit_unknown' && next.task !== 'submit') || (scenario === 'validation' && next.task === 'balance')) setScenario('normal');
      }
    });
  }
  async function startRun() {
    if (resolution?.status !== 'ready') { setError('Review the current goal before starting a run.'); return; }
    await perform('start', async () => {
      const body = {
        mode, task, goal, inputs, scenario, idempotencyKey: crypto.randomUUID(), goalReviewed: true,
        ...(mode === 'replay' ? { capabilityId: chosenCapability?.id } : { provider, model: chosenProvider?.model }),
      } satisfies CreateRun;
      const created = await api<Run>('/api/runs', body); setSelectedId(created.id);
      setNotice(`${mode === 'replay' ? 'Replay' : 'Discovery'} started. The local Chromium browser is opening.`);
    });
  }
  async function control(action: string) {
    if (!run) return;
    await perform(action, async () => {
      await api(`/api/runs/${encodeURIComponent(run.id)}/${action}`, { epoch: run.epoch, ...(action === 'approve' ? { approvalId: run.approval?.id } : {}) });
      const messages: Record<string, string> = { pause: 'Pause requested. Waiting for the worker to yield.', takeover: 'Control transfer requested.', resume: 'Handback requested. The worker will validate the current state.', stop: 'Stop requested. Completed effects are preserved.', approve: 'Approval submitted for this exact action.', reconcile: 'Reconciliation requested. The operation will not be blindly repeated.' };
      setNotice(messages[action] ?? 'Request sent.');
    });
  }
  async function selectAccount(accountReference:string){
    const selection=run?.intervention?.accountSelection;
    if(!run||run.status!=='awaiting_human'||!selection||selection.clientReference!==run.inputs.clientReference||!selection.choices.some(choice=>choice.accountReference===accountReference))return;
    await perform('select-account',async()=>{
      await api(`/api/runs/${encodeURIComponent(run.id)}/select-account`,{epoch:run.epoch,accountReference});
      setNotice('Account selected. The worker will verify it in the same application session.');
    });
  }
  async function sendInput(data: Omit<HumanInput, 'epoch' | 'frameRevision' | 'commandId'>) {
    if (!run || !frame || run.owner !== 'human' || run.status !== 'human_control') return;
    if (!connected || Date.now() - Date.parse(frame.at) > 3000) { setError('The displayed frame is stale. Wait for a fresh frame before sending input.'); return; }
    await perform('input', async () => {
      await api(`/api/runs/${encodeURIComponent(run.id)}/input`, { ...data, epoch: run.epoch, frameRevision: frame.revision, commandId: crypto.randomUUID() });
      const next = await api<Frame>(`/api/runs/${encodeURIComponent(run.id)}/frame`); setFrame(next);
    });
  }
  function chooseCapability(capability: CapabilityRecord) {
    const nextInputs = capability.task === 'member' ? { ...inputs, clientReference: '', accountReference: '', firstName: undefined, lastName: undefined } : inputs;
    newRun(); setMode('replay'); setTask(capability.task); setInputs(nextInputs); changeGoal(goalForTask(capability.task, nextInputs)); setCapabilityId(capability.id); setScenario('normal');
    explicitCapabilityId.current = capability.id;
  }
  function prepareForMember(clientReference: string) {
    if (!/^\d{4,12}$/.test(clientReference)) return;
    newRun(); setTask('prepare'); setScenario('normal');
    setInputs({ ...inputs, clientReference, accountReference: '', firstName: undefined, lastName: undefined });
    changeGoal(`Prepare a savings application for member ${clientReference} and stop at review`);
  }
  const verifiedCount = state?.runs.filter((item) => item.result === 'succeeded' && item.effect !== 'unknown').length ?? 0;
  const activeCount = state?.runs.filter((item) => item.status !== 'completed').length ?? 0;
  const nav: { id: View; label: string; icon: typeof Monitor }[] = [
    { id: 'workspace', label: 'Workspace', icon: LayoutDashboard }, { id: 'capabilities', label: 'Capabilities', icon: Layers3 },
    { id: 'history', label: 'Run history', icon: History }, { id: 'settings', label: 'Settings', icon: Settings2 },
  ];

  const goalComposer = state && <GoalComposer
    formRef={composerRef} goal={goal} resolution={resolution} onGoalChange={changeGoal}
    onReview={reviewGoal} onStart={startRun} mode={mode} onModeChange={setMode}
    task={task} onTaskChange={changeTask} inputs={inputs} onInputsChange={setInputs}
    scenario={scenario} onScenarioChange={setScenario} provider={provider} onProviderChange={setProvider}
    state={state} capability={chosenCapability} capabilities={availableCapabilities} onCapabilityChange={(id) => { setCapabilityId(id); explicitCapabilityId.current = id; }}
    pending={pending} connected={connected} onSettings={() => setView('settings')}
  />;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <aside className="sidebar" aria-label="Main navigation">
      <a className="brand" href="#workspace" onClick={(event) => { event.preventDefault(); setView('workspace'); }} aria-label="Interface workspace">
        <span className="brand-mark" aria-hidden="true"><img src="/brand/interface-icon.png" alt="" width={34} height={34} /></span><span>interface</span>
      </a>
      <div className="workspace-label"><span className="workspace-avatar">L</span><div><strong>Local workspace</strong><span>Credit union operations</span></div><FlaskConical size={15} /></div>
      <div className="nav-label">WORKBENCH</div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id)} aria-label={label} aria-current={view === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'capabilities' && <span className="nav-count">{state?.capabilities.length ?? 0}</span>}</button>)}</nav>
      <div className="sidebar-recent"><div className="nav-label">RECENT RUNS <button className="icon-button" onClick={newRun} aria-label="Create a new run"><Plus size={15} /></button></div>
        {(state?.runs.slice(0, 5) ?? []).map((item) => <button className={`recent-run ${selectedId === item.id && view === 'workspace' ? 'selected' : ''}`} key={item.id} onClick={() => selectRun(item)}><span className={`run-dot ${status(item).tone}`} /><span>{TASKS[item.task].short}</span><ChevronRight size={13} /></button>)}
        {!state?.runs.length && <p className="sidebar-empty">Your recent work will appear here.</p>}
      </div>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={17} /><div><strong>Synthetic data only</strong><p>Runs on this computer.<br />No live customer accounts.</p></div></div><div className="runtime-line"><span className={`connection-dot ${connected ? '' : 'offline'}`} />{connected ? 'Local service connected' : 'Service disconnected'}<span className="mono">v{state?.runtime.version ?? '0.1'}</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Workbench</span><ChevronRight size={14} /><strong>{nav.find((item) => item.id === view)?.label}</strong></div><div className="topbar-right"><span className="local-chip"><span />LOCAL</span><button className="button small" onClick={newRun}><Plus size={15} />New run</button></div></header>
      <main id="main-content" className="main-content">
        {!connected && <div className="alert danger" role="alert"><WifiOff size={18} /><div><strong>Connection to the local service was lost.</strong><p>A run may still be active. Reconnecting restores its actual state; it does not start another run.</p></div></div>}
        {error && <div className="alert danger" role="alert"><TriangleAlert size={18} /><div><strong>Request could not be completed</strong><p>{error}</p></div><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="notice" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14} /></button></div>}
        {!state ? <div className="loading-page"><Spinner /><h2>{connected ? 'Connecting to your workbench' : 'Waiting for the local service'}</h2><p>The application will reconnect automatically.</p></div> : <>
          {view === 'workspace' && <>
            <div className="page-heading"><div><div className="eyebrow"><span className="small-square" />OPERATOR WORKSPACE</div><h1>{run ? TASKS[run.task].short : 'Your next operation starts here.'}</h1><p>{run ? run.goal : 'Describe what you need in plain language, then review it before the browser acts.'}</p></div>{run ? <Badge tone={status(run).tone}>{status(run).label}</Badge> : <div className="heading-target"><Monitor size={18} /><div><strong>{state.target.name}</strong><span>Local Chromium browser</span></div></div>}</div>
            <div className="metric-strip"><div><Activity size={17} /><strong>{activeCount}</strong><span>Active runs</span></div><button onClick={() => { setView('history'); }}><Hand size={17} /><strong>{attention.length}</strong><span>Need attention</span><ArrowUpRight size={13} /></button><div><CheckCheck size={17} /><strong>{verifiedCount}</strong><span>Verified successes</span></div><div><Layers3 size={17} /><strong>{state.capabilities.length}</strong><span>Saved capabilities</span></div></div>
            {!state.runtime.browserAvailable && <div className="alert warning"><TriangleAlert size={18} /><div><strong>A browser is needed to start a run.</strong><p>Open Settings to check the local runtime and browser installation.</p></div><button className="button small" onClick={() => setView('settings')}>Settings<ArrowRight size={14} /></button></div>}
            <div className="workbench-grid"><div className="center-column">
              {!run && goalComposer}
              <Session run={run} frame={frame} frameError={frameError} now={now} connected={connected} pending={pending} targetUrl={state.target.url} onControl={control} onInput={sendInput} />
              {run && goalComposer}

            </div><RunInspector run={run} now={now} pending={pending} connected={connected} onControl={control} onSelectAccount={selectAccount} onCapability={(id) => { setCapabilityId(id); setView('capabilities'); }} onPrepareForMember={prepareForMember} /></div>
          </>}
          {view === 'capabilities' && <Capabilities state={state} selectedId={capabilityId} onSelect={setCapabilityId} pending={pending} onRun={chooseCapability} onInspectRun={inspectEvidenceRun} onApprove={(item) => perform('capability-approve', async () => { await api(`/api/capabilities/${encodeURIComponent(item.id)}/approve`, { expectedDigest: item.digest }); setNotice('Capability review recorded for this exact version.'); })} onDownload={(item) => perform('download', async () => { const value = await api(`/api/capabilities/${encodeURIComponent(item.id)}`); download(value, `${item.id}-${item.version}.json`); })} />}
          {view === 'history' && <RunHistory runs={state.runs} now={now} onSelect={selectRun} />}
          {view === 'settings' && <ProviderSettings state={state} pending={pending} onSave={(body) => perform('provider-save', async () => { await api('/api/providers', body); setNotice(`${PROVIDERS[body.provider]} configuration saved for this process.`); })} />}
        </>}
      </main>
      <footer className="app-footer"><span>{state?.target.name ?? 'Local banking'} · Synthetic data</span><span>Observe → act → verify</span></footer>
    </div>
  </div>;
}

function GoalComposer({
  formRef, goal, resolution, onGoalChange, onReview, onStart, mode, onModeChange,
  task, onTaskChange, inputs, onInputsChange, scenario, onScenarioChange,
  provider, onProviderChange, state, capability, capabilities, onCapabilityChange,
  pending, connected, onSettings,
}: {
  formRef: RefObject<HTMLFormElement | null>; goal: string; resolution: GoalResolution | null;
  onGoalChange: (goal: string) => void; onReview: (goal?: string) => Promise<void>; onStart: () => Promise<void>;
  mode: 'replay' | 'discovery'; onModeChange: (mode: 'replay' | 'discovery') => void;
  task: TaskKind; onTaskChange: (task: TaskKind) => void; inputs: RunInputs; onInputsChange: (inputs: RunInputs) => void;
  scenario: Scenario; onScenarioChange: (scenario: Scenario) => void; provider: Provider; onProviderChange: (provider: Provider) => void;
  state: AppState; capability?: CapabilityRecord; capabilities: CapabilityRecord[]; onCapabilityChange: (id: string) => void;
  pending: string; connected: boolean; onSettings: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [memberDetails, setMemberDetails] = useState({ firstName: '', lastName: '', clientReference: '' });
  useEffect(() => { setMemberDetails({ firstName: '', lastName: '', clientReference: '' }); }, [goal]);
  const ready = resolution?.status === 'ready';
  const supportsMember = state.target.id === 'mifos-x' && state.capabilities.some((item) => item.task === 'member' && item.status !== 'quarantined');
  const memberClarification = resolution?.status === 'clarification' && resolution.clarificationKind === 'new_member' && supportsMember;
  const accountClarification = resolution?.status === 'clarification' && resolution.clarificationKind === 'account_intent' && supportsMember;
  const goalExamples = supportsMember ? ['Create a new member after my approval', ...GOAL_EXAMPLES] : GOAL_EXAMPLES;
  const providerReady = state.providers.find((item) => item.id === provider)?.configured;
  const effectBoundary = task === 'balance' ? 'Read savings balance in USD. No record changes.'
    : task === 'prepare' ? 'Stop at the application review. Do not submit.'
      : task === 'member' ? 'Pause for approval of the exact member form, then create the member once. Savings is a separate next step.'
        : 'Pause for your exact-action approval before submitting once.';
  async function reviewCurrentGoal() {
    if (memberClarification) {
      if (!formRef.current?.reportValidity()) return;
      await onReview(goalForTask('member', { ...inputs, ...memberDetails }));
    } else await onReview();
  }
  function generateMemberReference() {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const value = (BigInt(random[0]) << 32n) | BigInt(random[1]);
    setMemberDetails({ ...memberDetails, clientReference: String(100_000_000_000n + value % 900_000_000_000n) });
  }
  return <form ref={formRef} className="card task-composer goal-composer" onSubmit={(event) => { event.preventDefault(); void (ready ? onStart() : reviewCurrentGoal()); }}>
    <div className="goal-composer-heading"><div className="goal-symbol"><Sparkles size={19} /></div><div><h2>What would you like to do?</h2><p>Describe an outcome. Review the plan before anything runs.</p></div><span className="goal-scope">{state.target.id === 'mifos-x' ? 'LOCAL MIFOS X' : 'LOCAL LAB'}</span></div>
    <label className="goal-label primary-goal"><span className="sr-only">What would you like to do?</span><textarea value={goal} onChange={(event) => onGoalChange(event.target.value)} rows={3} maxLength={1200} required placeholder="For example: Look up member 10001 and read their current savings balance" aria-describedby="goal-description" /></label>
    <p className="goal-description" id="goal-description">{supportsMember ? 'Create a new member, look up a savings balance, or prepare a savings application. Review comes before any action.' : 'Use natural language to look up a savings balance or prepare an application with a review or approval boundary.'}</p>
    {!goal.trim() && <div className="goal-examples"><span>TRY A GOAL</span>{goalExamples.map((example) => <button type="button" key={example} onClick={() => onGoalChange(example)}><span>{example}</span><ArrowUpRight size={13} /></button>)}</div>}
    {resolution?.status === 'clarification' && <section className="goal-clarification" aria-label="Goal clarification">
      <div className="clarification-heading" role="status"><BookOpen size={17} /><strong>{accountClarification ? 'Who is this account for?' : memberClarification ? 'Enter the new member’s details' : 'A little more detail is needed'}</strong></div>
      <p>{resolution.explanation}</p>
      {accountClarification ? <div className="account-intent-actions">
        <button type="button" className="button" disabled={!!pending || !connected} onClick={() => void onReview('Create a new member after my approval')}>New member/customer<ArrowRight size={14} /></button>
        <button type="button" className="button" disabled={!!pending || !connected} onClick={() => void onReview('Prepare a savings application for an existing member and stop at review')}>Existing member<ArrowRight size={14} /></button>
      </div> : memberClarification ? <>
        <fieldset className="new-member-details" disabled={!!pending} aria-describedby="member-details-hint">
          <legend className="sr-only">New member details</legend>
          <div className="form-grid two">
            <label>First name<input value={memberDetails.firstName} onChange={(event) => setMemberDetails({ ...memberDetails, firstName: event.target.value })} required maxLength={50} pattern={"[\\p{L}\\p{M}][\\p{L}\\p{M} .'\\-]*"} autoComplete="off" title="Use a synthetic first name with letters, spaces, periods, apostrophes, or hyphens." /></label>
            <label>Last name<input value={memberDetails.lastName} onChange={(event) => setMemberDetails({ ...memberDetails, lastName: event.target.value })} required maxLength={50} pattern={"[\\p{L}\\p{M}][\\p{L}\\p{M} .'\\-]*"} autoComplete="off" title="Use a synthetic last name with letters, spaces, periods, apostrophes, or hyphens." /></label>
          </div>
          <div className="member-reference-field"><label>New member reference<input value={memberDetails.clientReference} onChange={(event) => setMemberDetails({ ...memberDetails, clientReference: event.target.value })} pattern="[0-9]{4,12}" inputMode="numeric" minLength={4} maxLength={12} autoComplete="off" required aria-describedby="member-details-hint" /></label><button className="button small" type="button" onClick={generateMemberReference}>Generate reference</button></div>
          <p className="field-hint" id="member-details-hint">Use synthetic names and a fresh 4–12 digit reference. Generate one or enter your own; the application will check whether it is unused. This is the member’s external reference; Mifos assigns its own account number. Savings is a separate next step.</p>
          <button type="button" className="button primary" disabled={!connected || !!pending} onClick={() => void reviewCurrentGoal()}><FileCheck2 size={15} />Review member details</button>
        </fieldset>
      </> : resolution.questions.length > 0 && <ul>{resolution.questions.map((question) => <li key={question}>{question}</li>)}</ul>}
      <span>{accountClarification ? 'Choose one to continue. Nothing has started.' : memberClarification ? 'Reviewing these details does not create the member. The live form will require your approval.' : 'Edit your goal above, then review it again. Nothing has started.'}</span>
    </section>}
    {ready && <section className="goal-review" aria-label="Reviewed operation"><div className="goal-review-heading"><span><CheckCircle2 size={17} /><strong>Review your operation</strong></span><Badge tone="success">Ready to start</Badge></div><p>{resolution.explanation}</p><dl className="goal-review-facts"><div><dt>Application</dt><dd>{state.target.name}</dd></div><div><dt>Operation</dt><dd>{TASKS[task].name}</dd></div><div><dt>{task === 'member' ? 'New member reference' : 'Member'}</dt><dd className="mono">{inputs.clientReference}</dd></div>{task === 'member' && <><div><dt>First name</dt><dd>{inputs.firstName}</dd></div><div><dt>Last name</dt><dd>{inputs.lastName}</dd></div></>}{task === 'balance' && <div><dt>Savings account</dt><dd>{inputs.accountReference || 'Resolve from member’s savings accounts'}</dd></div>}{(task === 'prepare' || task === 'submit') && <><div><dt>Product</dt><dd>{inputs.product}</dd></div><div><dt>External reference</dt><dd className="mono">{inputs.externalReference}</dd></div></>}</dl><div className="goal-boundary"><ShieldCheck size={15} /><span>{effectBoundary}</span></div><div className="goal-execution"><span>{mode === 'replay' ? <Play size={13} /> : <Sparkles size={13} />}{mode === 'replay' ? (capability?.status === 'draft' ? 'Validation replay' : 'Deterministic replay') : 'Model discovery'}</span><p>{mode === 'replay' ? `${capability?.name ?? 'Saved capability'} · ${capability?.provenance.kind ?? 'saved'} · no model calls` : `${PROVIDERS[provider]} proposes UI actions; the worker checks and verifies them.`}</p></div></section>}
    <button className="disclosure goal-settings-toggle" type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><Settings2 size={13} />Advanced run settings<span>{mode === 'replay' ? 'Replay' : 'Discovery'} · {SCENARIOS[scenario].label}</span><ChevronDown size={13} className={advanced ? 'rotate' : ''} /></button>
    {advanced && <div className="advanced-goal-settings"><div className="advanced-mode"><div><strong>Execution mode</strong><p>Replay uses a saved flow. Discovery asks a real model to operate the UI.</p></div><div className="segmented" aria-label="Execution mode"><button type="button" className={mode === 'replay' ? 'active' : ''} onClick={() => onModeChange('replay')} aria-pressed={mode === 'replay'}><Play size={13} />Replay</button><button type="button" className={mode === 'discovery' ? 'active' : ''} onClick={() => onModeChange('discovery')} aria-pressed={mode === 'discovery'}><Sparkles size={13} />Discover</button></div></div>
      {ready && <><div className="form-grid two"><label>Operation<select value={task} onChange={(event) => onTaskChange(event.target.value as TaskKind)}>{Object.entries(TASKS).filter(([value]) => value !== 'member' || supportsMember).map(([value, item]) => <option key={value} value={value}>{item.name}</option>)}</select><span className="field-hint">Changing the operation rewrites your goal and requires another review.</span></label>{mode === 'replay' ? <label>Capability<select value={capability?.id ?? ''} onChange={(event) => onCapabilityChange(event.target.value)} disabled={!capabilities.length}>{!capabilities.length && <option value="">No compatible capability</option>}{capabilities.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.provenance.kind}{item.status === 'draft' ? ' · draft' : ''}</option>)}</select></label> : <label>Discovery provider<select value={provider} onChange={(event) => onProviderChange(event.target.value as Provider)}>{state.providers.map((item) => <option key={item.id} value={item.id}>{PROVIDERS[item.id]}{item.configured ? '' : ' · not configured'}</option>)}</select></label>}</div><div className="form-grid two"><label>{task === 'member' ? 'New member reference' : 'Member reference'}<input value={inputs.clientReference} onChange={(event) => onInputsChange({ ...inputs, clientReference: event.target.value })} pattern="[0-9]{4,12}" inputMode="numeric" required /></label>{task === 'balance' && <label>Account reference <span className="optional">optional</span><input value={inputs.accountReference} onChange={(event) => onInputsChange({ ...inputs, accountReference: event.target.value })} pattern="[A-Za-z0-9-]{3,32}" placeholder="Resolve from the member’s accounts" /></label>}</div>{(task === 'prepare' || task === 'submit') && <div className="form-grid two"><label>Savings product<select value={inputs.product} onChange={(event) => onInputsChange({ ...inputs, product: event.target.value as RunInputs['product'] })}><option>Everyday Savings</option><option>Growth Savings</option></select></label><label>External reference<input value={inputs.externalReference} onChange={(event) => onInputsChange({ ...inputs, externalReference: event.target.value })} pattern="[A-Za-z0-9-]{1,40}" required /></label></div>}{task === 'member' && <div className="form-grid two">
        <label>First name<input value={inputs.firstName ?? ''} onChange={(event) => onInputsChange({ ...inputs, firstName: event.target.value })} maxLength={50} required /></label>
        <label>Last name<input value={inputs.lastName ?? ''} onChange={(event) => onInputsChange({ ...inputs, lastName: event.target.value })} maxLength={50} required /></label>
      </div>}<p className="advanced-input-note">Values explicitly named in your goal must match these fields. Edit the goal to change its instruction.{task === 'balance' && ' An empty account reference requires a unique savings account to be found in the member’s UI.'}{task === 'member' && ' Use synthetic names and a fresh, unused member reference.'}</p></>}
      {state.target.id !== 'mifos-x' && <div className="scenario-field"><label>Application condition<select value={scenario} onChange={(event) => onScenarioChange(event.target.value as Scenario)}>{Object.entries(SCENARIOS).map(([value, item]) => <option key={value} value={value} disabled={(value === 'commit_unknown' && task !== 'submit') || (value === 'validation' && task === 'balance')}>{item.label}</option>)}</select></label><p className="field-hint">{SCENARIOS[scenario].detail} All scenarios use synthetic records.</p></div>}
    </div>}
    {ready && mode === 'discovery' && !providerReady && <div className="inline-callout"><KeyRound size={16} /><span>A valid provider API key is required for discovery. Replay works without one.</span><button type="button" className="text-button" onClick={onSettings}>Configure<ArrowRight size={13} /></button></div>}
    <div className="composer-footer"><span><ShieldCheck size={14} />{ready ? 'Your goal is checked again before launch' : 'Reviewing a goal does not start the browser'}</span><div className="goal-submit-actions">{!memberClarification && <button className={`button ${ready ? '' : 'primary'}`} type="button" disabled={!!pending || !connected || !goal.trim()} onClick={() => void onReview()}>{pending === 'resolve' ? <Spinner /> : <FileCheck2 size={15} />}{pending === 'resolve' ? 'Reviewing…' : 'Review goal'}</button>}{ready && <button className="button primary" type="submit" disabled={!!pending || !connected || !state.runtime.browserAvailable || (mode === 'discovery' ? !providerReady : !capability)}>{pending === 'start' ? <Spinner /> : <Play size={15} />}{pending === 'start' ? 'Starting…' : 'Start run'}</button>}</div></div>
  </form>;
}

function Session({ run, frame, frameError, now, connected, pending, targetUrl, onControl, onInput }: {
  run?: Run; frame: Frame | null; frameError: string; now: number; connected: boolean; pending: string; targetUrl: string;
  onControl: (action: string) => Promise<void>; onInput: (input: Omit<HumanInput, 'epoch' | 'frameRevision' | 'commandId'>) => Promise<void>;
}) {
  const [text, setText] = useState(''); const [key, setKey] = useState('Enter');
  const human = run?.status === 'human_control' && run.owner === 'human';
  const stale = !connected || (!!frame && now - Date.parse(frame.at) > 3000);
  const canInput = human && !!frame && !stale && !pending;
  const age = frame ? Math.max(0, Math.floor((now - Date.parse(frame.at)) / 1000)) : 0;
  const approvalExpired = !!run?.approval && Date.parse(run.approval.expiresAt) <= now;
  return <section className={`card session-card ${human ? 'human-session' : ''}`} aria-label="Live application session">
    <div className="session-title"><div className="section-title"><Monitor size={17} /><h2>Chromium browser</h2>{run && <span className="mode-label">{run.mode === 'replay' ? 'REPLAY' : 'DISCOVERY'}</span>}</div>{run && <span className="session-identifier mono">{run.sessionId.slice(0, 14)}</span>}</div>
    {run?.status === 'awaiting_approval' && run.approval && <div className="session-approval-notice" role="status">
      <ShieldCheck size={18} /><div><strong>{approvalExpired ? 'A fresh approval is needed' : 'Waiting for your approval'}</strong><p>{approvalExpired ? 'The approval expired. Open the review for steps to renew it.' : run.task === 'member' ? 'The member is prepared. Review and approve its creation to continue.' : 'The application is prepared. Review and approve submission to continue.'}</p></div>
      <a className="button small" href="#run-approval">Review approval<ArrowRight size={14} /></a>
    </div>}
    {run?.status==='awaiting_human'&&run.intervention?.accountSelection&&<div className="session-approval-notice" role="status"><Hand size={18}/><div><strong>Choose a savings account</strong><p>The member has several matching accounts. Select one to continue the balance lookup.</p></div><a className="button small" href="#run-account-selection">Choose account<ArrowRight size={14}/></a></div>}
    <div className="browser-bar"><div className="window-dots"><i /><i /><i /></div><div className="browser-address"><ShieldCheck size={12} /><span>{targetUrl.replace(/^https?:\/\//, '')}</span></div><a className="icon-button" href={targetUrl} target="_blank" rel="noreferrer" aria-label="Open the separate local target application" title="Open application separately; this does not take over the run session"><ExternalLink size={14} /></a></div>
    <div className="session-viewport">
      {run && frame?.dataUrl ? <>
        <img className={human ? 'interactive-frame' : ''} src={frame.dataUrl} alt={`Live ${human ? 'human-controlled' : 'automation'} session for ${TASKS[run.task].short}`} draggable={false} onClick={(event) => {
          if (!canInput) return;
          const rect = event.currentTarget.getBoundingClientRect();
          void onInput({ action: 'click', x: Math.round((event.clientX - rect.left) * frame.width / rect.width), y: Math.round((event.clientY - rect.top) * frame.height / rect.height) });
        }} />
        {stale && <div className="stale-frame"><WifiOff size={15} />{connected ? 'Waiting for a fresh frame · input paused' : 'Connection lost · last received frame'}</div>}
      </> : <div className="session-placeholder"><div className="placeholder-monitor"><Monitor size={38} strokeWidth={1.3} /><span /></div><h3>{run ? 'Opening the live session' : 'Your local browser session appears here.'}</h3><p>{run ? (frameError || 'This is the worker’s Chromium browser on your computer, not a cloud desktop.') : 'Describe a goal above to watch a local Chromium browser operate the credit union application.'}</p><span className="placeholder-label"><span />{run ? 'WAITING FOR FRAME' : 'SESSION READY ON START'}</span></div>}
    </div>
    <div className="session-statusbar"><span className="owner-label">{human ? <Hand size={13} /> : <MousePointer2 size={13} />}{run ? human ? 'You control this session' : run.owner === 'automation' ? 'Automation has control' : 'No active controller' : 'No active session'}</span><span className="frame-label">{frame ? `${stale ? 'Stale' : 'Live'} · ${age < 1 ? 'just now' : `${age}s ago`}` : 'No frame'}{frame && <span className="mono">#{frame.revision}</span>}</span></div>
    {run && <div className="session-controls"><div className="control-buttons">{!human && run.status !== 'completed' && <><button className="button small" disabled={!!pending || !connected || run.status !== 'running'} onClick={() => void onControl('pause')}>{pending === 'pause' ? <Spinner /> : <Pause size={14} />}{pending === 'pause' || run.status === 'pausing' ? 'Pausing…' : 'Pause'}</button><button className="button small" disabled={!!pending || !connected || run.status === 'pausing'} onClick={() => void onControl('takeover')}>{pending === 'takeover' ? <Spinner /> : <Hand size={14} />}Take control</button></>}{human && <button className="button small primary" disabled={!!pending || !connected} onClick={() => void onControl('resume')}>{pending === 'resume' ? <Spinner /> : <Play size={14} />}Return to automation</button>}{run.status === 'awaiting_human' && !run.intervention?.accountSelection && <button className="button small" disabled={!!pending || !connected} onClick={() => void onControl('resume')}><RefreshCw size={14} />Validate & resume</button>}{run.status !== 'completed' && <button className="button small danger-quiet" disabled={!!pending || !connected} onClick={() => void onControl('stop')}>{pending === 'stop' ? <Spinner /> : <Square size={13} />}Stop</button>}</div><span className="control-hint">{run.status === 'completed' ? 'Session record retained' : pending && pending !== 'input' ? 'Waiting for worker acknowledgement' : human ? 'Click the screen or use the controls below' : 'Control changes require worker acknowledgement'}</span></div>}
    {human && <div className="human-input"><div className="human-input-heading"><Keyboard size={15} /><strong>Manual input</strong><span>Same live session · epoch {run.epoch}</span></div><form onSubmit={(event) => { event.preventDefault(); if (canInput && text) void onInput({ action: 'type', text }); }} className="input-row"><label className="sr-only" htmlFor="manual-text">Text to type into the focused application field</label><input id="manual-text" value={text} maxLength={200} onChange={(event) => setText(event.target.value)} placeholder="Type into the focused field…" /><button className="button small" disabled={!canInput || !text} type="submit">Type text<ArrowRight size={13} /></button></form><div className="key-row"><label className="sr-only" htmlFor="manual-key">Key to send to the application</label><select id="manual-key" value={key} onChange={(event) => setKey(event.target.value)}>{['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp', 'Meta+A'].map((item) => <option key={item}>{item}</option>)}</select><button className="button small" disabled={!canInput} onClick={() => void onInput({ action: 'key', key })}>Send key</button><div className="scroll-controls"><button className="button small" disabled={!canInput} onClick={() => void onInput({ action: 'scroll', deltaY: -400 })} aria-label="Scroll the application up"><ArrowUp size={14} /></button><button className="button small" disabled={!canInput} onClick={() => void onInput({ action: 'scroll', deltaY: 400 })} aria-label="Scroll the application down"><ArrowDown size={14} /></button></div></div><p className="field-hint">Use Tab and Enter to navigate by keyboard. Inputs use the displayed frame; stale requests are rejected.</p></div>}
  </section>;
}

function ApprovalCard({ run, now, pending, connected, onControl }: {
  run: Run; now: number; pending: string; connected: boolean; onControl: (action: string) => Promise<void>;
}) {
  const approval = run.approval;
  if (!approval) return null;
  const expired = Date.parse(approval.expiresAt) <= now;
  const summary = Object.entries(approval.summary).filter(([key]) => key !== 'previewText');
  const previewText = approval.summary.previewText;
  return <section id="run-approval" className="card intervention-card warning-border approval-card" aria-labelledby="approval-title" tabIndex={-1}>
    <div className="intervention-title"><ShieldCheck size={18} /><h2 id="approval-title">{expired ? 'Approval expired' : run.task === 'member' ? 'Member creation needs approval' : 'Submission needs approval'}</h2></div>
    <p>{run.task === 'member' ? 'The member is prepared and waiting. Review the details before approving creation.' : 'The application is prepared and waiting. Review the details before approving submission.'}</p>
    <dl className="approval-summary">{summary.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{value}</dd></div>)}</dl>
    {previewText && <details className="approval-preview"><summary>Full application preview</summary><pre>{previewText}</pre></details>}
    <p className="approval-expiry"><Clock3 size={12} />{expired ? 'This approval can no longer be used.' : `Expires at ${time(approval.expiresAt)}`}</p>
    {expired ? <>
      <p className="approval-renewal">Take control to inspect the current form, then choose <strong>Return to automation</strong>. The worker will validate it and request a fresh approval.</p>
      <button className="button full" disabled={!!pending || !connected} onClick={() => void onControl('takeover')}>{pending === 'takeover' ? <Spinner /> : <Hand size={15} />}Take control</button>
    </> : <button className="button primary full" disabled={!!pending || !connected || approval.consumed} onClick={() => void onControl('approve')}>{pending === 'approve' ? <Spinner /> : <Check size={15} />}{run.task === 'member' ? 'Approve member creation' : 'Approve this submission'}</button>}
    <span className="field-hint">Approval applies to this exact preview and can be used once.</span>
  </section>;
}

function AccountSelectionCard({run,pending,connected,onSelect}:{run:Run;pending:string;connected:boolean;onSelect:(accountReference:string)=>Promise<void>}){
  const [selected,setSelected]=useState('');
  const selection=run.intervention?.accountSelection;
  if(!selection)return null;
  const valid=selection.clientReference===run.inputs.clientReference&&selection.choices.some(choice=>choice.accountReference===selected);
  return <section id="run-account-selection" className="card intervention-card account-selection-card" aria-labelledby="account-selection-title" tabIndex={-1}>
    <div className="intervention-title"><Hand size={18}/><h2 id="account-selection-title">Which savings account?</h2></div>
    <p>Member <strong className="mono">{selection.clientReference}</strong> has more than one matching account. Choose the account whose balance you want to read.</p>
    <form onSubmit={event=>{event.preventDefault();if(valid)void onSelect(selected);}}>
      <fieldset disabled={!!pending||!connected||run.status!=='awaiting_human'}><legend>Savings accounts for member {selection.clientReference}</legend>
        {selection.choices.map(choice=><label key={choice.accountReference} className={`account-choice ${selected===choice.accountReference?'selected':''}`}>
          <input type="radio" name="savings-account" value={choice.accountReference} checked={selected===choice.accountReference} onChange={()=>setSelected(choice.accountReference)} required/>
          <span><strong className="mono">{choice.accountReference}</strong><span>{choice.product}</span><small>Status: {choice.status}</small>{choice.accountNumber&&choice.accountNumber!==choice.accountReference&&<small>Account number: {choice.accountNumber}</small>}</span>
        </label>)}
      </fieldset>
      <button type="submit" className="button primary full" disabled={!valid||!!pending||!connected||run.status!=='awaiting_human'}>{pending==='select-account'?<Spinner/>:<ArrowRight size={15}/>}Select account &amp; continue</button>
    </form>
    <span className="field-hint">The worker checks that the selected account still belongs to this member before continuing.</span>
  </section>;
}

function RunInspector({ run, now, pending, connected, onControl, onSelectAccount, onCapability, onPrepareForMember }: { run?: Run; now: number; pending: string; connected: boolean; onControl: (action: string) => Promise<void>; onSelectAccount: (accountReference:string) => Promise<void>; onCapability: (id: string) => void; onPrepareForMember: (reference: string) => void }) {
  const [showEvents, setShowEvents] = useState(false);
  const verified = run?.steps.filter((step) => step.state === 'verified').length ?? 0;
  const createdMemberReference = run?.task === 'member' && run.targetId === 'mifos-x' && run.status === 'completed' && run.result === 'succeeded' && run.effect === 'verified' && typeof run.output?.clientReference === 'string' && /^\d{4,12}$/.test(run.output.clientReference) && run.output.clientReference === run.inputs.clientReference ? run.output.clientReference : undefined;
  return <aside className="inspector" aria-label="Run progress and evidence">
    {run?.effect === 'unknown' && <section className="card intervention-card warning-border"><div className="intervention-title"><TriangleAlert size={18} /><h2>Outcome unconfirmed</h2></div><p>{run.task === 'member' ? 'The application may have created the member. Reconcile the existing operation before attempting another.' : 'The application may have accepted the submission. Reconcile the existing operation before attempting another.'}</p><button className="button warning-button" disabled={!!pending || run.status !== 'completed'} onClick={() => void onControl('reconcile')}>{pending === 'reconcile' ? <Spinner /> : <RefreshCw size={14} />}Reconcile outcome</button></section>}
    {run?.status === 'awaiting_approval' && run.approval && <ApprovalCard run={run} now={now} pending={pending} connected={connected} onControl={onControl} />}
    {run?.status==='awaiting_human' && run.intervention?.accountSelection && <AccountSelectionCard key={`${run.id}:${run.epoch}`} run={run} pending={pending} connected={connected} onSelect={onSelectAccount}/> }
    {run?.intervention && !run.intervention.accountSelection && run.status !== 'completed' && run.status !== 'awaiting_approval' && run.effect !== 'unknown' && <section className="card intervention-card warning-border"><div className="intervention-title"><Hand size={18} /><h2>{run.status === 'human_control' ? 'You have control' : 'Operator needed'}</h2></div><p>{run.intervention.reason}</p><code className="outcome-code">{run.intervention.code}</code>{run.status !== 'human_control' && <button className="button full" disabled={!!pending} onClick={() => void onControl('takeover')}><Hand size={14} />Take over the live session</button>}</section>}
    {run?.status === 'completed' && <section className="card result-card"><div className="card-heading"><div className="section-title">{run.result === 'succeeded' ? <CheckCircle2 size={17} /> : run.result === 'failed' ? <XCircle size={17} /> : <FileCheck2 size={17} />}<h2>Run result</h2></div><a className="icon-button" aria-label="Download redacted run record" title="Download redacted run record" href={`/api/runs/${run.id}/audit`} download={`${run.id}-audit.json`}><Download size={15} /></a></div><Badge tone={status(run).tone}>{status(run).label}</Badge>{run.outcomeCode && <code className="outcome-code">{run.outcomeCode}</code>}{run.error && <p className={run.result === 'business_outcome' ? 'result-message' : 'result-error'}>{run.error}</p>}{run.output && <dl className="result-values">{Object.entries(run.output).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>}{createdMemberReference && <div className="member-next-step"><p>The member is verified. Prepare a savings application as a separate operation when you are ready.</p><button className="button full" disabled={!!pending} onClick={() => onPrepareForMember(createdMemberReference)}>Prepare savings application for this member<ArrowRight size={14} /></button></div>}{run.discoveredCapabilityId && <button className="button full" onClick={() => onCapability(run.discoveredCapabilityId!)}><BookOpen size={15} />Review discovered capability<ArrowRight size={13} /></button>}</section>}
    <section className="card progress-card"><div className="card-heading"><div className="section-title"><Activity size={16} /><h2>Execution</h2></div>{run && <span className="mono subtle">{elapsed(run, now)}</span>}</div>
      {run ? <><div className="run-context"><div><span>Run</span><code>{run.id.slice(0, 18)}</code></div><div><span>Mode</span><strong>{run.mode === 'replay' ? 'Deterministic replay' : 'Model discovery'}</strong></div><div><span>Model calls</span><strong>{run.modelCalls}{run.mode === 'replay' && run.modelCalls === 0 && <span className="verified-inline"><Check size={11} />model-free</span>}</strong></div><div><span>Condition</span><strong>{SCENARIOS[run.scenario].label}</strong></div></div>{run.mode === 'discovery' && run.discoveryBudget && <DiscoveryBudgetReadout run={run} />}<div className="steps-heading"><span>STEP PROGRESS</span><span>{verified} / {run.steps.length} completed</span></div><ol className="step-list">{run.steps.map((step, index) => <li key={step.id} className={`step ${step.state}`}><span className="step-marker">{step.state === 'verified' ? <Check size={13} /> : step.state === 'running' ? <Loader2 size={13} className="spin" /> : step.state === 'failed' ? <X size={13} /> : step.state === 'waiting' ? <Pause size={11} /> : index + 1}</span><div><strong>{step.label}</strong><span>{step.state === 'verified' ? (step.id.startsWith('verify-') ? 'State verified' : 'Action completed') : humanize(step.state)}</span></div></li>)}</ol>{!run.steps.length && <p className="panel-note">Discovery steps appear as the model acts and the worker observes results.</p>}</> : <><Empty icon={<FileCheck2 size={22} />} title="Every step, accounted for">Verified actions and expected outcomes will appear here when you start a run.</Empty><div className="principle-list"><div><CheckCircle2 size={15} /><span>Completion requires a verified state</span></div><div><Hand size={15} /><span>Intervene in the same live session</span></div><div><ShieldCheck size={15} /><span>Policy applies to every action</span></div></div></>}
    </section>
    {run && <section className="card evidence-card"><button className="evidence-toggle" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}><span><Code2 size={16} />Activity & evidence<span className="count-label">{run.events.length}</span></span><ChevronDown size={15} className={showEvents ? 'rotate' : ''} /></button>{showEvents && <ol className="event-list">{[...run.events].reverse().map((event) => <li key={event.id}><div><span>{event.actor}</span><time>{time(event.timestamp)}</time></div><p>{event.message}</p><code>{event.kind}</code></li>)}</ol>}</section>}
    <div className="inspector-footnote"><ShieldCheck size={14} /><span>Local banking data is synthetic. The screen is the actual worker browser.</span></div>
  </aside>;
}

function DiscoveryBudgetReadout({ run }: { run: Run }) {
  const budget = run.discoveryBudget;
  if (!budget) return null;
  const limits = [
    ['Model calls', run.modelCalls, budget.maxModelCalls],
    ['Browser actions', budget.actions, budget.maxActions],
    ['Active seconds', Math.ceil(budget.activeMs / 1000), Math.ceil(budget.maxActiveMs / 1000)],
    ['Unchanged observations', budget.unchangedObservations, budget.maxUnchangedObservations],
    ['Consecutive waits', budget.consecutiveWaits, budget.maxConsecutiveWaits],
  ] as const;
  return <section className="discovery-budget" aria-label="Discovery execution limits">
    <h3>Execution limits</h3>
    <dl>{limits.map(([label, used, limit]) => <div key={label}><dt>{label}</dt><dd className={used >= limit ? 'budget-exhausted' : ''}>{used} <span>/ {limit}</span></dd></div>)}</dl>
    <p>The worker pauses at a limit. Operator review time is excluded; resuming retains the used budget.</p>
  </section>;
}

function CapabilityEvidence({ capability, runs, pending, onInspectRun }: {
  capability: CapabilityRecord; runs: Run[]; pending: string; onInspectRun: (id: string) => Promise<void>;
}) {
  const evidence = capability.qualification;
  const sourceId = evidence?.discoveryRunId ?? capability.provenance.runId;
  const evidenceLabel = (id: string) => {
    const run = runs.find((item) => item.id === id);
    if (!run) return id.slice(0, 18);
    if (run.task === 'member') return `New member ${run.inputs.clientReference} · ${run.inputs.firstName ?? ''} ${run.inputs.lastName ?? ''}`;
    return `Member ${run.inputs.clientReference} · ${run.task === 'balance' ? run.inputs.accountReference || run.resolvedInputs?.accountReference || 'UI-resolved account' : run.inputs.product}`;
  };
  return <section className="capability-evidence" aria-label="Capability qualification evidence">
    <div className="qualification-heading"><h3>Replay evidence</h3><Badge tone={evidence?.eligible ? 'success' : 'warning'}>{evidence?.eligible ? 'Evidence ready' : 'Validation needed'}</Badge></div>
    <p>{capability.task === 'member'
      ? 'Approval requires a verified replay for a different new member with a fresh member reference, with no manual browser actions. Every member creation still requires approval of its exact form.'
      : capability.task === 'balance'
      ? 'Approval requires a verified replay for a different member and account, with no manual browser actions.'
      : 'Approval requires a verified replay for a different member with a fresh external reference, with no manual browser actions.'}{capability.task === 'submit' && ' Each submission still requires its own preview approval.'}</p>
    {evidence ? <>
      <dl className="qualification-facts">
        <div><dt>Contract integrity</dt><dd>{evidence.digestVerified ? 'Digest verified' : 'Digest mismatch'}</dd></div>
        <div><dt>Successful replay outcomes</dt><dd>{evidence.successfulReplays} / {evidence.totalReplays} replays</dd></div>
        <div><dt>Qualifying replays</dt><dd>{evidence.replayRunIds.length}</dd></div>
        <div><dt>Members in evidence</dt><dd>{evidence.distinctMemberCount}</dd></div>
        {(capability.task === 'prepare' || capability.task === 'submit') && <div><dt>Products in evidence</dt><dd>{evidence.testedProducts.length ? evidence.testedProducts.join(', ') : 'Not yet verified'}</dd></div>}
      </dl>
      {evidence.reasons.length > 0 && <ul className="qualification-reasons">{evidence.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    </> : <p className="qualification-missing">Qualification evidence is unavailable. Approval stays disabled until the worker verifies it.</p>}
    <div className="qualification-links">
      {sourceId && <button className="evidence-run-link" disabled={!!pending} onClick={() => void onInspectRun(sourceId)}><Sparkles size={14} /><span><strong>Discovery run</strong><small>{evidenceLabel(sourceId)}</small></span><ArrowUpRight size={15} /></button>}
      {evidence?.replayRunIds.map((id, index) => <button className="evidence-run-link" disabled={!!pending} key={id} onClick={() => void onInspectRun(id)}><CheckCheck size={14} /><span><strong>Qualifying replay {index + 1}</strong><small>{evidenceLabel(id)} · zero model calls</small></span><ArrowUpRight size={15} /></button>)}
    </div>
    <p className="qualification-scope">Evidence covers these synthetic local cases. It does not establish a reliability rate or coverage of other applications.</p>
    {capability.approvalReview && <div className="capability-review-record"><ShieldCheck size={14} /><div><strong>Review recorded</strong><span>{new Date(capability.approvalReview.at).toLocaleString('en-US')}</span><code title={capability.approvalReview.digest}>Digest {capability.approvalReview.digest.slice(0, 16)}…</code></div></div>}
  </section>;
}

function Capabilities({ state, selectedId, onSelect, pending, onRun, onApprove, onDownload, onInspectRun }: {
  state: AppState; selectedId: string; onSelect: (id: string) => void; pending: string;
  onRun: (item: CapabilityRecord) => void; onApprove: (item: CapabilityRecord) => Promise<void>; onDownload: (item: CapabilityRecord) => Promise<void>;
  onInspectRun: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const items = state.capabilities.filter((item) => `${item.name} ${item.description} ${item.provenance.kind}`.toLowerCase().includes(query.toLowerCase()));
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const canApprove = selected?.provenance.kind === 'discovered' ? selected.qualification?.eligible === true : (selected?.successCount ?? 0) > 0;
  return <>
    <div className="page-heading"><div><div className="eyebrow"><Layers3 size={13} />CAPABILITY LIBRARY</div><h1>Useful work, made repeatable.</h1><p>Review the contract, inspect its origin, and replay it with new inputs.</p></div><Badge>{state.capabilities.length} capabilities</Badge></div>
    <div className="search-field"><Search size={17} /><input aria-label="Search capabilities" placeholder="Search capabilities or provenance…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="catalog-grid"><div className="capability-list">
      {items.map((item) => <button className={`card capability-card ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)} key={item.id}>
        <div className="capability-card-top"><span className="capability-icon">{item.provenance.kind === 'discovered' ? <Sparkles size={19} /> : <FileCheck2 size={19} />}</span><Badge tone={item.status === 'approved' ? 'success' : item.status === 'quarantined' ? 'danger' : 'warning'}>{humanize(item.status)}</Badge></div>
        <h2>{item.name}</h2><p>{item.description}</p><div className="capability-meta"><span>{item.provenance.kind === 'authored' ? 'Authored baseline' : 'Model discovered'}</span><code>v{item.version}</code></div>
        <div className="capability-replays"><CheckCheck size={14} /><span>{item.provenance.kind === 'discovered' ? `${item.qualification?.replayRunIds.length ?? 0} qualifying replays` : `${item.successCount} verified / ${item.replayCount} replays`}</span><ArrowUpRight size={15} /></div>
      </button>)}
      {!items.length && <Empty icon={<Search size={22} />} title="No matching capabilities">Try another search, or complete a discovery to create one.</Empty>}
    </div>{selected && <section className="card capability-detail">
      <div className="card-heading"><div className="section-title"><BookOpen size={17} /><h2>Capability contract</h2></div><button className="button small" disabled={!!pending} onClick={() => void onDownload(selected)}><Download size={14} />JSON</button></div>
      <div className="capability-detail-body"><h2>{selected.name}</h2><p>{selected.description}</p>
        <dl className="contract-facts"><div><dt>Provenance</dt><dd>{selected.provenance.kind === 'authored' ? 'Authored · not an LLM recording' : `Discovered · ${selected.provenance.provider ?? 'model'}`}</dd></div><div><dt>Model</dt><dd>{selected.provenance.model ?? 'None'}</dd></div><div><dt>Input contract</dt><dd><code>{selected.inputs}</code></dd></div><div><dt>Output contract</dt><dd><code>{selected.output}</code></dd></div><div><dt>Target</dt><dd>{state.target.name}</dd></div><div><dt>Digest</dt><dd className="digest"><Fingerprint size={13} /><code title={selected.digest}>{selected.digest.slice(0, 24)}…</code></dd></div></dl>
        {selected.provenance.kind === 'discovered' && <CapabilityEvidence capability={selected} runs={state.runs} pending={pending} onInspectRun={onInspectRun} />}
        <div className="steps-heading"><span>RECORDED FLOW</span><span>{selected.steps.length} steps</span></div>
        <ol className="contract-steps">{selected.steps.map((step, index) => <li key={step.id}><span>{index + 1}</span><div><strong>{step.label}</strong><p><code>{step.action}</code>{step.target && ` · ${step.target.kind}: ${step.target.value}`}{step.checkpoint && ` · verify ${step.checkpoint}`}</p>{step.effect === 'commit' && <Badge tone="warning">Requires approval</Badge>}</div></li>)}</ol>
      </div>
      <div className="capability-actions">
        {selected.status === 'draft' && <><p className="field-hint">{canApprove ? 'Review the contract and linked runs, then record your approval for this digest.' : 'Complete a qualifying validation replay before approving this version.'}</p><button className="button full" disabled={!!pending || !canApprove} onClick={() => void onApprove(selected)}>{pending === 'capability-approve' ? <Spinner /> : <ShieldCheck size={15} />}Approve capability</button></>}
        <button className="button primary full" disabled={selected.status === 'quarantined' || !!pending} onClick={() => onRun(selected)}><Play size={15} />{selected.status === 'draft' ? 'Run validation replay' : 'Use this capability'}<ArrowRight size={14} /></button>
      </div>
    </section>}</div>
  </>;
}

function RunHistory({ runs, now, onSelect }: { runs: Run[]; now: number; onSelect: (run: Run) => void }) {
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const items = runs.filter((run) => `${run.id} ${run.goal} ${TASKS[run.task].name}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'finished' ? run.status === 'completed' : run.status === 'awaiting_approval' || run.status === 'awaiting_human' || run.effect === 'unknown')));
  return <><div className="page-heading"><div><div className="eyebrow"><History size={13} />RUN HISTORY</div><h1>A record of what happened.</h1><p>Inspect verified outcomes, interventions, and the evidence behind each run.</p></div><Badge>{runs.length} runs</Badge></div><div className="history-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Search runs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search goals or run IDs…" /></div><div className="segmented">{[['all', 'All runs'], ['attention', 'Need attention'], ['finished', 'Finished']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}</div></div><div className="card history-table-wrap"><table className="history-table"><thead><tr><th>Operation</th><th>Mode</th><th>Outcome / state</th><th>Started</th><th>Duration</th><th><span className="sr-only">Inspect run</span></th></tr></thead><tbody>{items.map((run) => <tr key={run.id}><td><button className="table-run-link" onClick={() => onSelect(run)}><strong>{TASKS[run.task].short}</strong><code>{run.id.slice(0, 20)}</code></button></td><td><span className="table-mode">{run.mode === 'replay' ? <Play size={13} /> : <Sparkles size={13} />}{humanize(run.mode)}</span></td><td><Badge tone={status(run).tone}>{status(run).label}</Badge></td><td><span>{time(run.createdAt)}</span><small>{new Date(run.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</small></td><td className="mono">{elapsed(run, now)}</td><td><button className="icon-button" onClick={() => onSelect(run)} aria-label={`Inspect ${TASKS[run.task].short} run ${run.id}`}><ArrowUpRight size={17} /></button></td></tr>)}</tbody></table>{!items.length && <Empty icon={<History size={25} />} title={runs.length ? 'No runs match this view' : 'Your first run starts the record'}>{runs.length ? 'Try another search or filter.' : 'Start an operation in the workspace to see its progress and results here.'}</Empty>}</div></>;
}

function ProviderSettings({ state, pending, onSave }: { state: AppState; pending: string; onSave: (body: { provider: Provider; model: string; apiKey: string; baseUrl?: string }) => Promise<void> }) {
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState(state.providers.find((item) => item.id === 'openai')?.model || MODEL_DEFAULTS.openai);
  const [apiKey, setApiKey] = useState(''); const [baseUrl, setBaseUrl] = useState('');
  const selected = state.providers.find((item) => item.id === provider);
  return <><div className="page-heading"><div><div className="eyebrow"><Settings2 size={13} />WORKSPACE SETTINGS</div><h1>Ready for real discovery.</h1><p>Connect a model provider and inspect the runtime on this computer.</p></div><Badge tone={state.runtime.browserAvailable ? 'success' : 'warning'}>{state.runtime.browserAvailable ? 'Browser available' : 'Browser required'}</Badge></div><div className="settings-grid"><section className="card provider-settings"><div className="card-heading"><div className="section-title"><KeyRound size={17} /><h2>Discovery providers</h2></div><span className="subtle">Process memory only</span></div><div className="provider-statuses">{state.providers.map((item) => <button key={item.id} className={`provider-choice ${provider === item.id ? 'selected' : ''}`} onClick={() => { setProvider(item.id); setModel(item.model || MODEL_DEFAULTS[item.id]); setApiKey(''); setBaseUrl(''); }}><strong>{PROVIDERS[item.id]}</strong><span><i className={item.configured ? 'configured' : ''} />{item.configured ? 'Configured' : 'Not configured'}</span></button>)}</div><p className="provider-help">Configured means a key is present, not that access has been verified. A valid provider key is required for discovery; replay works without one.</p><form onSubmit={async (event) => { event.preventDefault(); await onSave({ provider, model, apiKey, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }); setApiKey(''); }}><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} required maxLength={100} spellCheck={false} /></label><label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selected?.configured ? 'Enter a key to replace the active configuration' : 'Enter your provider API key'} required autoComplete="off" spellCheck={false} /><span className="field-hint">Keys entered here are held by the local server in memory and are never returned to this screen.</span></label><label>Base URL <span className="optional">optional</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Use the provider’s default endpoint" spellCheck={false} /></label><div className="settings-save"><p>Discovery makes real API requests. Your provider may charge for usage.</p><button className="button primary" disabled={!!pending} type="submit">{pending === 'provider-save' ? <Spinner /> : <Check size={15} />}Save configuration</button></div></form></section><div><section className="card runtime-card"><div className="card-heading"><div className="section-title"><Monitor size={17} /><h2>Local runtime</h2></div></div><dl className="runtime-facts"><div><dt>Execution</dt><dd>This computer</dd></div><div><dt>Application</dt><dd>{state.target.name}</dd></div><div><dt>Data</dt><dd>Synthetic records only</dd></div><div><dt>Browser</dt><dd>{state.runtime.browserAvailable ? 'Available' : 'Not found'}</dd></div>{state.runtime.browserPath && <div><dt>Browser path</dt><dd><code>{state.runtime.browserPath}</code></dd></div>}<div><dt>Local data</dt><dd><code>{state.runtime.dataPath}</code></dd></div><div><dt>Version</dt><dd>{state.runtime.version}</dd></div></dl></section><section className="card settings-note"><ShieldCheck size={20} /><h3>Explicit boundaries</h3><p>Replay runs without a model. Discovery uses the selected provider and the local worker’s policy checks. Risky submission steps pause for an exact-action approval.</p><p>Restarting the process clears keys supplied here. Provider configuration supplied through the environment remains available.</p></section></div></div></>;
}
