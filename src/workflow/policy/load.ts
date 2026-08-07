import fs from "node:fs";
import path from "node:path";
import { getPreset } from "./presets.js";
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

export type ResolveEffectiveWorkflowPolicyResult =
  | { ok: true; document: WorkflowPolicyDocument; source: "preset" | "repository"; filePath: string }
  | { ok: false; filePath: string; reason: string };

/**
 * `loadWorkflowPolicy` の「ファイルが無ければ呼び出し側が fallback する」を、実際の
 * fallback 先（built-in `standard` preset）まで含めて一箇所に集約したもの。
 * task.start/task.status/CLI 等、素朴に「今使うべき1つの document」だけが欲しい
 * 呼び出し側はこちらを使う（`docs/workflow-policy.md` の既定 fallback と同じ）。
 *
 * JSON 破損・schemaVersion 不一致等（"not-found" 以外の失敗）は fallback せず
 * fail-closed で返す — 壊れた policy ファイルを黙って無視して preset で続行しない。
 *
 * `policy explain`（`./explain.ts`）は repository の値と、それが宣言した preset の
 * 値を別々の authority として resolveRule() に通す必要があるため、この関数は使わず
 * `loadWorkflowPolicy` + `getPreset` を直接組み合わせる。
 */
export function resolveEffectiveWorkflowPolicy(workspaceRoot: string): ResolveEffectiveWorkflowPolicyResult {
  const loaded = loadWorkflowPolicy(workspaceRoot);
  if (loaded.ok) return { ok: true, document: loaded.document, source: "repository", filePath: loaded.filePath };
  if (loaded.reason === "not-found") return { ok: true, document: getPreset("standard"), source: "preset", filePath: loaded.filePath };
  return { ok: false, filePath: loaded.filePath, reason: loaded.reason };
}
