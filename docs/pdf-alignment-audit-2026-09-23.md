**Updated PDF alignment audit — 23 September 2026**

**Verdict: yes, the updated project is on the assignment's intended path. Every Section 3 capability has a real implementation or, where expressly allowed, an explicit design. All three previously reproduced defects are now fixed in the exercised cases. No new blocking defect was found in this audit.** Remaining work is focused evidence/documentation cleanup and delivery, rather than adding more product features.

Scope: current working tree over commit `ca2df7d6b2d7d4ae24315a0ce7501512db52eb25`, including the uncommitted remediation and new test files. This is not a verdict on that old commit by itself. The 102 non-ignored files present before this report had aggregate SHA-256 `73a291115a448250b3e8cf58ecd950f62e3031ac03e9e82d0a9b1c76b187b6bf`, computed over the sorted JSON array of `{path, sha256}` entries. The previous audit remains the historical record; this report supersedes its current-status conclusions.

The source requirements were read from the supplied **Assignment A — Computer-Use Automation System.pdf**, especially Sections 3–8 and 11. The audit examined code changes, the existing execution/guardrail paths, tests, public evidence, retained local discovery history, and the newer installation records. Application source was not changed by this audit.

**Verification performed now**

| Check | Result and meaning |
|---|---|
| `npm run typecheck` | Passed. |
| `npm test` | **134 passed; zero failed or skipped.** Includes browser checks and mocked provider tests, not 134 live-model trials. |
| `npm run build` | Passed. |
| `npm run test:e2e` | **All 12 real-Chrome lab integration groups passed**, including restart/reconciliation of an uncertain run buried beneath 105 newer records. |
| `npm run test:mifos:prepare` | **All three actual Mifos cases passed**: missing external reference `167874` returned `NOT_FOUND`; seeded references `10001` and `10002` reached the savings preview. Zero model calls, zero commit events, unchanged savings records. |
| Read-only evidence export | Succeeded under current code from retained member discovery/replay/failure history. **All seven non-manifest files byte-match the public evidence.** Manifest export time is expected to differ. |
| Artifact integrity | Current schema parsing and digest recomputation match the public artifact digest `816d56511d988e4b6af99674e499e93d42e5528d94404d4ec093dd7cc0f9e69a`. |
| New installation evidence | Both source-manifest digests verify. All **82** entries in the newer final manifest match current files. See scope below. |
| Public-source credential-pattern scan | Checked 102 tracked/non-ignored files. Only the deliberate test credential canary matched. No `.env`, private database directory or state key appeared in the public file list. This is a bounded scan, not a security certification. |
| Diff whitespace check | Passed. |

No new paid discovery or Mifos member/account creation was needed. The genuine LLM run is corroborated historical evidence; it was not rerun during this audit. Lab integration tests create temporary fictional records and clean up their state.

**Previous findings: closure evidence**

| Previous defect | Current implementation | Verification |
|---|---|---|
| Lab submitted details could differ from approval | `TargetProfile.validateCommit` is mandatory. The worker denies missing, throwing or rejecting validators. The lab checks each business field against both requested inputs and approved summary, and rejects duplicate/unexpected fields. | The six browser fault cases alter member/product/reference, duplicate a field, remove the validator or make it throw. Each produced **zero saved applications and no `commit_sent` event**. Normal approved submission also passes the lab integration suite. |
| Startup recovered only the latest 100 runs | `Store.unfinishedRuns()` queries unfinished records independently of the paginated history view. | Unit coverage and actual browser reconciliation exercise a run older than 105 completed records. It recovers with `OUTCOME_UNKNOWN`, then reconciles without another submission. |
| Replay executed modified content under an old digest | Admission parses the capability, recomputes its digest, validates any review digest, requires approval metadata for approved discovered artifacts, and executes the parsed snapshot. | Invalid/modified artifacts are rejected before either a browser session or run record is created. |
| Draft/unattended distinction was only a UI label | Default execution rejects drafts; `replayPurpose: "validation"` must be explicit. The desktop and harnesses now supply the correct purpose. | Default draft execution is rejected; explicit draft preparation succeeds without a commit. Business-write approvals remain separate. |
| Completed history could show an active spinner | Terminal completion/recovery clears active step states; the UI handles older records as well. | Updated tests and the live Mifos regression verify no active steps remain after completion. |
| Planning docs misstated implementation status | Reviewer summary now calls Mifos implemented; the blueprint identifies Git/npm and labels cloud/pnpm layout as a historical proposal. | Confirmed in the current diff. |

Primary implementation locations: [engine.ts](../src/server/engine.ts), [store.ts](../src/server/store.ts), [lab.ts](../src/server/targets/lab.ts), [types.ts](../src/server/targets/types.ts), and [audit-regressions.test.ts](../tests/audit-regressions.test.ts).

