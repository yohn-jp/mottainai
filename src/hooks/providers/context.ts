import fs from "node:fs/promises";
import path from "node:path";
import { decideRead } from "../../context-runtime/read-policy.js";
import type { ReadGovernorPolicy, ReadMode, ReadRequest } from "../../context-runtime/read-policy.js";
import { inspectReadFile } from "../../context-runtime/read-adapter.js";
import type { HookEvent } from "../types.js";
import type { HookPolicyProvider, HookProviderResult } from "./types.js";

export interface ContextProviderOptions {
  workspaceRoot: string;
  readPolicy?: ReadGovernorPolicy;
}
function numberMetadata(value: string | number | boolean | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function modeMetadata(value: string | number | boolean | undefined): ReadMode | undefined {
  return value === "raw" || value === "outline" || value === "symbols" || value === "auto" ? value : undefined;
}

function notApplicable(): HookProviderResult {
  return { provider: "context", state: "not_applicable", reason: "unsupported_operation" };
}

function unavailable(rule: string, diagnostic: string): HookProviderResult {
  return {
    provider: "context",
    state: "unavailable",
    reason: "context_authority_unavailable",
    rule,
    diagnostic,
  };
}

function projectReadDecision(decision: ReturnType<typeof decideRead>): HookProviderResult {
  const action = decision.action === "deny" ? "deny" : decision.action === "warn" ? "warn" : "allow";
  return {
    provider: "context",
    state: "authoritative",
    action,
    reason: "context_read_governor",
    rule: decision.policyRule,
    ...(decision.allowed ? {} : { replacement: "mottainai_read" }),
    diagnostic: `action=${decision.action}`,
  };
}

/** Thin projection over #70 read-adapter metadata inspection and read-governor decisions. */
export function createContextReadPolicyProvider(options: ContextProviderOptions): HookPolicyProvider {
  return {
    provider: "context",
    async evaluate(event): Promise<HookProviderResult> {
      if (event.operation === "source.search") return { provider: "context", state: "unsupported", reason: "context_unsupported", rule: "read-governor.search" };
      if (event.operation !== "source.read") return notApplicable();
      if (options.readPolicy === undefined) return unavailable("read-governor.policy", "policy_unavailable");
      if (event.target?.kind !== "path" || event.target.value === undefined) {
        return unavailable("read-governor.target", "path_unavailable");
      }

      const root = await fs.realpath(path.resolve(options.workspaceRoot)).catch(() => undefined);
      if (root === undefined) return unavailable("read-governor.workspace", "workspace_unavailable");
      const candidate = path.resolve(root, event.target.value);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        return projectReadDecision({
          action: "deny",
          allowed: false,
          requestedMode: modeMetadata(event.metadata?.mode) ?? "auto",
          normalizedRequest: { path: event.target.value, mode: modeMetadata(event.metadata?.mode) ?? "auto", bounded: false },
          policy: { mode: options.readPolicy.mode, rule: "WORKSPACE_BOUNDARY_INVALID", reason: "workspace boundary is invalid" },
          policyRule: "WORKSPACE_BOUNDARY_INVALID",
          rule: "WORKSPACE_BOUNDARY_INVALID",
          reason: "workspace boundary is invalid",
          diagnostics: [],
          suggestedNextActions: [],
          metadata: { lineCount: 0, byteSize: 0 },
        });
      }

      const filePath = await fs.realpath(candidate).catch(() => undefined);
      if (filePath === undefined || (filePath !== root && !filePath.startsWith(`${root}${path.sep}`))) {
        return projectReadDecision({
          action: "deny",
          allowed: false,
          requestedMode: modeMetadata(event.metadata?.mode) ?? "auto",
          normalizedRequest: { path: event.target.value, mode: modeMetadata(event.metadata?.mode) ?? "auto", bounded: false },
          policy: { mode: options.readPolicy.mode, rule: "SYMLINK_BOUNDARY_INVALID", reason: "symlink boundary is invalid" },
          policyRule: "SYMLINK_BOUNDARY_INVALID",
          rule: "SYMLINK_BOUNDARY_INVALID",
          reason: "symlink boundary is invalid",
          diagnostics: [],
          suggestedNextActions: [],
          metadata: { lineCount: 0, byteSize: 0 },
        });
      }

      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return unavailable("read-governor.target", "target_not_file");
        const inspected = await inspectReadFile(filePath);
        const request: ReadRequest = {
          path: path.relative(root, filePath),
          ...(modeMetadata(event.metadata?.mode) === undefined ? {} : { mode: modeMetadata(event.metadata?.mode) }),
          ...(numberMetadata(event.metadata?.startLine) === undefined ? {} : { startLine: numberMetadata(event.metadata?.startLine) }),
          ...(numberMetadata(event.metadata?.endLine) === undefined ? {} : { endLine: numberMetadata(event.metadata?.endLine) }),
        };
        return projectReadDecision(decideRead(request, inspected, options.readPolicy));
      } catch {
        return unavailable("read-governor.inspect", "metadata_unavailable");
      }
    },
  };
}
