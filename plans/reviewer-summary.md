# Computer-use automation proposal

Build a macOS-first operations console that operates a real Chromium browser. **The current implementation runs on the laptop, with no VM or cloud deployment.** A later single-tenant pilot can run bounded browser workers on one shared Linux host; a separate cloud computer per run is not the default. This decision supersedes the earlier per-session EC2 deployment and budget assumptions.

The source requirements are in [Assignment A — Computer-Use Automation System.pdf](../Assignment%20A%20%E2%80%94%20Computer-Use%20Automation%20System.pdf); the supplied sketches guide the desktop layout. A working local slice now exists. Cloud deployment and production qualification remain future work.

| Decision | Recommendation |
|---|---|
| Desktop and execution | Electron/React; local TypeScript worker, sandboxed Chrome and SQLite now; shared-host browser workers for a later trusted-tenant pilot |
| Target application | Local Credit Union Lab for current synthetic tests; Mifos X web app backed by Apache Fineract for the planned real application integration |
| First capabilities | Read a savings balance; prepare an application to Preview; submit the reviewed application |
| Discovery provider | Compare Anthropic, OpenAI and Google computer-use offerings before choosing a default |
| Production execution | Versioned, policy-checked deterministic replay with independently verified outcomes |

The live panel shows images from the actual headless Chrome worker; human input reaches that same browser. Headless Chrome runs without displaying a desktop window. Browser execution still consumes CPU, memory and network wherever it is hosted. [Chrome headless mode](https://developer.chrome.com/docs/automation-and-testing/headless).

Keep preparation and submission separate. Mifos's Preview must remain distinct from the submission that creates an application awaiting approval. Verify both effects on the pinned release. [Mifos submission implementation](https://github.com/openMF/web-app/blob/dev/src/app/savings/create-savings-account/create-savings-account.component.ts).

A capability records typed inputs and outputs, stable control identification, preconditions, success checks, known outcomes and bounded recovery. A successful discovery creates a draft; replay with different inputs and human review precede unattended use. An unsuccessful replay never silently switches to open-ended model reasoning.

The planned provider comparison uses the same target, tasks, policies and verifier: 72 initial discovery/probe runs across Anthropic, OpenAI and Google, followed by held-out model-free replays. The implemented bounded multimodal adapters are not evidence that this comparison has been completed. Select for verified outcomes and reusable-capability yield before latency and cost. [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [OpenAI](https://developers.openai.com/api/docs/guides/tools-computer-use), [Google](https://ai.google.dev/gemini-api/docs/computer-use).

For a future trusted-tenant pilot, put the control service and supervised browser worker processes or qualified containers on one Linux host, with a queue and measured concurrency limit. Start with the current two-session cap and load-test before increasing it. Keep Chromium's sandbox enabled, restrict browser network access, and expose only the authenticated control/stream gateway. A surviving browser can be reattached after client disconnect; browser death requires a new session and any necessary reconciliation.

Browser contexts separate cookies and storage; they are not our security boundary between untrusted tenants. Before that rollout, qualify stronger container/runtime isolation, microVMs or a managed browser service against the threat model. Firecracker/Kata and gVisor remain options to evaluate, not required pilot infrastructure. [Playwright contexts](https://playwright.dev/docs/browser-contexts), [Chromium Linux sandbox](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md).

Human clarification, action approval, live takeover and policy changes are separate flows. The worker must acknowledge that automation has stopped before granting exclusive human control. Handback verifies the selected record and a known checkpoint. Approvals are single-use, tied to the exact preview and session, and invalidated by relevant changes.

Treat “submission sent, confirmation lost” as an unknown effect. Reconcile through the UI before considering further action: our request idempotency key cannot make an external UI transaction exactly once. Stop prevents future commands; it cannot reverse an accepted transaction.

Preserve the sketches' left navigation, central live session/composer and right-hand verified timeline. Keep institution, application, execution mode, control owner and stream freshness visible. Open-ended goals remain available alongside the reusable-capability catalog.

The earlier **39–58 engineering-day** estimate sizes the broader cloud product from inception; it is not a new estimate of remaining work after the local build. Re-estimate the lean pilot from measured runtime behavior. The assignment imposes no deadline or cost-estimate requirement.

The earlier **$500–550/month is a superseded budget for a larger AWS topology**, including managed services and a separate Mifos target host. It is not the minimum cost of this product. The revised model starts with one measured host, storage/backup, actual frame delivery and discovery usage; target hosting remains a separate line item. No new price or capacity guarantee is assumed.

US business requirements do not automatically select a US hosting region or authorize real customer data. Region, institutional connectivity and data permissions must be explicit before onboarding. The current lab stays synthetic.

See [local architecture](../docs/local-architecture.md), [delivery and cost](delivery-and-cost.md), and [system design](system-design.md) for the implemented boundaries, revised cost formula and remaining release gates.
