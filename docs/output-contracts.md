# Typed capability contracts

The existing artifact IDs remain `banking-inputs-v1`, `balance-v1`, `prepared-v1`, `submitted-v1`, and `member-v1`. Their descriptions live in the shared contract registry; no fields are added to previously saved artifacts and their provenance/digests are unchanged. `capabilityContractDescription(task)` returns a serializable description with JSON Schema 2020-12 input/output shapes. `outputSchemas` and `taskInputSchemas` expose the corresponding Zod 3 parsers. Shared field definitions supply both forms without requiring a dependency upgrade.

| Task | Required caller inputs | Terminal successful output |
|---|---|---|
| `balance` | `clientReference`; optional `accountReference` and product constraint | Exact member/account references, a signed decimal-string `balance` with two fraction digits, `currency: USD`, `status: Active` |
| `prepare` | `clientReference`, `product`, `externalReference` | Those three exact values; Mifos may also return currency, submission date, interest text and the full reviewed preview |
| `submit` | `clientReference`, `product`, `externalReference` | Those three exact values plus persisted `applicationReference` and the target's pending-approval status; optional currency |
| `member` | New `clientReference`, `firstName`, `lastName`; optional `memberActivationDate` | Exact reference/name, generated `memberAccountNumber`, full name, Head Office, Active status and verified activation date |

Member references contain 4–12 digits. Savings-account references contain 3–32 letters, digits or hyphens; generated member numbers allow 1–32. Application references allow 1–40 letters, digits or hyphens. Supported products remain Everyday Savings and Growth Savings. A money value is a string such as `12540.75` or `-12.50`; currency symbols, grouping, exponent notation, numeric floats and ambiguous precision are rejected. The output schema rejects undeclared fields rather than silently dropping potential sensitive extras.

Task input validation does not invent defaults. It projects the legacy common input object onto relevant task fields, allowing existing stored runs to retain unrelated defaults. Empty or omitted balance account references require a verified UI-derived account selection. Missing member dates must be resolved from the current visible business date. Explicit dates accept US `M/D/YYYY` or `D Month YYYY` and must be real calendar dates; returned member dates use the latter form. Names are normalized on input, but returned identity must match the normalized request exactly.

## Runtime validation

`validateFinalOutput({task, targetId, inputs, resolvedInputs, output, declaredOutput})` validates the declared schema and binds its values to the requested operation. It rejects a task/output-contract mismatch, wrong member/account/product/application reference, an attempted override of an explicit input by a resolved value, and incorrect name/date/status. Member creation is Mifos-only. Submitted status is `Pending Approval` in the lab and `Submitted and pending approval` in Mifos. These labels describe a pending application, not an approved or active savings account.

JSON Schema describes the structural shape. Cross-field/input bindings, target-specific status, real calendar dates and side-effect evidence are worker checks, not claims that JSON Schema alone proves a business result. UI checkpoint verification, request-body enforcement and single-use approval remain necessary.

Call this validator only for terminal successful outputs and successful read-only reconciliation, before marking the result/effect verified or publishing a discovered artifact. Intermediate client identity, member-absence and approval-preview checkpoints intentionally remain partial records. Known business outcomes are not successful business outputs and follow their own result taxonomy.

The validator is pure: it never changes run state or confirms a side effect. If validation fails after a possible submission, retain `effect: unknown` and require reconciliation; do not retry the write or publish successful discovery. `OutputContractError`/`TaskInputContractError` expose stable codes and field names without echoing rejected values. Existing historical artifacts/results are not rewritten or blanket-quarantined by introducing this registry.

`AccountChoice` is shared between profile, worker and UI. Its schema bounds references and visible labels; an account-selection intervention contains one verified member reference and at most 100 choices. A choice is data, never a locator or URL. The target adapter must still freshly verify account ownership and eligibility when the operator selects it.