**Requirement-by-requirement assessment**

“Met” means supported for the bounded local assessment scope. It does not mean production qualification, universal application support or statistical reliability.

| PDF requirement | Status | Evidence and boundary |
|---|---|---|
| 3.1: accept a natural-language goal and target | Met within declared scope | Goal review supports balance, preparation, submission and member creation; configuration selects the registered local target. This is a finite task catalog, not arbitrary natural-language automation. |
| 3.1: real observe → decide → act loop | Met | Provider proposals consume current live observations, and the worker executes observed controls in Chromium. Budgets constrain calls, actions and active time; stalled/repeated waiting yields to a human. |
| 3.1: actual application surface | Met | Independent Mifos X/Fineract target plus separate synthetic fault lab. Runtime business execution and verification use the browser UI. Setup APIs seed fixtures; test APIs may independently inspect persistence. |
| 3.2: ordered, typed, serializable actions | Met | Versioned capability/step schemas, typed locators, input/literal bindings, effects, provenance and digest. |
| 3.2: element identification and robustness rationale | Met with a write-up improvement | Exact roles/labels, rendered form attributes, wizard scoping, uniqueness rejection and business identity checks. The report should describe the actual attribute-first cases more accurately; see remaining items. |
| 3.2: typed invocation parameters | Met | Named input contract plus task-specific exported schemas and runtime validation. Member external references are kept distinct from target-generated numbers. |
| 3.2: typed outputs and extraction | Met | Task output schemas plus semantic binding to requested identity, product, status and dates. Monetary values use decimal strings. Extraction is implemented in compatible target adapters. |
| 3.2: checkpoints, versioning and reviewability | Met | Intermediate/final business checks, immutable content digest, source provenance and evidence-backed review. Replay now validates content before execution. |
| 3.3: replay without model decisions | Met | Separate replay interpreter; current lab/Mifos checks and public changed-input evidence show zero calls. No silent model fallback. |
| 3.3: stable targeting and success verification | Met for the pinned target | Unique visible matches, explicit SPA readiness, selected-record checks and validated terminal outputs. Scope is not arbitrary versions, framesets or native applications. |
| 3.3: business outcomes, recoverable conditions and hard failures | Met for demonstrated cases | `NOT_FOUND`, duplicate member and validation/permission outcomes are distinguished from interventions and failures. Session repair, notices, stop/races and uncertain-write reconciliation are tested. Mifos coverage is narrower than the deliberately injected lab coverage. |
| 3.3: structured debuggable result | Met with observability limits | Outcome/effect/step state, private error context, expected artifact checkpoint and structural evidence exist. Event-to-step linkage and public recovery detail could improve. |
| 3.4: configurable allowlist | Met for local profiles | Configured loopback origin, profile request classes and supported action types. Ordinary read methods are broadly allowed inside the permitted origin; this is not a separate allowlist for every screen/control. |
| 3.4: conservative treatment of risky actions | Met | Exact-preview approval, ownership/epoch checks, expiration, single-use permits and mandatory outgoing-body validation. Preparation has no commit authority. |
| 3.4: secrets/sensitive data kept out of portable artifacts and logs | Met within fictional-data scope | Public projections redact private values; exporter rejects credential-like and invocation-specific literals; private recovery is encrypted separately; persistent screenshots are masked. Same-user key access and provider-visible discovery data are documented limitations. |
| 3.5: what/why evidence and richer failure signal | Met, minor gap remains | Exported step records retain safe purpose labels; actor/time/outcome and sanitized failure structure are available. New replay purpose is omitted from redacted exports, as detailed below. |
| 3.6: detect and route intervention | Met | Worker raises contextual interventions for stuck discovery, unsafe states, account ambiguity and approval. Operator receives current goal/step/reason/live state. |
| 3.6: human controls the same live session | Met | Serialized manual input, ownership epochs, frame checks and quiescence before takeover. Current lab integration confirms same-session repair; historical Mifos recovery evidence is retained. |
| 3.6: hand control back and preserve context | Met | Resume revalidates target/identity; manual events remain in history. Assisted discovery withholds artifacts because manual transitions are not compiled. |
| 3.7: design for legacy/native surfaces | Met as a design deliverable | REPORT explains an observe/resolve/act/checkpoint seam and visual/native requirements. Current interfaces still use Playwright types; native support needs implementation work, not just configuration. |
| 3.7: multi-tenant reuse and drift | Met as a design deliverable | Vendor profiles, tenant bindings, reviewed variants, evidence and isolation limits are described. Tenant infrastructure need not be built under the PDF. |
| 4–5: genuine LLM discovery and complete vertical slice | Met by retained evidence | Live OpenAI member discovery: 14 calls; changed-name/reference replay: zero calls; separate approvals; one creation per run. The exported failure replay makes no commit. Evidence is corroborated by read-only re-export from retained history. |
| 6: README setup/config/offline path | Met | macOS/Node/Chrome/Docker prerequisites, provider configuration, offline lab, target lifecycle and exact demo commands are present. |
| 6: exact discovery → saved artifact → replay demo | Met | `test:member:discovery` runs the real goal, persists its artifact and replays it for different inputs, with explicit validation purpose. Isolated setup/environment-path plumbing remains cumbersome but documented. |
| 6: REPORT with the seven specified headings | Met | Correct headings/order, approximately 1,217 words; page length depends on rendering. |
| 6: public evidence package | Met, installation update recommended | Artifact, discovery/replay logs, schemas, fictional inputs/outputs and exceptional replay exist. Newer setup results are still only in ignored local history. |
| 6 and 11: public GitHub source and emailed URL | Open delivery work | No remote is configured locally. Publication and submission are not established by this audit. |

