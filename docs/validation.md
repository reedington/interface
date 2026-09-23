# Local validation record

Validation history on macOS arm64 with Node 25.2.1 and installed Google Chrome, 23 September 2026. Earlier sections describe the synthetic lab at that point in development; later sections record subsequent integration work. None of these local checks constitutes production certification.

## Automated checks

- TypeScript typecheck and Vite production build pass.
- **27 tests pass** under `npm test`: typed contracts, restart recovery, provider protocol validation and sanitization, synthetic target behavior, and mocked-model discovery orchestration.
- **11 end-to-end checks pass** under `npm run test:e2e`, against actual sandboxed Chrome and local HTTP services:
  - Replay with two client/account pairs, with zero model calls.
  - Preparation reaches preview without persisting an application.
  - Not-found, permission and validation business outcomes.
  - Exact-preview approval, one dispatch, stale and reused approval rejection.
  - Lost confirmation, worker restart, saved screenshot retention, and read-only reconciliation without resubmission.
  - Same-session human repair for expired sessions and unexpected dialogs.
  - Stale ownership/frame rejection.
  - Stop drains current input and prevents further steps.
  - A superseded takeover cannot resurrect a stopped run.
  - Duplicate request deduplication and conflicting key rejection.
  - Cross-origin mutation rejection and durable history/capability counters.

Some checks cover several related assertions; the command reports eleven integration groups. Tests use temporary state and separate ports.

## Visible desktop and browser checks

Launched the actual Electron app through the local launcher. Verified a balance run, live-image click to restore a session, return to automation, reviewed submission and confirmed result, capability inspection, and run history. In the browser view, verified Settings, an unconfirmed submission and its reconciliation result. No browser console errors were reported during that check. The narrow 717-pixel browser view had no horizontal page overflow.

Fixed unnamed navigation controls at narrow widths and made result field names readable. Submission network enforcement also covers keyboard-driven form requests. Latest UI progress wording distinguishes completed input actions from verified business checkpoints.

## Remaining validation boundaries

- OpenAI balance, preparation and approved-submission discovery and different-input replay have succeeded live, plus same-session repair of an expired session (see below). Broader exception qualification, repeated-trial reliability measurement, Anthropic and Google remain outstanding.
- OpenAI, Anthropic and Google adapter protocols are tested with mocked responses. Model orchestration tests use an explicitly labeled local provider test double, not a hidden fallback in the product.
- At this initial lab milestone, no Mifos installation, cloud deployment, Windows release, signed installer, accessibility certification, load test or penetration test had been completed.
- The synthetic target intentionally offers stable semantic labels and business-state markers. External application drift and selector ambiguity need qualification on the real target.
- The desktop launch is a development build. Local screenshots and state are synthetic and are not a production evidence/credential vault.

## Goal-first US update (0.2.0)

The target now uses fictional US credit union members, USD, and formatted dollar balances. A prominent natural-language goal box resolves the supported workflows into a reviewable plan before browser execution. Ambiguous references, unknown products, negated actions, non-USD requests, and conflicting edits require clarification. A goal naming only member 10002 was verified in real Chrome: the UI supplied SAV-1002 and the result was USD 840.00, with no model calls. The original account input remained empty and its UI-derived value was recorded separately. Prior locale-specific artifacts are retained but quarantined.

31 automated tests and 12 real-Chrome integration groups passed for the update. Final targeted goal-parser checks also cover the ambiguity cases above. Visible UI testing verified goal review, start, and invalidation of Start when the goal text changes. The subsequent live-model check is recorded below.

## Live OpenAI discovery and replay — 23 September 2026

An inherited environment key was overriding the newly supplied project `.env` key, causing HTTP 401. The launcher now loads an allowlisted set of project settings with explicit `.env` values taking precedence over inherited values. Startup and doctor share this behavior. Four regression tests cover precedence, missing files, explicit empty values, and exclusion of arbitrary shell/runtime variables. Typecheck, production build, and all **35 automated tests** pass after the fix.

The app was restarted, then tested through the visible workbench against the actual local Chromium session:

| Stage | Evidence | Verified result |
|---|---|---|
| Live discovery | Run prefix `ca4e2264-812b-42b6`; OpenAI Responses, `gpt-4.1`; four model requests; approximately 13 seconds | Member `10001`, account `SAV-1001`, balance `12540.75`, currency `USD`, status `Active`; outcome `DISCOVERED` |
| Recorded artifact | `discovered-ca4e2264`; seven steps including member/account checkpoints; draft status | Member and account locators parameterized; no manual intervention |
| Different-input replay | Run prefix `e2a7257b-c180-4bd5`; same discovered artifact; zero model requests; approximately one second | Member `10002`, account `SAV-1002`, balance `840.00`, currency `USD`, status `Active`; outcome `VERIFIED` |

