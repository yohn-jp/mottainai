import fs from "node:fs";
import path from "node:path";
import { POLICY_SCHEMA_VERSION, workflowPolicySchema } from "./schema.js";
import type { WorkflowPolicyDocument } from "./schema.js";

export const WORKFLOW_POLICY_FILE_NAME = "workflow.json";

export function resolveWorkflowPolicyPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".mottainai", WORKFLOW_POLICY_FILE_NAME);
}

export type LoadWorkflowPolicyResult =
  | { ok: true; document: WorkflowPolicyDocument; filePath: string }
  | { ok: false; filePath: string; reason: string };

/**
 * `.mottainai/workflow.json` を読み込み検証する。存在しない場合は呼び出し側が
 * built-in preset へ fallback できるよう { ok: false, reason: "not-found" } を返す
 * （例外にしない。未設定は正常系の一部）。未知キー・未対応 version は fail-closed
 * にし、診断メッセージを返す（黙って無視しない）。
 */
export function loadWorkflowPolicy(workspaceRoot: string): LoadWorkflowPolicyResult {
  const filePath = resolveWorkflowPolicyPath(workspaceRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, filePath, reason: "not-found" };
    }
    return { ok: false, filePath, reason: `cannot read policy file: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, filePath, reason: `invalid JSON: ${(err as Error).message}` };
  }

  if (typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed) {
    const version = (parsed as { schemaVersion: unknown }).schemaVersion;
    if (version !== POLICY_SCHEMA_VERSION) {
      return { ok: false, filePath, reason: `unsupported schemaVersion: ${JSON.stringify(version)} (expected ${POLICY_SCHEMA_VERSION})` };
    }
  } else {
    return { ok: false, filePath, reason: "missing schemaVersion" };
  }

  const result = workflowPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    return { ok: false, filePath, reason: `schema validation failed: ${issues}` };
  }

  return { ok: true, document: result.data, filePath };
}
