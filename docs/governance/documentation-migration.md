# Documentation migration inventory

This inventory classifies every path in the pre-#856 `docs/` tree. Grouped
directory rows include every child path shown by the final glob. The reason
records the responsibility or lifecycle decision; no product behavior is
changed by the migration.

| Pre-migration path | Classification | Final path | Reason |
| --- | --- | --- | --- |
| `docs/benchmark-artifact-bounding.md` | move | `docs/reports/benchmarks/artifact-bounding.md` | Dated benchmark evidence |
| `docs/bootstrap.md` | move | `docs/contracts/runtime/bootstrap.md` | Bootstrap contract authority |
| `docs/ci-topology.md` | move | `docs/architecture/ci/topology.md` | CI ownership architecture |
| `docs/coding-standards.md` | move | `docs/governance/coding-standards.md` | Repository coding governance |
| `docs/context-runtime-dogfood-report.md` | move | `docs/reports/dogfood/context-runtime.md` | Dogfood evidence |
| `docs/context-runtime.md` | move | `docs/operations/runtime/context-runtime-rollout.md` | Rollout procedure and telemetry guidance |
| `docs/deployment-descriptor.md` | move | `docs/contracts/deployment/descriptor.md` | Deployment descriptor contract |
| `docs/deployment-route-implementation.md` | move | `docs/architecture/deployment/routes.md` | Route and vehicle ownership architecture |
| `docs/fault-injection.md` | move | `docs/testing/architecture/fault-injection.md` | Test architecture and invariants |
| `docs/governance.md` | move | `docs/governance/issues-and-pull-requests.md` | Issue/PR governance |
| `docs/host-bootstrap.md` | move | `docs/contracts/deployment/host-bootstrap.md` | Host-bootstrap contract |
| `docs/lima-appliance-boot-probe.md` | move | `docs/testing/integration/lima-appliance-boot-probe.md` | Integration probe |
| `docs/lima-runtime-orchestration.md` | move | `docs/architecture/runtime/lima-orchestration.md` | Runtime/provider architecture |
| `docs/lima-validation-probe.md` | move | `docs/testing/integration/lima-validation-probe.md` | Integration probe |
| `docs/linux-runtime-contract.md` | move | `docs/contracts/runtime/linux-runtime.md` | Linux Runtime contract authority |
| `docs/local-runtime.md` | move | `docs/operations/runtime/local-runtime.md` | Local Runtime procedure |
| `docs/managed-generation.md` | move | `docs/contracts/runtime/managed-generation.md` | Managed generation contract |
| `docs/managed-hooks-dogfood-report.md` | move | `docs/reports/dogfood/managed-hooks.md` | Dogfood evidence |
| `docs/managed-hooks.md` | move | `docs/architecture/integrations/managed-hooks.md` | Integration architecture |
| `docs/managed-package-manifest.md` | move | `docs/contracts/runtime/managed-package-manifest.md` | Desired-state contract |
| `docs/mcp-harness-delegation.md` | move | `docs/architecture/mcp/harness-delegation.md` | MCP delegation architecture |
| `docs/mcp-stdio-blackbox.md` | move | `docs/testing/mcp/stdio-blackbox.md` | Black-box verification |
| `docs/mutation-baseline.json` | move | `docs/testing/mutation/baseline.json` | Test baseline data |
| `docs/nawabari-execution.md` | move | `docs/architecture/integrations/nawabari-execution.md` | Execution boundary architecture |
| `docs/nix-runtime-golden-path.md` | move | `docs/operations/runtime/nix-golden-path.md` | Runtime operating procedure |
| `docs/quality-evidence-providers.md` | move | `docs/contracts/quality/evidence-providers.md` | Evidence provider contract |
| `docs/read-governor.md` | move | `docs/contracts/runtime/read-governor.md` | Read policy contract |
| `docs/release-process.md` | move | `docs/operations/release/process.md` | Release runbook |
| `docs/repository-semantics.md` | move | `docs/architecture/repository/semantic-model.md` | Repository semantic architecture |
| `docs/route4-route1-operation-book.md` | move | `docs/operations/deployment/route4-to-route1.md` | Chronological deployment procedure |
| `docs/runtime-appliance-oci.md` | move | `docs/architecture/runtime/appliance-oci.md` | Runtime Appliance distribution architecture |
| `docs/runtime-appliance-proxmox.md` | move | `docs/architecture/runtime/providers/proxmox.md` | Provider architecture |
| `docs/runtime-architecture.md` | move | `docs/architecture/runtime/README.md` | Runtime architecture entry point |
| `docs/runtime-lifecycle.md` | move | `docs/architecture/runtime/lifecycle.md` | Lifecycle architecture |
| `docs/runtime-state.md` | move | `docs/contracts/runtime/state.md` | Runtime state contract |
| `docs/ssh-target-identity.md` | move | `docs/contracts/runtime/ssh-target-identity.md` | SSH identity contract |
| `docs/testing.md` | move | `docs/testing/README.md` | Test architecture entry point |
| `docs/validation-governor.md` | move | `docs/architecture/validation/governor.md` | Validation architecture |
| `docs/workflow-policy.md` | move | `docs/contracts/workflow/git-policy.md` | Versioned workflow policy contract |
| `docs/decisions/` | keep | `docs/decisions/` | Canonical ADR namespace |
| `docs/decisions/0001-optimize-working-set-not-compression-ratio.md` | keep | same path | Numbered ADR history preserved |
| `docs/decisions/0002-linux-runtime-contract.md` | keep | same path | Numbered ADR history preserved |
| `docs/decisions/0003-layered-declarative-deployment.md` | keep | same path | Numbered ADR history preserved |
| `docs/experiments/` | move | `docs/reports/experiments/` | Point-in-time evidence |
| `docs/experiments/2026-08-08-headroom-codex-ab.md` | move | `docs/reports/experiments/2026-08-08-headroom-codex-ab.md` | Dated experiment evidence |
| `docs/mockups/` | move | `docs/design/mockups/` | Non-normative design assets |
| `docs/mockups/index.html` | move | `docs/design/mockups/index.html` | Mockup asset |
| `docs/mockups/mottainai.html` | move | `docs/design/mockups/mottainai.html` | Mockup asset |
| `docs/mockups/styles.css` | move | `docs/design/mockups/styles.css` | Mockup asset |
| `docs/mockups/vendor/` | move | `docs/design/mockups/vendor/` | Vendored mockup asset dependencies |
| `docs/mockups/vendor/addon-fit.js` | move | `docs/design/mockups/vendor/addon-fit.js` | Vendored mockup asset dependency |
| `docs/mockups/vendor/xterm.css` | move | `docs/design/mockups/vendor/xterm.css` | Vendored mockup asset dependency |
| `docs/mockups/vendor/xterm.js` | move | `docs/design/mockups/vendor/xterm.js` | Vendored mockup asset dependency |
| `docs/mockups/wabachi.html` | move | `docs/design/mockups/wabachi.html` | Mockup asset |
| `docs/design/` | keep | `docs/design/` | Existing design namespace retained; children are separated into models and mockups |
| `docs/design/repository-semantic-model-v1.ts` | move | `docs/design/models/repository-semantic-model-v1.ts` | Design-time model |
| `docs/quality-evidence-providers/` | move | `docs/contracts/quality/evidence-providers.md` and `scripts/fixtures/quality-evidence-providers/` | Separate authority from non-document fixtures |
| `docs/quality-evidence-providers/fixtures/` | move-out-of-docs | `scripts/fixtures/quality-evidence-providers/` | Fixtures are executable test inputs, not documentation |
| `docs/quality-evidence-providers/fixtures/v1/` | move-out-of-docs | `scripts/fixtures/quality-evidence-providers/v1/` | Versioned fixture inputs |
| `docs/quality-evidence-providers/fixtures/v1/dependency-cruiser.no-circular.json` | move-out-of-docs | `scripts/fixtures/quality-evidence-providers/v1/dependency-cruiser.no-circular.json` | Tool configuration fixture |
| `docs/quality-evidence-providers/fixtures/v1/semgrep.custom-rules.yml` | move-out-of-docs | `scripts/fixtures/quality-evidence-providers/v1/semgrep.custom-rules.yml` | Tool configuration fixture |
| `docs/releases/` | archive/history | `docs/history/releases/` | Version-specific release history |
| `docs/releases/0.1.1.md` | archive/history | `docs/history/releases/0.1.1.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.1.2.md` | archive/history | `docs/history/releases/0.1.2.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.1.3.md` | archive/history | `docs/history/releases/0.1.3.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.1.4.md` | archive/history | `docs/history/releases/0.1.4.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.2.0.md` | archive/history | `docs/history/releases/0.2.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.3.0.md` | archive/history | `docs/history/releases/0.3.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.3.1.md` | archive/history | `docs/history/releases/0.3.1.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.4.0.md` | archive/history | `docs/history/releases/0.4.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.5.0.md` | archive/history | `docs/history/releases/0.5.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.6.0.md` | archive/history | `docs/history/releases/0.6.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.7.0.md` | archive/history | `docs/history/releases/0.7.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.7.1.md` | archive/history | `docs/history/releases/0.7.1.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.8.0.md` | archive/history | `docs/history/releases/0.8.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.8.1.md` | archive/history | `docs/history/releases/0.8.1.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.8.2.md` | archive/history | `docs/history/releases/0.8.2.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.8.3.md` | archive/history | `docs/history/releases/0.8.3.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.9.0.md` | archive/history | `docs/history/releases/0.9.0.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.9.1.md` | archive/history | `docs/history/releases/0.9.1.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.9.2.md` | archive/history | `docs/history/releases/0.9.2.md` | Retained historical release document; current release procedure is separate |
| `docs/releases/0.9.3.md` | archive/history | `docs/history/releases/0.9.3.md` | Retained historical release document; current release procedure is separate |