Both goals omitted the account reference; the worker resolved it through the requested member's visible application page. The capability remains a validated draft for operator review. Screenshots, run events and the artifact are retained in local history. These are two successful synthetic-target runs, not a statistical reliability claim or external-application qualification. Provider billing totals were not measured.

## Bounded discovery and evidence-based review (0.3.0)

The worker now enforces 30 model requests, 24 browser actions and five minutes of active discovery time. Four unchanged observations or three consecutive waits without progress pause discovery. Resuming preserves total usage; approval and human-review time are excluded. Pause, takeover, stop and shutdown abort pending provider transport, and a late response cannot dispatch input. Approved submission reuses the retained action proposal and rechecks the preview without another model call. A deadline expiring during that check cannot leave a commit permit active.

Discovered capability approval now checks durable source and replay records for the exact content digest. A qualifying replay requires a different member and account for balance, or a different member and fresh external reference for applications. Manual repair, reconciliation, same-input success and mutable counters cannot qualify. The server checks the operator's expected digest and records the evidence IDs with the review. UI evidence links load records beyond the latest 100 runs. Authored baselines remain explicitly labeled.

**Final verification:** TypeScript and production build pass; **56 automated tests** and **12 real-Chrome integration groups** pass. Added tests cover prepare/submit recording and changed-input replay, expired or changed previews, deadline/commit races, delayed model cancellation, finite budgets across resume, stuck detection, evidence integrity and old-history lookup. Provider transport in automated tests is explicitly mocked.

Additional live OpenAI and visible workbench checks used fictional US records:

| Workflow | Source / replay run prefixes | Result |
|---|---|---|
| Prepare to review | `f593b009-5ac9-4c2a` / `e93d8c57-8700-4251` | Source: member 10001, Growth Savings, seven model calls. Replay: member 10002, Everyday Savings, zero calls. Both stopped at verified preview; neither reference exists in the target's persisted applications. |
| Submit with approval | `7b2997cf-05d3-4658` / `03f5a148-6a55-4125` | Source: member 10001, Growth Savings, eight model calls. Replay: member 10002, Everyday Savings, zero calls. Each required a fresh exact-preview approval and persisted exactly one Pending Approval application. No extra model request followed source approval. |
| Human recovery | `be6cb575-70ce-4171` | Expired session → take control → click Restore session in the actual live image → hand back the same session → four live model calls → member 10002, SAV-1002, USD 840.00. Outcome `VERIFIED_ASSISTED`; no replay artifact published. |

The live submission artifact `discovered-7b2997cf` was reviewed through its source/replay links and approved with the evidence-backed UI. Approval was disabled before the qualifying replay. Review metadata survived the final worker restart. Preparation and balance artifacts remain validated drafts. The evidence panel had no horizontal overflow in the 717-pixel browser view.

The submission source used reference `CU-0C54CA85` and replay used `CU-C9257A3D`; independent test inspection found one matching persisted record for each. Preparation references `CU-4FD7BE75` and `CU-0107C2CE` had zero persisted matches. Runtime business verification continued to use the target UI only. These checks are local case evidence, not a statistical reliability claim, real account opening, or production release qualification.


## Local Mifos desktop integration — 23 September 2026

The default target is now the independent **Mifos X web app, backed by Apache Fineract and PostgreSQL**, running locally in Docker. Electron and sandboxed Chromium run on the Mac. No AWS resources were created. The explicit lab mode remains available for injected failures; target-specific capabilities, runs and qualification evidence cannot cross between the lab and Mifos.

Final local verification:

- **87 automated tests** and **12 real-Chrome lab integration groups** pass. Typecheck and the production build pass.
- A clean source copy without `.env`, `.local`, installed dependencies or generated assets passed `npm ci`, official Electron provisioning, Electron version verification, typecheck, build and doctor. The copied source used the final patched dependency lock. `npm audit` reported zero known vulnerabilities.
- `npm run setup` passed against the actual Docker stack, preserving the existing `.env`. A repeated seed performed **zero API writes**, preserving one original funding transaction per fixture account. Seeding is the only workflow that uses backend APIs to prepare data; worker business verification uses visible UI.
- **10 real Mifos end-to-end checks** pass under `npm run test:mifos`, including explicit account reads and UI-derived account resolution. Alex Morgan / `10001` / `SAV-1001` returned USD `12540.75`; Taylor Reed / `10002` / `SAV-1002` returned USD `840.00`.
- Growth Savings for member `10001` and Everyday Savings for member `10002` reached the actual preview with **zero savings submission requests**. Approved submission created pending application `000000005` for member `10002`, reference `QA-35a9ea71-732`, with exactly one dispatch. Stale/reused approvals were rejected.
- Tests deliberately hid the known successful submission outcome in the worker, expired its retained login, and then restarted the worker. Both recovery paths reauthenticated through the UI and verified **the same application reference**, with no new savings submission. This is explicitly worker-state fault injection, not a claim of a real target outage.
- Taking control revoked approval; stopping left the form unsubmitted. A separate SQLite mutex prevents a second worker from changing an active worker's history and releases automatically on process death.
- Native Electron 44.4.4 UI testing exercised the natural-language example, Review goal, and Start run against Mifos. Run `91be3460-0317-482d` completed in the desktop with USD `12540.75`, account `SAV-1001`, status Active, and zero model calls.

