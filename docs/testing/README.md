# Test architecture

Mottainai's test layers are separated by responsibility, execution cost, and
environment boundary. [`scripts/test-suites.mjs`](../../scripts/test-suites.mjs)
is the machine-readable classification authority; this document explains its
meaning and operation.

## Assurance chain

```text
canonical rule / contract
  -> named test layer / command
  -> compiled Inari PR contract + executable CI results
  -> packed artifact proof when distribution paths change
  -> runtime/build identity for the verified artifact
```

The compiled Inari contract is the sole authority for PR body shape. The
current default PR has five fields: `Summary`, `Linked issue`, `Changes`,
`Validation`, and `Review focus`. Do not derive additional required body
sections such as `Test contract`, `Regression proof`, `Validation evidence`,
or `Release impact` from test tiers.

Each CI job or artifact is the authority for its detailed execution evidence.
Check `Typecheck`, `Tests`, `Build`, and the conditional `Package check` only
when that validation has actually completed.

## Test layers

| Layer | Assurance target | Main entry point |
| --- | --- | --- |
| Fast | Pure logic, schemas, envelopes, deterministic contracts | `pnpm test` |
| Integration / process | Filesystem, Git, SQLite, CLI, subprocesses, multiple components | `pnpm run test:integration` |
| E2E / black-box | External MCP client connected to built `dist` over stdio | `pnpm run test:e2e` |
| Package | Packed artifact, installation, binaries, consumer protocol | `pnpm run test:package` |
| Standards | Format, lint, architecture, governance, suite and coverage policy | `pnpm run test:standards`, `pnpm run verify:standards` |
| Coverage | Fast and integration coverage policy | `pnpm run test:coverage` |
| Full verification | Standards, typecheck, fast, integration, build, E2E, coverage, package | `pnpm run verify` |

`pnpm test` is the short default TDD loop and excludes E2E, package, and
coverage. `pnpm run test:all` is a development aggregate for fast,
integration, and E2E tests; it is not itself a release decision.

## Mechanical classification

`scripts/test-suites.mjs` enumerates the repository and assigns each test file
to a suite.

- `src/**/*.test.ts`: fast, or an explicitly classified integration/process
  rule.
- `src/e2e/**/*.spec.ts`: E2E.
- `scripts/**/*.test.mjs`: standards by default, except files explicitly
  classified as integration or package harnesses.
- `scripts/mcp-stdio-package.test.mjs` and `scripts/smoke-test.mjs`: package
  path.

The classifier fails on unassigned files, files assigned to multiple suites,
and process/E2E/package tests placed in fast. It provides no route to hide a
test from classification with comments.

New tests normally use these locations:

- Pure logic, schemas, and envelopes: `<name>.test.ts` beside the module.
- Filesystem, Git, SQLite, CLI, and subprocess behavior: an integration or
  process rule.
- External stdio MCP protocol: `src/e2e/<name>.e2e.spec.ts`.
- Packed consumer, installation, and binary behavior: the package suite.

Existing colocated tests are not moved solely for classification.

## CI topology

Linux and Node 24 are the canonical correctness environment. Native Windows is
not a supported runtime; Windows users should use WSL2. macOS is best effort
and Tier 2.

The canonical Node 24 path runs, as applicable:

- standards and static integrity;
- typecheck;
- fast unit and contract tests;
- integration and process tests;
- build;
- built-dist E2E;
- coverage; and
- packed consumer and package contract tests.

The GitHub Ruleset's required checks are authoritative on GitHub and must not
be inferred from this document. Non-required CI jobs are still valid executable
evidence for their respective layer.

## Governance boundary

Repository PR governance does not generate additional body sections from the
test-layer list.

The responsibilities are:

- Inari: PR body shape and rendering/semantic validation.
- `scripts/governance-rules.json`: title, branch, minimum body length,
  Validation completion, conditional Package check, and compression/CLI
  changed-file rules.
- `scripts/governance-lib.mjs`: repository-local independent checks and Inari
  heading synchronization.
- CI: evidence that test, build, and package commands actually ran.

The former `Validation evidence` class and PR-body `Regression proof` are not
part of the current default PR schema. Historical quality-evidence research
remains an analyzer-selection record and must not create undeclared PR fields.

## Commands

```bash
pnpm test
pnpm run test:integration
pnpm run build
pnpm run test:e2e
pnpm run test:package
pnpm run test:coverage
pnpm run test:standards
pnpm run verify:standards
pnpm run verify
```

- `smoke-test`: verifies a packed package from built `dist`.
- `test:package`: runs package-protocol and consumer smoke tests against the
  same tarball after building.
- `test:coverage`: runs fast and integration tests with instrumentation and
  generates a coverage artifact and policy result.
- `verify`: runs full verification in deterministic order.

## Process and fault boundaries

When persistent state, external processes, Git mutation, migrations, cleanup,
or retry semantics change, add a deterministic failure case for the relevant
boundary. Do not use sleep, random failure, or real-process timing races as the
reproduction mechanism. See
[`fault-injection.md`](architecture/fault-injection.md).

At minimum, fault tests fix the following:

1. failure operation;
2. pre-state;
3. post-state;
4. cleanup and retention; and
5. retry and recovery semantics.

## E2E and package boundary

`test:e2e` launches built `dist/index.js` as a child process and verifies MCP
initialize, tools/list, tools/call, protocol lifecycle, and upstream failure at
the stdio boundary. Importing production internals and observing a passing
test is not E2E proof.

`test:package` packs the built artifact and verifies the same tarball through a
consumer path. Package, binary, and publish correctness cannot be proven by
source imports alone.

The release workflow does not rebuild the artifact between packing and
publishing; the verified tarball and published target remain identical.

## Coverage

Coverage numbers and critical modules are owned by
[`scripts/coverage-policy.json`](../../scripts/coverage-policy.json). Meeting a
coverage threshold and proving product behavior are separate assurances;
coverage does not replace integration, E2E, or package proof.

## Effectiveness tests

Property and mutation testing evaluate the effectiveness of the test suite as
an auxiliary layer. They are not part of the normal fast loop or required PR
body fields.

```bash
pnpm run test:property
pnpm run test:mutation
pnpm run test:effectiveness
```

Treat their results as input for analyzer and harness improvements, not as a
replacement for the normal CI pass.

## Golden path

The final acceptance of the Golden Path requires product proof across the
actual lifecycle, not only individual unit tests.

```text
Issue
  -> task start/run
  -> Nawabari worktree/session/claim
  -> validation
  -> managed commit
  -> managed push
  -> gh-inari PR
  -> Governance + CI
  -> merge
  -> task finish
  -> Nawabari ownership release
  -> next task start
```

Fixes for intermediate retry or reconciliation behavior are fixed with
focused integration tests and finally revalidated across the full lifecycle.
If raw Git or GitHub repair is required, the Golden Path is incomplete.