**Remaining items, ordered by relevance to delivery**

1. **Include the complete working change in the deliverable.** HEAD is unchanged from the previous audit. Nineteen tracked files are modified, and the new regression tests and Mifos prepare harness are untracked. A checkout of the current committed revision would still contain the old defects. Include `tests/audit-regressions.test.ts` and `tests/mifos-prepare-e2e.ts` along with the implementation changes when preparing the final commit. This is a delivery issue, not a failure of the current working tree.

2. **Publish a sanitized record of the newer clean installation.** The newer local qualification at `.local/validation/interface-assessment-1790173908173/` records successful `npm ci`, typecheck, build, empty isolated Docker initialization, 12 initial fixture writes and zero repeat writes. Its initial and final manifests are valid; only `src/ui/App.tsx` changed between them. The final manifest's 82 entries all match current files. The remediation note records rebuilding that final UI change; this audit independently built the current tree successfully. Downloads reused caches.

   However, `evidence/fresh-setup.json` still describes the older 73-file snapshot, **33 of whose entries now differ**. That historical evidence is honestly labeled and remains valid for its own snapshot. Export a sanitized new summary/manifest so the public reviewer can verify the post-fix setup rather than relying on a private path. Do not publish its raw environment, database or key. A second clean Docker installation was not run during this audit because the newer retained qualification already covers the current runtime files.

3. **Preserve replay purpose in public audits.** Low-priority code/observability issue. `Engine.create` records `replayPurpose`, and the desktop displays it, but [privacy.ts](../src/server/privacy.ts), lines 64–77, omits it from `redactRun`. The evidence exporter uses that projection too. A direct check with `replayPurpose: "validation"` produced an export with no purpose field. Include this non-sensitive enum so public logs can distinguish validation from approved execution. This omission does not bypass the admission or commit controls.

4. **Make the locator explanation precise.** REPORT says locators prefer exact accessible roles/names and describes attribute targeting as a response to unlabeled controls. In [surface.ts](../src/server/surface.ts), line 56, a valid `formcontrolname` attribute actually takes precedence for inputs/selects even when labels exist. The public artifact has nine CSS locators and five role locators among 14 targeted actions. Explain why form attributes, active-panel scopes, uniqueness checks and business checkpoints are appropriate for the pinned Mifos version. Neither a fallback chain nor a CSS-free artifact is required by the PDF.

5. **Synchronize the reviewer-facing status.** The remediation note has current results, but the primary validation/readiness pages still emphasize the older milestone. Point them to this verified post-fix status and clarify the new execution-versus-validation admission rule in REPORT. Retain historical logs as historical, rather than replacing them with a claim that the old discovery was rerun on this code.

**Scope and optional goals**

The PDF rewards a coherent, correct vertical slice and explicitly does not reward infrastructure breadth. There is no assignment-driven reason to add cloud deployment, queues, organization login, native automation, Windows packaging, voice, more providers or more banking tasks now. The design for native and tenant reuse is required; building them is not.

The approval-state portion of the optional confidence/approval goal is now meaningfully enforced: ordinary execution requires an approved artifact, drafts require explicit validation, and discovered approvals bind a review digest. Qualification is based on successful different-input cases; it is not a measured reliability score or repeated-trial benchmark. The API also exposes capability information and accepts typed run requests. Further optional expansion is lower priority than delivering the already-tested slice clearly.

Limits of this audit: no fresh live-model discovery, no new Mifos write workflow, no cold-download installation, no external repository/email verification, no statistical reliability measurement, and no production/tenant security certification. The fresh checks plus retained evidence support assessment readiness for the declared local scope, subject to the delivery items above.
