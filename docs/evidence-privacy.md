# Evidence and private local state

Interface's supported targets contain fictional assessment data. The worker still treats names, references, balances, goal text, target errors and approval previews as private. This is an implemented local policy, not permission to connect real member records.

## Three distinct surfaces

- **Live operator view:** the local API and current screenshot show the real browser so the operator can check the exact preview and repair the session. Raw screenshots remain in memory. This view is never an automatic public export.
- **Private recovery state:** SQLite stores authenticated AES-256-GCM encrypted run/capability state. A separate `state.key`, restricted to the current filesystem user, is required to recover exact identity, replay provenance and uncertain write state after restart. Ciphertexts bind their table and record ID as authenticated data. This is encryption, not redaction. The adjacent key does not defend against another process running as the same user; OS keychain integration and retention controls are future release work. Back up the database and key together, privately. A missing or wrong key fails closed.
- **Audit evidence:** SQLite's readable run projection and the exported logs use an allowlist. Goal text, identities, balances, raw errors, free-form model explanations, field values and approval tokens are omitted. Events retain time, actor, kind, control state and outcome codes. Saved screenshots hide all text/form values and mask images, canvases, SVGs, videos and frames; they retain layout. Their accompanying DOM summary contains only visible element types and disabled states. Inspecting a private failure in the running local app gives more detail than a shareable report.

Run checkpoints and the proposed action's target/input binding explain the action purpose without copying model prose into an artifact. Model history is transient; portable discovery step labels are worker-generated. Provider observations are never written to logs. Password fields are excluded from model controls and masked in model screenshots; provider discovery still transmits visible fictional target data to the configured API. Deterministic replay makes no model calls.

## Existing histories

On the next worker start, legacy plaintext run/capability rows migrate to encrypted state while preserving their original content and digests. SQLite checkpoints and vacuums that database after migration. Earlier unredacted JPEGs move into encrypted private history; they are no longer public evidence images. This cannot erase old backups, snapshots, external copies or already collected logs. It does not change any Mifos member or application.

## Export and checks

Only explicitly selected and reviewed fictional runs should enter `evidence/`. The exporter opens SQLite read-only, verifies the original discovered digest and replay qualification, includes the named schemas, and exports redacted logs. It does not include `.env`, databases, state keys, screenshots, prompts, provider bodies or arbitrary local files. Exact artifact bytes must pass input-literal and credential-pattern checks; export does not silently edit a locator and claim the original digest.

Canary tests check that audit records and database/WAL bytes omit private strings, encrypted state restores the original run, ciphertexts cannot move between records, legacy rows migrate, and equal layouts with different private text produce identical saved screenshot pixels. These tests cover the supported DOM targets; the policy is not a general OCR redactor for arbitrary native applications.
