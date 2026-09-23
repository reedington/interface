# Assessment evidence

These files are selected evidence from real local runs on 23 September 2026. The target is the Mifos X web app backed by Apache Fineract, using an isolated database of fictional US members and USD products. No mock provider supplied the member discovery result.

## Genuine discovery and deterministic replay

[member-discovery/manifest.json](member-discovery/manifest.json) binds the original artifact digest to its source and replay:

| | Discovery | Replay |
|---|---|---|
| Run | `5449e1b6-4b9f-4794-9391-56a97e0944b2` | `6854fc88-e210-427b-9789-3fd7bf2f6dc3` |
| Model calls | 14, OpenAI `gpt-4.1` | 0 |
| Fictional member | Jordan Ellis | Casey Morgan |
| Generated Mifos number | `000000003` | `000000004` |
| Commit boundary | Separate exact-preview approval | Separate exact-preview approval |

The artifact is `discovered-5449e1b6`, digest `816d56511d988e4b6af99674e499e93d42e5528d94404d4ec093dd7cc0f9e69a`. It remains a qualified **draft**, not an automatically approved capability.

- [artifact.json](member-discovery/artifact.json) — original typed, parameterized capability and digest.
- [contract-schemas.json](member-discovery/contract-schemas.json) — input/output schema descriptions.
- [discovery.json](member-discovery/discovery.json) and [replay.json](member-discovery/replay.json) — redacted time/actor/event/step logs, model counts and effect state.
- [fictional-fixtures.json](member-discovery/fictional-fixtures.json) — explicitly fictional typed input/output values so a reviewer can verify parameter changes and identity binding.

The test harness checked zero member-creation requests before each approval, one afterward, exact returned identity, no extra model request after discovery approval, changed names/references on replay, and qualification of the same digest. Its operator actions exercise the normal worker approval endpoint. These are two successful local cases after debugging, not a reliability benchmark. An earlier discovery attempt stopped after three calls on an incorrect office-field action without a business write; it is not counted as successful evidence.

## Expected business outcome

[failure.json](member-discovery/failure.json) records a replay of the same artifact using the already existing discovery member reference: `fcb5581e-8204-46ab-9a44-2fc85d0d7af1`. It returned `business_outcome` / `MEMBER_REFERENCE_EXISTS`, with zero model calls, `effect: none` and no member-creation request. The unused-reference checkpoint stopped the flow before Create Client; later steps remain pending. This is a real duplicate in the isolated fictional target, not an injected application error. [failure-state.json](member-discovery/failure-state.json) is the sanitized structural snapshot at that boundary.

## Fresh installation

[fresh-setup.json](fresh-setup.json) and [fresh-setup-source-files.json](fresh-setup-source-files.json) record an isolated source checkout and initially empty database. First setup made 12 fixture writes; second setup made zero and preserved the records. Existing download caches were reused. The source manifest identifies the exact tested snapshot; later edits are outside it. See [fresh-install qualification](../docs/fresh-install-qualification.md) for scope and reproduction.

## Reproduce and export

Follow [README](../README.md#assessment-demo-and-evidence) for the exact discovery/replay command. It creates two new synthetic members and makes billed model calls. Replay itself needs no provider. Keep the entire visible target dataset fictional, since discovery can see an existing member list.

Export an explicitly selected pair from retained local history:

```sh
npm run export:evidence -- \
  --data .local/validation/member-discovery-1790158261956 \
  --discovery 5449e1b6-4b9f-4794-9391-56a97e0944b2 \
  --replay 6854fc88-e210-427b-9789-3fd7bf2f6dc3 \
  --failure fcb5581e-8204-46ab-9a44-2fc85d0d7af1 \
  --out /tmp/interface-member-evidence \
  --synthetic
```

The source history is intentionally excluded from the submission; on a new checkout use the IDs printed by your own run. The output directory must not already exist. Optional `--failure <run-id>` includes a stopped non-success replay of the same artifact only when its saved structural snapshot matches the redaction policy. The exporter opens SQLite read-only and does not start a worker, call a provider, recover old runs or change target data.

Public logs omit goals, names, references, raw target errors, provider bodies, approval tokens and screenshots. Fictional fixture values are intentionally kept in the separate typed file. No `.env`, database, private state key or unrestricted local trace belongs in this directory. See [the implemented privacy policy](../docs/evidence-privacy.md).


## Negative outcome and same-session recovery

[Failure log](member-discovery/failure.json) and [sanitized failure state](member-discovery/failure-state.json) document a replay of the exact member artifact against an already-created fictional reference. It returned `MEMBER_REFERENCE_EXISTS` without a model call or creation request.

[Mifos recovery evidence](mifos-recovery.json) records explicit account selection and correction of an intentionally wrong application reference through the human-input gateway. The successful checks retain the same Page/session and perform no model calls or business commits. The wrong reference is an injected test-capability defect; fixture preparation earlier created one approved pending account to produce ambiguity. This is not evidence of an actual banking outage.