Local evidence is retained under `.local/validation/mifos-1790129784070/verification.json` and its SQLite/screenshot directory. Fresh-install evidence is `.local/validation/clean-checkout-2026-09-23.json`; these machine-specific artifacts are intentionally git-ignored.

The real image exposed differences from the initial source-derived fixtures: hash routing, a nested Applications menu, legacy visible tooltips, absent account-page member number, and asynchronous account view updates. The adapter binds the prior verified member and route, matches visible account identity, and rechecks identity after asynchronous reads. A regression test rejects mixed old-account/new-fields observations. Reconciliation waits for the exact account selected from the member table before reading business fields.

Images are pinned by digest in `infra/mifos/versions.json`. Fineract reports git tag `1.11.0` and clean commit `843b27926e516420297f40655fa734277195d773`, while its publisher build label says `1.12.0-SNAPSHOT`; both are recorded rather than treating the image tag as proof of its build label. Runtime HTTP readiness is separate from the workflow evidence above.

At the end of that initial pass, automatic approval review had blocked live Mifos discovery pending permission to transmit the fictional screenshots and visible text. The subsequent user-authorized pass is recorded below; earlier live results above still apply only to the separate lab.

## Live Mifos discovery and replay — 23 September 2026

After the user explicitly approved sending the fictional Mifos screenshots and visible text to OpenAI, automatic review accepted the tests. No review policy or submission approval requirement was disabled. All three workflows succeeded with OpenAI Responses / `gpt-4.1` and produced draft contracts that met the existing qualification requirements through different-input, zero-model replays:

| Workflow | Discovery / replay run prefixes | Model calls | Verified result |
|---|---|---|---|
| Balance | `5f372672-cb00` / `65987539-22c8` | 2 / 0 | Member 10001 / SAV-1001 / USD 12540.75; replay 10002 / SAV-1002 / USD 840.00. Both verified dedicated account details. |
| Preparation | `8f5db3f8-5a75` / `5ee0be1b-72f9` | 9 / 0 | Growth Savings for 10001; replay Everyday Savings for 10002 with a fresh reference. Both reached verified previews with zero savings submission requests. |
| Submission | `40469ad9-894c` / `509ad317-a3de` | 10 / 0 | Growth Savings for 10001 and then 10002, with different external references. Each paused for a separate exact-preview approval, sent one submission, and verified its own pending application. |

The submitted records are `000000007` / `QA-c5515499-91c` and `000000008` / `QA-e43b45dd-ada`. These remain pending synthetic applications; they were not approved or activated. Test-harness approvals exercise the same worker gate as the desktop. Qualified draft artifacts were not automatically promoted to approved status.

Live testing exposed three issues before those successful cases. An asynchronous Angular transition let discovery observe the previous member list; an incomplete completion instruction let the model treat a member summary balance as sufficient; and Mifos's optional External ID field led the model to omit a required workflow input. The worker rejected both incomplete outcomes. The adapter now waits for the visible result of the observed navigation action, and discovery explicitly requires account details and the application reference. No scripted fallback or relaxed business verifier was introduced.

Final verification after the fixes: **89 automated tests**, **12 lab browser integration groups**, typecheck, and production build passed. The **10 model-free Mifos checks** were rerun successfully after the transition change; the **six live checks** passed in focused task runs. New regression tests cover delayed member/account rendering and Stop during a pending UI transition. Provider protocol tests also passed after the final prompt clarification. These are successful local cases after debugging, not repeated-trial reliability measurements, a provider comparison, or production qualification; provider billing totals were not measured.

Evidence directories under `.local/validation/` (intentionally git-ignored) contain SQLite records, screenshots, and a `verification.json` summary:

