# Audit remediation — 23 September 2026

The three reproduced correctness defects in [the original audit](audit-2026-09-23.md) are fixed. The original audit is preserved as the historical finding record.

- **Approved request binding:** every target profile must implement a commit validator. The worker blocks a missing, throwing, or rejecting validator before dispatch. The lab validates the exact member, product and application reference against both inputs and the approved preview; unexpected and duplicate fields are rejected. Browser fault tests alter each hidden business field, duplicate a field, and remove or break the validator. All six cases persist zero applications and emit no `commit_sent` event.
- **Restart recovery:** startup queries all unfinished rows independently of the latest-100 history view. The integration test buries an uncertain run beneath 105 completed records, restarts, retrieves it by ID, and successfully reconciles through the read-only UI without another submission.
- **Replay integrity:** the worker parses the complete capability, recomputes its digest, checks the approval-review digest, and executes the parsed snapshot. Invalid artifacts fail before a browser session or run record is created. Approved discovered artifacts require an approval review.
- **Draft admission:** API callers must explicitly select `replayPurpose: "validation"` for drafts. Default execution requires approval. The desktop and verification harnesses select validation explicitly; the run records and displays that purpose. Business writes still require their own exact-preview approval.
- **Terminal progress:** completed and recovered runs clear active step states. The desktop also prevents historical completed runs from showing a spinning active step.
- **Plans:** the reviewer summary now reflects the implemented Mifos integration and four workflows. The blueprint identifies the existing Git/npm layout and separates historical cloud/pnpm proposals from current commands.

The reported prompt was parsed correctly. A read-only check of the normal local Mifos instance found no member with external reference `167874`. Member inputs bind to **External Id**. The default seeded references are `10001` and `10002`; new-member creation is a separate reviewed operation. Missing-member messaging now explains this distinction.

`npm run test:mifos:prepare` reproduced the original request as `NOT_FOUND`, then verified that the same prepare-only prompt for each seeded member reaches the actual savings preview. All three runs used zero model calls, sent zero business commits, and left savings records unchanged. No member was implicitly created or substituted for the original request.

Verification completed:

| Check | Result |
|---|---|
| TypeScript and production build | Passed |
| Full automated suite | 134 passed; zero failed/skipped |
| Final strengthened admission and UI checks | 3 passed |
| Real sandboxed Chrome lab integration | All 12 groups passed, including recovery beyond 100 records |
| Real Mifos prepare-only regression | Missing-member case plus both seeded members passed |
| Fresh public-source installation | `npm ci`, typecheck, build, isolated Docker initialization and repeated setup passed; repeated setup made zero fixture writes |
| Restarted desktop | Ready on port 4317; updated draft admission confirmed with HTTP 409 before execution |

Fresh-install evidence is retained locally under `.local/validation/interface-assessment-1790173908173/`. `evidence.json` records the initial qualification. The final historical-step display change was then copied into that clean checkout, where typecheck and build passed again; `final-source-files.json` records matching hashes for all 82 snapshotted files. This installation used available local caches and does not claim cold-download qualification. This remediation document was added afterward.

The temporary qualification stack on port 4202 was stopped after verification; its database volume and evidence remain available. The normal desktop and Mifos stack on ports 4317/4200 remain running. Existing private history and the public discovery artifact were preserved. Cloud rollout, reliability benchmarking, publication and email submission remain separate work.
