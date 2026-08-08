export const READ_GOVERNOR_MODES = ["off", "observe", "warn", "enforce"] as const;
export type ReadGovernorMode = (typeof READ_GOVERNOR_MODES)[number];

export const READ_MODES = ["raw", "outline", "symbols", "auto"] as const;
export type ReadMode = (typeof READ_MODES)[number];

export interface ReadGovernorPolicy {
  mode: ReadGovernorMode;
  maxRawLines: number;
  maxRawBytes: number;
  allowWholeFileBelowLines: number;
  preferAuto: boolean;
}

export const DEFAULT_READ_GOVERNOR_POLICY: ReadGovernorPolicy = {
  mode: "enforce",
  maxRawLines: 120,
  maxRawBytes: 12_000,
  allowWholeFileBelowLines: 120,
  preferAuto: true,
};

export interface ReadRequest {
  path: string;
  mode?: ReadMode;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileMetadata {
  lineCount: number;
  byteSize: number;
  rangeBytes?: number;
  withinWorkspace: boolean;
  symlinkSafe: boolean;
}

export interface NormalizedReadRequest {
  path: string;
  requestedMode: ReadMode;
  mode: Exclude<ReadMode, "auto">;
  startLine?: number;
  endLine?: number;
  wholeFile: boolean;
  requestedLines?: number;
}

export type ReadDecisionAction = "allow" | "observe" | "warn" | "deny";

export interface ReadDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface ReadDecision {
  action: ReadDecisionAction;
  allowed: boolean;
  wouldAction: "allow" | "deny";
  normalizedRequest: NormalizedReadRequest;
  policyMode: ReadGovernorMode;
  policyRule: string;
  reasonCategory: string;
  reason: string;
  diagnostics: ReadDiagnostic[];
  suggestedNextActions: string[];
  metadata: Pick<ReadFileMetadata, "lineCount" | "byteSize" | "withinWorkspace" | "symlinkSafe">;
}

interface PolicyFailure {
  rule: string;
  category: string;
  reason: string;
  diagnostics: ReadDiagnostic[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
]);

function isSourceFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")).toLowerCase() : "";
  return SOURCE_EXTENSIONS.has(extension);
}

function validPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1;
}

function validMetadata(metadata: ReadFileMetadata): boolean {
  return (
    Number.isSafeInteger(metadata.lineCount) &&
    metadata.lineCount >= 1 &&
    Number.isSafeInteger(metadata.byteSize) &&
    metadata.byteSize >= 0
  );
}

function requestedLines(startLine: number | undefined, endLine: number | undefined): number | undefined {
  if (!validPositiveInteger(startLine) || !validPositiveInteger(endLine) || endLine < startLine) return undefined;
  return endLine - startLine + 1;
}

function rangeIsExplicit(request: ReadRequest): boolean {
  return request.startLine !== undefined || request.endLine !== undefined;
}

function boundedRangeSuggestion(
  request: NormalizedReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
): string {
  const start = validPositiveInteger(request.startLine) ? Math.min(request.startLine, metadata.lineCount) : 1;
  const end = Math.min(metadata.lineCount, start + policy.maxRawLines - 1);
  return `request raw lines ${start}-${Math.max(start, end)}`;
}

function nextActions(request: NormalizedReadRequest, metadata: ReadFileMetadata, policy: ReadGovernorPolicy): string[] {
  const actions = ["use mode:auto"];
  if (isSourceFile(request.path)) actions.push("request symbols");
  else actions.push("request outline");
  actions.push("search for a specific identifier");
  actions.push(boundedRangeSuggestion(request, metadata, policy));
  return actions;
}

function normalizeRequest(
  request: ReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
): NormalizedReadRequest {
  const requestedMode = request.mode ?? (policy.preferAuto ? "auto" : "raw");
  const wholeFile = !rangeIsExplicit(request);
  const lines = requestedLines(request.startLine, request.endLine);
  const rangeWithinLimits =
    lines !== undefined &&
    lines <= policy.maxRawLines &&
    (metadata.rangeBytes ?? metadata.byteSize) <= policy.maxRawBytes;
  const smallWholeFile =
    metadata.lineCount <= policy.allowWholeFileBelowLines && metadata.byteSize <= policy.maxRawBytes;
  let mode: Exclude<ReadMode, "auto">;
  if (requestedMode === "raw") mode = "raw";
  else if (requestedMode === "outline") mode = "outline";
  else if (requestedMode === "symbols") mode = "symbols";
  else if (wholeFile && smallWholeFile) mode = "raw";
  else if (!wholeFile && rangeWithinLimits) mode = "raw";
  else mode = isSourceFile(request.path) ? "symbols" : "outline";

  return {
    path: request.path,
    requestedMode,
    mode,
    ...(request.startLine === undefined ? {} : { startLine: request.startLine }),
    ...(request.endLine === undefined ? {} : { endLine: request.endLine }),
    wholeFile,
    ...(lines === undefined ? {} : { requestedLines: lines }),
  };
}

