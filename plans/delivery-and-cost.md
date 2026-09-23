# Delivery sizing and operating-cost assumptions

Status: revised browser-first decision, 23 September 2026. A local implementation now exists; no cloud capacity or cloud bill has been measured. This document accompanies [system-design.md](system-design.md) and the ten-stage [implementation blueprint](implementation-blueprint.md).

## Current deployment and budget decision

Run the browser on the laptop now. There is no VM, cloud deployment or recurring cloud-hosting prerequisite for the current local build. Its costs are local compute/storage and any actual model-provider usage. A browser still requires compute; moving it to a server changes where that cost is paid.

For a later **single trusted-tenant, synthetic-data pilot**, use one shared Linux host for the control service and supervised, sandboxed Chromium worker processes or qualified containers. Start with at most two active sessions and queue excess work; replace that initial limit with measured capacity. A host can serve multiple runs over time and concurrent browser workers within that limit. The host may itself be a rented VM, but each run does not require its own VM. Keep the browser sandbox enabled. Linux container compatibility and safe resource limits require qualification before deployment. [Playwright container guidance](https://playwright.dev/docs/docker), [Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/).

This topology accepts a single-host failure domain for the pilot. Add availability, institutional networking and stronger isolation when the scope needs them. A browser context provides session-state separation, not an untrusted-tenant security boundary; stronger qualified isolation is a prerequisite for that rollout. No resources are provisioned by this document. A US business context does not choose the hosting region or authorize moving real customer data.

The **$500–550/month worksheet below is historical and superseded as the default**. It costed a larger AWS topology with Fargate, RDS, ALB, NAT, per-session EC2 workers and a separate target host. It remains a comparison scenario, not a universal minimum or a quote for the revised pilot.

## Lean browser deployment cost formula

Use a provider quote for the measured host size and chosen region. No replacement dollar range is asserted without that quote and a capacity test.

```text
Monthly pilot cost = host charge
                   + storage and backup not included in the host plan
                   + billable network delivery above any included allowance
                   + logs, secrets, DNS and other separately billed services
                   + actual discovery-model usage
                   + target application hosting, if we operate that target
                   + explicitly chosen contingency

host charge = quoted monthly host price
           OR actual allocated host-hours × quoted hourly rate
           (use the applicable billing model, not both)

streamed GB = measured encoded bytes/second × connected viewer-seconds / 10^9
```

For an always-on shared host, do not multiply the full host price by the run count or add session-hours already included in that host charge. Human waiting consumes capacity and may add stream traffic even when the browser is idle. Concurrent viewers increase delivery volume. A remotely operated application still needs its own hosting; if the customer supplies it, that bill is outside our service rather than disappearing.

Capacity is a measured constraint: host RAM must cover the OS/control service, retained sessions, active browsers at representative peak memory, and safety headroom. Reserve CPU for encoding and responsive human control. Test the actual target and long interventions; average session memory and the two-session laptop cap are not cloud capacity guarantees. The one-host pilot does not include redundant capacity or a managed database unless separately selected.

## Earlier broader-product effort estimate

The engineering table and illustrative dates below are the earlier inception-to-release estimate for the broader cloud product. They are retained for scope context, not a claim that the local implementation still needs this entire effort. Re-estimate remaining work after the shared-host browser qualification; a smaller hosting topology does not remove approval, replay, handoff or verification work.

The assignment says there is no deadline and asks for a focused end-to-end implementation; it does not require dated milestones or a hosting estimate. The estimates here address the user's broader request: a serious macOS product with cloud execution, an initial target application, real discovery/replay, approval and live takeover, tenant-scoped access, evidence and deployment.

Assume one experienced full-time engineer using AI-assisted development, with a product/QA collaborator available roughly one day per week for reviews and operator exercises. An engineering day is about eight working hours. AI assistance is included in the estimate; it is not an additional assumed speed multiplier. Cloud/model accounts and macOS signing credentials must be available when needed. Institution procurement, private-network approvals, legal/security certification and production bank onboarding are outside this schedule.

This is a synthetic-data pilot estimate. It does not include native Windows application automation, broad application coverage, a high-availability production service or an independently certified security posture. The Windows desktop client is a later packaging/QA milestone, separate from a native Windows worker.

## Engineering effort

| Blueprint stage | Engineering days | Principal uncertainty |
|---|---:|---|
| 1. Target and worker feasibility | 2–3 | Pinned Mifos/Fineract compatibility; sandbox and live input |
| 2. Contracts and conformance harness | 3–4 | Artifact and effect semantics |
| 3. Session worker and policy kernel | 4–6 | In-flight action cancellation, ownership and redaction |
| 4. Deterministic replay | 3–5 | Exceptional UI states and uncertain mutations |
| 5. macOS operator experience | 4–6 | Streaming, identity, accessible controls and packaging conventions |
| 6. Provider comparison, discovery and compilation | 3–4 | Adapter compatibility and reliable parameter binding |
| 7. Real human intervention | 4–6 | Races, approvals, handback and reconnect |
| 8. Capability/tenant qualification | 3–5 | Failure coverage and evidence leakage |
| 9. Cloud deployment and packaging | 4–6 | Provisioning, routing, cleanup and signing |
| 10. Release evidence and report | 2–3 | Clean-machine reproducibility and discovered defects |
| **Base effort** | **32–48** | |
| **20% planning contingency, rounded** | **7–10** | Integration and rework |
| **Budgeted engineering effort** | **39–58** | **Approximately 8–12 working weeks for one engineer** |

The product/QA contribution is additional: approximately 8–12 collaborator-days over this period, not included in engineering-day totals. A second engineer may parallelize the UI and runtime tracks after contracts stabilize, but the schedule does not assume a linear speedup. Re-estimate after the feasibility spike and after the first genuine discovery-to-replay run.

Development labor budget is `engineering days × agreed engineering day rate + collaborator days × agreed collaborator day rate`. No rate or total labor price is implied.

## Illustrative milestones

The dates below assume a hypothetical Monday 28 September 2026 kickoff. They are planning windows, not an agreed start date, delivery promise or scheduled task. Relative weeks are authoritative if kickoff changes.

| Milestone | Target window | Illustrative completion | Acceptance evidence |
|---|---|---|---|
| Target and worker feasibility | Week 1 | 2 October 2026 | Pinned target, verified Preview/Submit effects, secure browser and real manual input |
| Execution foundation | Weeks 4–6 | 23 October–6 November | Contracts, worker ownership, initial deterministic replay and usable desktop shell |
| Complete discovery/replay/handoff slice | Weeks 6–9 | 6–27 November | Genuine discovery, different-input replay, real same-session takeover and unknown-effect case |
| Deployed synthetic-data pilot | Weeks 8–11 | 20 November–11 December | Authenticated cloud session, reconnect, cleanup, tenant tests and signed macOS client |
| Qualification and release package | Weeks 8–12 | 20 November–18 December | Measured outcomes/costs, sanitized evidence, reproducible README and concise report |

Do not compress verification to preserve a date. If the first spike fails, settle the target/worker choice before implementing dependent features. If provider comparison reveals that the common action interface cannot support safe discovery, adjust the adapter and repeat the evaluation before selecting a provider.

## Historical larger AWS deployment scenario — superseded default

Everything from this heading onward belongs to the earlier per-session-VM scenario, including its unit rates, workload arithmetic and sensitivity estimates. It does not describe the current shared-host recommendation. The scenario used USD, US East (N. Virginia), Linux/x86 on-demand pricing, 730 hours/month, no discounts/free-tier assumptions and no taxes. That region was a pricing assumption, not a deployment decision. Recheck all prices before using this historical comparison.

Workload assumptions:

- 1,000 total browser runs per month, including discovery, qualification and ordinary replay.
- Five minutes of execution per run, plus three minutes of allocated startup/cleanup time.
- 20% of sessions retain their worker for ten extra minutes of human waiting.
- Maximum five concurrent sessions; no permanently warm spare worker in the baseline.
- One browser session per VM, with a 20 GB ephemeral root volume deleted after use.
- One small always-on API/gateway, load balancer, managed Postgres database and controlled private-network egress.
- The Mifos X web app and its Fineract/database target stack are separately hosted and costed.

Allocated worker hours are:

```text
H = runs × (execution minutes + allocated startup/cleanup minutes
            + intervention fraction × extra waiting minutes) / 60
  = 1,000 × (5 + 3 + 0.20 × 10) / 60
  = 166.67 worker-hours/month
```

Three startup/cleanup minutes is an estimate to replace with the full billed VM lifetime from the spike. A five-session concurrency cap does not mean paying for five always-on VMs. If the allocator uses standing hosts or minimum capacity, bill those idle hours explicitly instead.

The following categories must be included in the monthly total: API compute, database/storage, load balancer/capacity, worker compute/root storage, target application hosting, private-network hourly/data charges, internet delivery of live frames, logs/evidence/backups/secrets and model discovery. Exact rates and rounded allowances follow in the completed worksheet below.

### Historical itemized monthly worksheet

Rates were checked against AWS primary pricing material on 23 September 2026 except the explicitly assumed internet-egress unit rate. Monthly amounts are calculated, rounded estimates. Resource sizes and traffic volumes are assumptions requiring the feasibility spike; published unit rates do not validate capacity.

| Item | Calculation / basis | Monthly USD |
|---|---|---:|
| API/gateway, Fargate Linux/x86 | 1 vCPU + 2 GiB, 730 hours | 36.04 |
| Application Load Balancer | $0.0225/hour + assumed 1 average LCU at $0.008/hour, 730 hours | 22.27 |
| RDS PostgreSQL, Single-AZ | db.t4g.small at $0.032/hour × 730 + 20 GB gp3 at $0.115/GB-month | 25.66 |
| One NAT gateway | $0.045/hour × 730 | 32.85 |
| NAT data processing | Assumed 100 GB × $0.045/GB | 4.50 |
| Public IPv4 addresses | Two ALB addresses + one NAT address × $0.005/hour × 730 | 10.95 |
| Active browser workers | c7i.large, 2 vCPU/4 GiB, $0.08925/hour × 166.67 hours | 14.88 |
| Worker root volumes | 20 GB gp3 × $0.08/GB-month × 166.67/730; deleted after use | 0.37 |
| Internet delivery of live frames/results | Assumed 200 billable GB × **planning rate** $0.09/GB | 18.00 |
| **Automation infrastructure subtotal** | Rounded sum | **165.52** |
| Separate synthetic target host | m6i.xlarge, 4 vCPU/16 GiB, $0.192/hour × 730 + 50 GB gp3 × $0.08 | 144.16 |
| Logs and metrics | Low-use allowance, not a measured usage bill | 5–15 |
| Evidence storage, requests and small backups | Low-use allowance | 1–5 |
| Keys and secrets | Small number of keys/secrets and modest request volume; allowance | 3–10 |
| Image registry and DNS | Allowance; add actual domain registration separately | 0–5 |
| **Calculated hosting range** | Infrastructure + target + allowances | **318.68–344.68** |
| **Rounded hosting provision** | Allows minor rounding and low-use variability | **320–350** |
| Discovery-model spending allowance | Chosen budget allocation; not a quote or predicted cost per run | **100** |
| **Operating provision before contingency** | Hosting provision + model allowance | **420–450** |
| **Historical planning budget with 20% contingency** | Superseded default; rounded from $504–540 | **About 500–550/month** |

The $0.09/GB internet rate is a planning assumption supported by an AWS US-region pricing example, not a separately verified N. Virginia rate quote. Confirm the chosen delivery route and account pricing before deployment. The model intentionally counts 200 billable GB without a free allowance; any applicable transfer allowance can lower the bill. Additional IPv4 addresses, traffic, capacity or regions must be added rather than hidden inside the subtotal.

Primary pricing references: [Fargate](https://aws.amazon.com/fargate/pricing/), [ALB](https://aws.amazon.com/elasticloadbalancing/pricing/), [RDS PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/), [EC2 on-demand](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS](https://aws.amazon.com/ebs/pricing/), [VPC/NAT/public IPv4](https://aws.amazon.com/vpc/pricing/). Specific EC2/RDS SKU rates were checked through AWS's public pricing data; the service pages describe the corresponding billing terms. Reprice the deployment in the [AWS Pricing Calculator](https://calculator.aws/) once the tested sizes are known.

Regional data used for the rate checks: [AWS EC2 price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2.json), [AWS RDS PostgreSQL price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/rds/USD/current/rds-postgresql-ondemand.json), [AWS EBS price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json), [AWS NAT price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/natgateway.json). These are live feeds and can change after the estimate date.

### Sensitivities in the historical AWS scenario

- **Warm capacity:** one additional idle c7i.large worker for 730 hours adds about $65.15 compute plus $1.60 for a 20 GB root volume. Add only idle capacity-hours beyond the already-counted active hours; do not double-count busy time.
- **Human waiting:** each additional minute on every one of 1,000 runs adds 16.67 VM-hours, about $1.49 of worker compute at the chosen rate, plus storage and any streaming. Several permanently retained sessions have a very different bill from short interventions.
- **Image pulls:** baseline assumes the pinned worker image is baked into its AMI. Pulling a 1 GB image over NAT for every run adds approximately 1,000 GB × $0.045 = $45/month of NAT processing, before registry, transfer and additional startup costs.
- **Browser memory:** 4 GiB per session is a starting measurement point, not established sufficiency. If the actual application needs a larger instance, replace the worker rate and repeat concurrency tests.
- **Target memory:** the target allowance provides 16 GiB for a combined synthetic Mifos web/Fineract/database stack, separate from the control-plane RDS instance. This is a proposed test-host size, not a supported production banking configuration. Resize from measured heap, database and disk behavior.
- **Database CPU:** db.t4g.small is burstable. Sustained CPU credits, a larger database, more storage or extra backup retention increase the baseline. It is not a production sizing commitment.
- **Availability:** one API task, a Single-AZ database and one NAT gateway are pilot choices. Additional replicas, Multi-AZ storage/database, zonal egress and private institutional connectivity need a separate budget and availability design.
- **Delivery route:** streaming bandwidth depends on frame size, rate and how long a viewer is connected. Cross-AZ traffic, interface endpoints or a different gateway/media route may add charges. Measure encoded bytes rather than extrapolating from screen resolution alone.

Model cost must eventually use measured usage:

```text
Model cost = sum over discovery requests(
    billable input/image usage × applicable rate
  + billable output/reasoning usage × applicable rate
  + any provider tool/session charges
)
Cost per reusable capability = all discovery, retry, qualification-worker
                              and review costs / accepted capabilities
```

The $100 allowance does not guarantee that a particular number of discovery attempts will fit. Apply a run budget and a project spending limit, stop new discovery when exhausted, and reprice after the provider comparison. Deterministic replay has no model-decision cost, but retains worker, network and operational costs.

Excluded from the monthly table: engineering/product/QA labor; paid operator time; premium support; developer-program/signing fees; paid macOS CI; domain purchase; taxes; private VPN/Direct Connect or customer network changes; third-party audits; Windows workers; and production redundancy. These are explicit additions when the relevant scope is approved. No infrastructure has been provisioned by preparing this estimate.
