# Architecture

Interface runs a real, sandboxed Chromium browser on the operator's laptop. Electron/React provides the goal box, live view, approvals and history; a loopback Fastify worker owns execution; SQLite holds durable state. The target is the Mifos X web app, backed by local Apache Fineract/PostgreSQL. Its synthetic US members and USD products supply the assessment context; Mifos itself is an international platform. Docker hosts the target, not a separate virtual desktop per session.

Natural-language review resolves four supported tasks: balance, savings preparation, reviewed savings submission, and member creation. Discovery sends observed controls, screenshots and declared inputs to a provider adapter. The model chooses actions; the worker resolves the observed control, enforces policy, executes, and verifies business checkpoints. Replay interprets the resulting contract without a model. Target profiles contain application semantics, identity checks, exception detectors and request policy; Playwright provides the browser surface. Setup alone uses Fineract APIs to create fixtures. Business execution and verification use the UI.

The compact local architecture makes ownership and failure behavior testable without cloud infrastructure. OpenAI was exercised live; Anthropic and Google protocols have mocked tests, not comparative qualification. The [included member discovery](evidence/member-discovery/manifest.json) used 14 OpenAI `gpt-4.1` calls, then replayed with a different name/reference and zero calls. Both paused for separate approvals and created one fictional member. [Fresh setup](evidence/fresh-setup.json) began with empty, separate database volumes; repeated setup made zero writes. Cached downloads were reused.

# Artifact schema

A versioned JSON capability declares its target, task, named input/output contracts, ordered steps and provenance. Steps contain an action, typed locator, literal or input binding, effect classification and optional checkpoint. The [actual artifact](evidence/member-discovery/artifact.json) searches for an unused member reference, fills parameterized identity fields, verifies the preview, submits once, then verifies persisted identity. It contains no model transcript or invocation-specific names/references. Worker-generated purpose labels explain the recorded actions.

Locators prefer exact accessible roles/names. Mifos's unlabeled controls use observed attributes and active-wizard scopes; ambiguous matches stop. Checkpoints verify the selected business record rather than treating a successful click as success. [Exported JSON Schemas](evidence/member-discovery/contract-schemas.json) describe task-specific inputs and outputs; runtime validation additionally binds outputs to requested identity, product, dates, currency and status. Money uses decimal strings. Partial checkpoint state is separate from terminal successful output validation.

The immutable content digest excludes mutable registry review state. A discovered contract starts as a draft; approval requires its genuine source and a successful different-input replay of that exact digest. Authored baselines are separately labeled. Historical artifact contents/digests are preserved when adding contract descriptions. Qualification is evidence for review, not a statistical reliability claim.

# Determinism & error handling

Replay executes the saved steps with zero model decisions. It waits for specific visible SPA destinations, rechecks identity after asynchronous reads, and fails on missing or non-unique controls. There is no model fallback or automatic rediscovery during replay. Terminal schema validation precedes success, artifact publication and confirmation of side effects.

Results distinguish success, known business outcomes, recoverable interventions, failures and cancellation. Examples include an absent member or duplicate reference, an expired session or unexpected dialog, and an incompatible observation or policy violation. Multiple eligible accounts require an explicit choice, followed by fresh ownership verification. Logs retain step state, expected checkpoint, outcome and actor; sanitized failure snapshots retain layout/control structure. Exact private context remains available to the local operator.

A submitted request with lost confirmation has `effect: unknown`. Neither replay nor request deduplication can guarantee exactly-once behavior in an external UI. Reconciliation uses read-only UI checks for the exact identity/reference; restart creates a fresh recovery session and never resubmits. Output validation failure after a possible write also preserves uncertainty. Stop prevents future dispatches but cannot reverse accepted requests.

# Heterogeneity & multi-tenant

The current implementation supports two browser profiles: Mifos and the separate fault-injection lab. A future surface adapter would provide observe, resolve, act, checkpoint/extract, quiesce and session-health operations. Native accessibility controls can implement that seam. A visual resolver would require window identity, bounded anchors, uniqueness thresholds and postconditions; stored coordinates alone are insufficient. No native automation is claimed today, and existing CSS artifacts would need compatible surface bindings.

The planned reuse unit is a vendor workflow plus a versioned surface profile and a tenant installation binding. Bindings supply entry point, credential references, locale/product mappings and validated locator substitutions. They cannot weaken identity checks, approval boundaries or success predicates. Material workflow differences create reviewed variants. Version/screen invariants and per-installation replay evidence gate promotion; drift quarantines the affected binding.

Tenant authorization, scoped storage, fair queues and isolated worker credentials are design work. Local browser contexts separate session data but are not an untrusted-tenant security boundary. A trusted pilot can share a supervised browser host; stronger sandbox/container or microVM isolation must be qualified before untrusted co-location. No per-session VM is required for this assessment.

# Escalation & handoff

The worker detects target exceptions and bounds discovery to 30 requests, 24 actions and five active minutes, with repeated no-progress limits. It raises an intervention carrying the goal, step, reason and live state. Approval/human waiting time does not consume execution budget.

Ownership lives in the worker. Take control cancels pending model transport, drains automated input, revokes approval and advances an epoch before accepting manual commands. Commands bind the current session, ownership epoch and displayed frame. The human operates the same live browser. Handback closes manual input, validates fresh target/identity state and resumes at a verified boundary. The [real Mifos recovery checks](docs/validation.md#assessment-completion-pass--23-september-2026) verify explicit account selection and repair an intentionally incorrect application reference on the same page/session without model calls or business commits. Human-assisted discovery withholds reusable artifacts because manual transitions are not yet compiled.

# Safety

Each profile defines permitted origin/routes, controls and request classes; the configured target must be loopback. Requests outside the profile are denied. Commit authorization is single-use, expiring and bound to the exact preview, inputs, session and capability. The worker rechecks the preview and exact permitted request body immediately before dispatch. Keyboard/manual input cannot bypass the network gate. Preparation has no commit authority.

The [data policy](docs/evidence-privacy.md) separates the live operator view, encrypted private recovery state and redacted audit evidence. AES-GCM state binds each record ID; its filesystem-restricted local key is separate from SQLite. Audit logs omit identities, raw goals/errors, credentials and approval tokens. Persistent screenshots hide text, form values and media; structural snapshots omit content. Legacy histories migrate without changing artifact digests. The adjacent key does not protect against another process with the same user's access, and migration cannot erase old backups.

The read-only evidence exporter selects explicit fictional runs, validates schemas/digest/qualification, and refuses credential-like or invocation-specific artifact literals. It never silently edits the original contract. Discovery still sends visible fictional data to the selected provider; it requires appropriate authorization. This implementation is not permission to connect real financial data.

# Cuts

The assessment slice includes real discovery, replay, approval, handoff and evidence. Deliberate limits are finite goal intents, one independent business application, a local single-operator trust model, and case-based qualification. The lab supplies reproducible injected exceptions; provider protocol tests use labeled mocks. There is no cloud deployment, native adapter, Windows qualification, signed installer, automated manual-repair compilation, provider benchmark or repeated-trial reliability estimate.

Next work is broader drift/exception qualification, OS credential storage and retention controls, then packaging and measured worker operations. [README](README.md) gives exact setup/demo commands; [evidence](evidence/README.md) separates genuine live runs from injected tests. Public repository publication and submission remain explicit user actions.