function invalidRequestFailure(request: NormalizedReadRequest, metadata: ReadFileMetadata): PolicyFailure | undefined {
  const hasStart = request.startLine !== undefined;
  const hasEnd = request.endLine !== undefined;
  if (hasStart !== hasEnd) {
    return {
      rule: "RAW_RANGE_REQUIRES_START_AND_END",
      category: "invalid_range",
      reason: "bounded raw reads require both startLine and endLine",
      diagnostics: [
        { severity: "error", code: "INVALID_RANGE", message: "startLine and endLine must be provided together" },
      ],
    };
  }
  if (!hasStart || !hasEnd) return undefined;
  if (
    !validPositiveInteger(request.startLine) ||
    !validPositiveInteger(request.endLine) ||
    request.endLine < request.startLine
  ) {
    return {
      rule: "RAW_RANGE_INVALID",
      category: "invalid_range",
      reason: "startLine and endLine must be positive integers with endLine >= startLine",
      diagnostics: [
        { severity: "error", code: "INVALID_RANGE", message: "startLine/endLine is not a valid line range" },
      ],
    };
  }
  if (request.startLine > metadata.lineCount || request.endLine > metadata.lineCount) {
    return {
      rule: "RAW_RANGE_OUT_OF_BOUNDS",
      category: "invalid_range",
      reason: `startLine exceeds file line count (${metadata.lineCount})`,
      diagnostics: [
        { severity: "error", code: "RANGE_OUT_OF_BOUNDS", message: "requested range starts after the end of the file" },
      ],
    };
  }
  return undefined;
}

function rawFailure(
  request: NormalizedReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
): PolicyFailure | undefined {
  const invalid = invalidRequestFailure(request, metadata);
  if (invalid !== undefined) return invalid;

  if (!request.wholeFile) {
    const lines = request.requestedLines ?? 0;
    if (lines > policy.maxRawLines) {
      return {
        rule: "RAW_RANGE_LINE_LIMIT",
        category: "line_limit",
        reason: `requested raw range has ${lines} lines; limit is ${policy.maxRawLines}`,
        diagnostics: [
          { severity: "warning", code: "RAW_LINE_LIMIT", message: `raw range exceeds ${policy.maxRawLines} lines` },
        ],
      };
    }
    const rangeBytes = metadata.rangeBytes ?? (metadata.byteSize <= policy.maxRawBytes ? metadata.byteSize : undefined);
    if (rangeBytes === undefined || rangeBytes > policy.maxRawBytes) {
      return {
        rule: "RAW_RANGE_BYTE_LIMIT",
        category: "byte_limit",
        reason: `requested raw range exceeds the ${policy.maxRawBytes}-byte limit`,
        diagnostics: [
          {
            severity: "warning",
            code: "RAW_BYTE_LIMIT",
            message: `raw range must be at most ${policy.maxRawBytes} bytes`,
          },
        ],
      };
    }
    return undefined;
  }

  if (metadata.lineCount > policy.allowWholeFileBelowLines) {
    return {
      rule: "RAW_WHOLE_FILE_LINE_LIMIT",
      category: "whole_file",
      reason: `whole-file raw read has ${metadata.lineCount} lines; whole-file reads require at most ${policy.allowWholeFileBelowLines}`,
      diagnostics: [
        {
          severity: "warning",
          code: "RAW_WHOLE_FILE",
          message: `whole-file raw reads are limited to ${policy.allowWholeFileBelowLines} lines`,
        },
      ],
    };
  }
  if (metadata.byteSize > policy.maxRawBytes) {
    return {
      rule: "RAW_WHOLE_FILE_BYTE_LIMIT",
      category: "byte_limit",
      reason: `whole-file raw read has ${metadata.byteSize} bytes; limit is ${policy.maxRawBytes}`,
      diagnostics: [
        {
          severity: "warning",
          code: "RAW_BYTE_LIMIT",
          message: `whole-file raw reads are limited to ${policy.maxRawBytes} bytes`,
        },
      ],
    };
  }
  return undefined;
}