- Balance: `mifos-1790153237849`
- Preparation: `mifos-1790153318034`
- Submission: `mifos-1790153374918`
- Final model-free baseline: `mifos-1790153412304`

The harness now saves progress after every passed check and failure metadata when interrupted. `--discover-only --task=balance|prepare|submit` with `--discover-apps` runs one discovery/replay pair without repeating the baseline. The full `--discover-apps` plan remains 16 checks; no opt-in flags means ten checks with no provider calls.

## New-member onboarding — 23 September 2026

The exact goal **“create an account for me”** now offers new-member and existing-member paths. Selecting a new member opens first-name, last-name and new-reference fields with an optional reference generator. The plan is reviewed before a browser starts; the actual Mifos member preview requires its own single-use approval. Verified creation offers a separate savings-preparation goal without starting it automatically. A browser smoke test covered blank initial fields, a generated editable reference, a hyphenated first name and apostrophe surname, and the existing-member branch. It found one form, no nested forms, no alerts and no browser errors; the smoke test stopped before execution.

`npm run test:member -- --reconcile` passed **six real Mifos checks with zero model calls**. It created fictional Avery Parker, external reference `756182668148`, generated Mifos member number `000000003`, after one exact-preview approval. It rejected a repeated reference before any duplicate write, revoked approval on takeover, stopped a different draft without creating it, and prepared Growth Savings for the created member with no savings submission. An explicitly injected unknown worker result survived restart and reconciled the same member with only read/authentication requests. Evidence: `.local/validation/member-1790154813468-7f0c97c5/verification.json` and its SQLite/screenshot directory.

The adapter verifies the member as an active, non-staff individual in Head Office. Its exact request allowlist excludes simultaneous savings creation, family members, address, datatables, and unreviewed fields. The visible Submitted On date supplies the activation-date input for each replay. Member identity binds the external reference, generated account number, name and route; follow-on savings no longer assumes generated account number equals external ID.

**98 automated tests**, **12 lab integration groups**, typecheck and production build passed. The original **10 Mifos checks** also passed after these changes, with evidence in `.local/validation/mifos-1790154890586/verification.json`. New tests cover member preview/request binding, date handling, generated member numbers, inactive wizard panels, member qualification identity differences, and legacy fixture-manifest upgrades without business writes. At this milestone, live new-member discovery had not run; the subsequent assessment-completion pass below records it.

An opt-in `npm run test:member:discovery` harness covers separate discovery/replay approvals, one creation per run, changed names/references, zero-model replay, and artifact qualification. At this milestone only its help and typecheck had passed; see the later live qualification below. Run it only with an entirely fictional visible member list because discovery transmits visible UI data to OpenAI.


## Assessment completion pass — 23 September 2026

The final code passes **131 automated tests**, typecheck and the production build. The **12 lab browser integration groups** also passed during this pass. Additional tests directly exercise takeover during account revalidation, disappearing choices, rejection of invalid terminal/reconciliation output, redacted audit downloads, encrypted recovery, legacy migration and interrupted plaintext-page cleanup. Runtime version is **0.5.0**.

The [included live member evidence](../evidence/member-discovery/manifest.json) records OpenAI `gpt-4.1` discovery with **14 model calls** and exact-artifact replay with **zero**. Each run received its own exact-preview approval and created exactly one fictional member, with different names/references. A third replay returned `MEMBER_REFERENCE_EXISTS`, with zero model calls or creation requests. The unchanged capability digest is `816d56511d988e4b6af99674e499e93d42e5528d94404d4ec093dd7cc0f9e69a`; it remains a qualified draft. Earlier discovery debugging stopped before submission when the model attempted an incorrect office selection. These are case results, not a reliability benchmark.

[Real Mifos recovery evidence](../evidence/mifos-recovery.json) covers two groups: account choice with stale/foreign-choice rejection, and manual correction of an intentionally wrong external reference introduced by a test-only capability. Repair used worker-mediated human input, then resumed on the same browser Page and session. Both groups completed with zero model calls and zero business commits in the successful run. An earlier fixture-preparation attempt created one separately approved pending savings application to make account selection ambiguous. Login/overlay manual repair belongs to the separate lab tests, not these Mifos checks.

[Fresh setup evidence](../evidence/fresh-setup.json) identifies its exact source snapshot. A clean source copy passed dependency installation, typecheck, build and setup against initially empty, isolated database volumes. First seeding made 12 writes; repeated setup made zero. Cached downloads and already installed host prerequisites were reused. Later source edits are outside that snapshot and covered by the final checks above.

The running user workbench was not restarted because it retained two waiting sessions. The built version is available on the next launch. Public repository publication and submission have not occurred.
