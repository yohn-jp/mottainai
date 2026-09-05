# Documentation

This directory is the repository's documentation entry point. Document
placement communicates responsibility, authority, and lifecycle; choose a
category before choosing a component or topic name.

## Placement policy

`docs/README.md` is the only ordinary Markdown file directly under `docs/`.
New documentation must be placed in the category that owns its primary
responsibility. Do not add an unclassified root-level file. Normative
documents and point-in-time evidence must use separate namespaces even when
they concern the same component.

Repository documentation and governance prose use English by default and, for
normative material, English is required. Existing Japanese prose is not
retained merely to reduce a diff. Identifiers, code, protocol names, quoted
external material, and intrinsically language-specific data are exempt when
translation would change their meaning. Mixed English/Japanese normative prose
is otherwise not permitted.

The placement and link checks are part of the repository standards path:
`pnpm run documentation:check` performs the tree and internal-link check, and
`pnpm run test:standards` runs it together with the existing governance checks.

## Categories

| Category | Purpose | What belongs there | What does not belong there | Authority/lifecycle | Entry point and major authorities |
| --- | --- | --- | --- | --- | --- |
| [`architecture/`](architecture/README.md) | Stable system structure and ownership boundaries | Component relationships, responsibility boundaries, provider topology | Command-by-command runbooks, compatibility contracts, point-in-time results | Current architectural authority | [`architecture/README.md`](architecture/README.md), [`runtime/`](architecture/runtime/README.md) |
| [`contracts/`](contracts/README.md) | Normative bounded interfaces and invariants | Schemas, compatibility, identity, state, policy, externally consumed behavior | Explanatory architecture, procedures, historical evidence | Normative authority | [`contracts/README.md`](contracts/README.md), [`runtime/`](contracts/runtime/linux-runtime.md) |
| [`operations/`](operations/README.md) | Procedures for operating and converging the system | Runbooks, golden paths, deployment and release flows | Stable architecture, contracts, historical release notes | Operational guidance | [`operations/README.md`](operations/README.md), [`release process`](operations/release/process.md) |
| [`governance/`](governance/README.md) | Repository and contributor rules | Issue/PR governance, coding standards, documentation policy | Product architecture, test results, implementation design | Normative repository governance | [`governance/README.md`](governance/README.md), [`Issue and Pull Request Governance`](governance/issues-and-pull-requests.md) |
| [`testing/`](testing/README.md) | How correctness is proven | Test architecture, probes, fault injection, mutation and benchmark procedures | Current product contracts, unrepeatable result reports | Verification guidance; baselines are evidentiary | [`testing/README.md`](testing/README.md), [`fault injection`](testing/architecture/fault-injection.md) |
| [`decisions/`](decisions/) | Durable architectural decisions | Numbered ADRs and their rationale | Current contract or operational instructions | Historical decision record | [`decisions/`](decisions/) |
| [`reports/`](reports/README.md) | Point-in-time observations and evidence | Dogfood reports, experiments, benchmark reports | Current normative authority | Evidentiary and time-bound | [`reports/README.md`](reports/README.md) |
| [`design/`](design/README.md) | Design-time implementation and exploration aids | Models and mockups | Current authority, test fixtures, release history | Non-normative design artifact | [`design/README.md`](design/README.md) |
| [`history/`](history/README.md) | Retained historical material | Version-specific release documents | Current release procedures or contracts | Historical | [`history/README.md`](history/README.md), [`release history`](history/releases/) |

## Major authorities

- Runtime architecture: [`architecture/runtime/README.md`](architecture/runtime/README.md)
- Linux Runtime contract: [`contracts/runtime/linux-runtime.md`](contracts/runtime/linux-runtime.md)
- Deployment descriptor contract: [`contracts/deployment/descriptor.md`](contracts/deployment/descriptor.md)
- Git workflow policy: [`contracts/workflow/git-policy.md`](contracts/workflow/git-policy.md)
- Issue and Pull Request governance: [`governance/issues-and-pull-requests.md`](governance/issues-and-pull-requests.md)
- Test architecture: [`testing/README.md`](testing/README.md)
- Documentation migration inventory: [`governance/documentation-migration.md`](governance/documentation-migration.md)

## Choosing a destination

1. Decide whether the document describes structure, a normative contract, a
   procedure, a repository rule, verification guidance, a durable decision,
   evidence, a design artifact, or history.
2. Place it in that responsibility category and its most specific existing
   subcategory.
3. Keep normative material separate from reports and design artifacts.
4. If no category fits, revise the information architecture before creating a
   new root-level document.
