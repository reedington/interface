# Fresh local installation qualification

The normal clone path is `npm ci`, `npm run setup`, then `npm start`. Setup starts the pinned Mifos X web app, Apache Fineract and PostgreSQL locally, prepares the Electron runtime, and creates synthetic US fixtures. Mifos is an international banking platform; the fixture data and configured locale provide the US context. No AWS account or model key is needed for setup or replay.

The September 23, 2026 qualification passed on macOS arm64 with Node 25.2.1. The isolated database began with zero members, savings accounts and savings products. First setup made 12 API writes to create two funded fixtures; repeated setup made zero API writes and preserved the records and fixture manifest. Typecheck and build passed in the clean source copy. The [sanitized evidence](../evidence/fresh-setup.json) identifies the exact tested source snapshot, with [per-file SHA-256 hashes](../evidence/fresh-setup-source-files.json). Later edits are outside that snapshot. Existing npm, Electron and Docker caches were reused, so this result does not establish cold-download timing or prerequisite installation on a clean machine.

`npm run test:setup:fresh` qualifies that path against an empty, separate database. It requires installed Chrome, a running local Docker engine, and dependencies in the checkout used to launch the qualification. Cached images are reused; the database, network, fixture journal and worker data are isolated.

```sh
npm ci
npm run test:setup:fresh
```

The harness checks resources and free ports, creates a public-source copy without `.env`, `.local`, `node_modules` or `dist`, and authors a new configuration containing only local test settings. Provider credentials and inherited Node execution hooks are excluded. It runs `npm ci`, typecheck, build, `npm run setup`, and a second `npm run setup` inside that copy. Setup records the initial API collection counts before its first mutation. Qualification requires zero initial members, savings accounts and savings products; two funded US fixtures afterward; and zero API writes plus unchanged records and manifest on the second setup.

By default the test stack uses `http://127.0.0.1:4201`, workbench port `14317`, and a unique `interface-assessment-<timestamp>` Compose project. To use other unused ports:

```sh
npm run test:setup:fresh -- --port=4202 --workbench-port=14318
```

The normal ports `4200` and `4317` are refused. The harness never stops an existing service or deletes/prunes Docker volumes. It leaves its stack, checkout, `.env`, evidence JSON and command logs under `.local/validation/interface-assessment-<timestamp>/` for additional tests. The evidence prints the exact configuration and manifest paths. These retained files occupy disk space; remove them only after all tests using their stack have finished. A failed qualification also retains its own resources for diagnosis.

## Using an isolated stack from the main checkout

`INTERFACE_ENV_FILE` chooses the configuration file at launch. Its supported settings override inherited values just as the default `.env` does. An explicitly selected missing file fails rather than silently falling back to the normal target. A configuration file cannot redirect this setting itself.

```sh
INTERFACE_ENV_FILE=/absolute/path/from/evidence/checkout/.env npm run test:mifos
INTERFACE_ENV_FILE=/absolute/path/from/evidence/checkout/.env npm run mifos:status
```

On Windows PowerShell, set `$env:INTERFACE_ENV_FILE` to that file before invoking the command. The harness is qualified on macOS; Windows execution remains unverified.

For manual isolation, author a separate configuration before running setup and choose the stack and worker settings together:

```dotenv
INTERFACE_TARGET=mifos
MIFOS_URL=http://127.0.0.1:4201
MIFOS_COMPOSE_PROJECT=interface-isolated
MIFOS_FIXTURE_DIR=/absolute/path/to/isolated-fixtures
WORKBENCH_DATA_DIR=/absolute/path/to/isolated-worker-data
WORKBENCH_PORT=14317
MIFOS_TENANT=default
MIFOS_USERNAME=mifos
MIFOS_PASSWORD=password
```

`MIFOS_COMPOSE_PROJECT` allows 1–63 lowercase letters, digits, underscores or hyphens, starting with a letter or digit. It separates Compose containers, networks and the database volume. `MIFOS_FIXTURE_DIR` defaults to `.local/mifos`; relative paths resolve from the checkout. The seed journal and manifest bind the origin, default tenant and Compose project. They cannot be reused across projects. Legacy manifests without a project binding belong only to the default `interface-mifos` project.

To stop only the retained assessment stack later, select its exact configuration and use `npm run mifos:down`. This retains that stack’s database volume.