function boundaryFailure(metadata: ReadFileMetadata): PolicyFailure | undefined {
  if (!metadata.withinWorkspace) {
    return {
      rule: "WORKSPACE_BOUNDARY",
      category: "workspace_boundary",
      reason: "path is outside workspaceRoot",
      diagnostics: [{ severity: "error", code: "WORKSPACE_BOUNDARY", message: "path must stay inside workspaceRoot" }],
    };
  }
  if (!metadata.symlinkSafe) {
    return {
      rule: "SYMLINK_BOUNDARY",
      category: "symlink_boundary",
      reason: "path resolves outside workspaceRoot through a symlink",
      diagnostics: [{ severity: "error", code: "SYMLINK_BOUNDARY", message: "path resolves outside workspaceRoot" }],
    };
  }
  return undefined;
}

function modeDecision(
  failure: PolicyFailure | undefined,
  request: NormalizedReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
): ReadDecision {
  const metadataProjection = {
    lineCount: metadata.lineCount,
    byteSize: metadata.byteSize,
    withinWorkspace: metadata.withinWorkspace,
    symlinkSafe: metadata.symlinkSafe,
  };
  if (failure === undefined) {
    const autoBounded = request.requestedMode === "auto" && request.mode !== "raw";
    return {
      action: "allow",
      allowed: true,
      wouldAction: "allow",
      normalizedRequest: request,
      policyMode: policy.mode,
      policyRule: autoBounded ? "AUTO_BOUNDED_REPRESENTATION" : "NONE",
      reasonCategory: autoBounded ? "auto" : "none",
      reason: autoBounded ? `auto selected ${request.mode} representation` : "read is within policy",
      diagnostics: [],
      suggestedNextActions: [],
      metadata: metadataProjection,
    };
  }

  const boundaryFailureDetected =
    failure.category === "workspace_boundary" ||
    failure.category === "symlink_boundary" ||
    failure.category === "metadata";
  if (policy.mode === "off" && !boundaryFailureDetected) {
    return {
      action: "allow",
      allowed: true,
      wouldAction: "deny",
      normalizedRequest: request,
      policyMode: policy.mode,
      policyRule: "POLICY_OFF",
      reasonCategory: failure.category,
      reason: "read governor is disabled; legacy read behavior is allowed",
      diagnostics: [],
      suggestedNextActions: [],
      metadata: metadataProjection,
    };
  }

  const action: ReadDecisionAction =
    boundaryFailureDetected || policy.mode === "enforce" ? "deny" : policy.mode === "observe" ? "observe" : "warn";
  const allowed = !boundaryFailureDetected && policy.mode !== "enforce";
  const severity: ReadDiagnostic["severity"] =
    boundaryFailureDetected || policy.mode === "enforce" ? "error" : policy.mode === "warn" ? "warning" : "info";
  const diagnostics: ReadDiagnostic[] = failure.diagnostics.map((diagnostic) => ({ ...diagnostic, severity }));
  return {
    action,
    allowed,
    wouldAction: "deny",
    normalizedRequest: request,
    policyMode: policy.mode,
    policyRule: failure.rule,
    reasonCategory: failure.category,
    reason: failure.reason,
    diagnostics,
    suggestedNextActions: nextActions(request, metadata, policy),
    metadata: metadataProjection,
  };
}

export function decideRead(
  request: ReadRequest,
  fileMetadata: ReadFileMetadata,
  policy: ReadGovernorPolicy = DEFAULT_READ_GOVERNOR_POLICY,
): ReadDecision {
  const normalized = normalizeRequest(request, fileMetadata, policy);
  if (!validMetadata(fileMetadata)) {
    return modeDecision(
      {
        rule: "FILE_METADATA_INVALID",
        category: "metadata",
        reason: "file metadata is not safe to evaluate",
        diagnostics: [{ severity: "error", code: "INVALID_METADATA", message: "file metadata is unavailable" }],
      },
      normalized,
      fileMetadata,
      policy,
    );
  }
  const boundary = boundaryFailure(fileMetadata);
  if (boundary !== undefined) return modeDecision(boundary, normalized, fileMetadata, policy);
  const failure =
    normalized.mode === "raw"
      ? rawFailure(normalized, fileMetadata, policy)
      : invalidRequestFailure(normalized, fileMetadata);
  return modeDecision(failure, normalized, fileMetadata, policy);
}
