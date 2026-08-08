export const READ_MODES = ["raw", "outline", "symbols", "auto"] as const;
export type ReadMode = (typeof READ_MODES)[number];

export const READ_GOVERNOR_MODES = ["off", "observe", "warn", "enforce"] as const;
export type ReadGovernorMode = (typeof READ_GOVERNOR_MODES)[number];

export interface ReadGovernorPolicy {
  mode: ReadGovernorMode;
  maxRawLines: number;
  maxRawBytes: number;
  allowWholeFileBelowLines: number;
  preferAuto: boolean;
  /** 明示的な repository/user policy による whole-file raw の許可。 */
  allowWholeFile: boolean;
}

export const DEFAULT_READ_GOVERNOR_POLICY: ReadGovernorPolicy = {
  mode: "observe",
  maxRawLines: 400,
  maxRawBytes: 16_384,
  allowWholeFileBelowLines: 120,
  preferAuto: true,
  allowWholeFile: false,
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
  /** UTF-8 byte length of each logical line, excluding the separating LF. */
  lineByteLengths?: readonly number[];
  workspaceBoundaryValid?: boolean;
  symlinkBoundaryValid?: boolean;
}

export interface NormalizedReadRequest {
  path: string;
  mode: ReadMode;
  startLine?: number;
  endLine?: number;
  bounded: boolean;
}

export interface ReadDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface ReadDecision {
  action: "allow" | "observe" | "warn" | "deny";
  allowed: boolean;
  requestedMode: ReadMode;
  normalizedRequest: NormalizedReadRequest;
  policy: {
    mode: ReadGovernorMode;
    rule: string;
    reason: string;
  };
  policyRule: string;
  rule: string;
  reason: string;
  diagnostics: ReadDiagnostic[];
  suggestedNextActions: string[];
  metadata: {
    lineCount: number;
    byteSize: number;
    requestedRangeBytes?: number;
  };
}

interface RangeInfo {
  startLine: number;
  endLine: number;
  lineCount: number;
  bytes?: number;
}

interface SafeRange {
  startLine: number;
  endLine: number;
  bytes?: number;
}

function isSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value);
}

function isValidMode(value: string): value is ReadMode {
  return (READ_MODES as readonly string[]).includes(value);
}

function isValidGovernorMode(value: string): value is ReadGovernorMode {
  return (READ_GOVERNOR_MODES as readonly string[]).includes(value);
}

export function resolveReadGovernorPolicy(
  input: Partial<ReadGovernorPolicy> | undefined = undefined,
): ReadGovernorPolicy {
  const mode = input?.mode ?? DEFAULT_READ_GOVERNOR_POLICY.mode;
  if (!isValidGovernorMode(mode)) throw new Error(`invalid read governor mode: ${mode}`);
  const maxRawLines = input?.maxRawLines ?? DEFAULT_READ_GOVERNOR_POLICY.maxRawLines;
  const maxRawBytes = input?.maxRawBytes ?? DEFAULT_READ_GOVERNOR_POLICY.maxRawBytes;
  const allowWholeFileBelowLines =
    input?.allowWholeFileBelowLines ?? DEFAULT_READ_GOVERNOR_POLICY.allowWholeFileBelowLines;
  const preferAuto = input?.preferAuto ?? DEFAULT_READ_GOVERNOR_POLICY.preferAuto;
  const allowWholeFile = input?.allowWholeFile ?? DEFAULT_READ_GOVERNOR_POLICY.allowWholeFile;

  if (!Number.isSafeInteger(maxRawLines) || maxRawLines <= 0) throw new Error("invalid read governor maxRawLines");
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0) throw new Error("invalid read governor maxRawBytes");
  if (!Number.isSafeInteger(allowWholeFileBelowLines) || allowWholeFileBelowLines < 0) {
    throw new Error("invalid read governor allowWholeFileBelowLines");
  }
  if (typeof preferAuto !== "boolean") throw new Error("invalid read governor preferAuto");
  if (typeof allowWholeFile !== "boolean") throw new Error("invalid read governor allowWholeFile");

  return { mode, maxRawLines, maxRawBytes, allowWholeFileBelowLines, preferAuto, allowWholeFile };
}

function rangeBytes(metadata: ReadFileMetadata, startLine: number, endLine: number): number | undefined {
  const lengths = metadata.lineByteLengths;
  if (lengths === undefined) return undefined;
  if (startLine < 1 || endLine < startLine || endLine > lengths.length) return undefined;
  let bytes = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    bytes += lengths[line - 1];
    if (line > startLine) bytes += 1;
  }
  return bytes;
}

function explicitRange(request: ReadRequest, metadata: ReadFileMetadata): RangeInfo | undefined {
  const hasStart = request.startLine !== undefined;
  const hasEnd = request.endLine !== undefined;
  if (!hasStart && !hasEnd) return undefined;
  const startLine = request.startLine ?? 1;
  const endLine = request.endLine;
  if (!isSafeInteger(startLine) || startLine < 1 || !isSafeInteger(endLine) || endLine < startLine) return undefined;
  return {
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    bytes: rangeBytes(metadata, startLine, endLine),
  };
}

function safeRange(metadata: ReadFileMetadata, startLine: number, policy: ReadGovernorPolicy): SafeRange | undefined {
  const lineCount = Math.max(1, metadata.lineCount);
  if (startLine < 1 || startLine > lineCount) return undefined;
  const maximumEnd = Math.min(lineCount, startLine + policy.maxRawLines - 1);
  const lengths = metadata.lineByteLengths;
  if (lengths === undefined) {
    return { startLine, endLine: maximumEnd };
  }

  let bytes = 0;
  let endLine = startLine - 1;
  for (let line = startLine; line <= maximumEnd; line += 1) {
    const nextBytes = bytes + lengths[line - 1] + (line === startLine ? 0 : 1);
    if (nextBytes > policy.maxRawBytes) break;
    bytes = nextBytes;
    endLine = line;
  }
  if (endLine < startLine) return undefined;
  return { startLine, endLine, bytes };
}

function normalized(request: ReadRequest, mode: ReadMode, range?: SafeRange | RangeInfo): NormalizedReadRequest {
  return {
    path: request.path,
    mode,
    ...(range === undefined ? {} : { startLine: range.startLine, endLine: range.endLine }),
    bounded: range !== undefined,
  };
}

function nextActions(metadata: ReadFileMetadata, policy: ReadGovernorPolicy): string[] {
  const endLine = Math.min(Math.max(1, metadata.lineCount), policy.maxRawLines);
  return [
    "use mode:auto",
    "request outline",
    "request symbols",
    "search for a specific identifier",
    `request raw lines 1-${endLine}`,
  ];
}

function actionFor(policy: ReadGovernorPolicy): ReadDecision["action"] {
  if (policy.mode === "enforce") return "deny";
  if (policy.mode === "warn") return "warn";
  if (policy.mode === "observe") return "observe";
  return "allow";
}

function decision(
  requestedMode: ReadMode,
  normalizedRequest: NormalizedReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
  rule: string,
  reason: string,
  requestedRangeBytes?: number,
  forceDeny = false,
  suggestedNextActions = nextActions(metadata, policy),
  actionOverride?: ReadDecision["action"],
): ReadDecision {
  const action = forceDeny ? "deny" : (actionOverride ?? actionFor(policy));
  const severity = action === "deny" ? "error" : action === "allow" ? "info" : "warning";
  const diagnostics: ReadDiagnostic[] =
    action === "allow" && rule === "NONE" ? [] : [{ severity, code: rule, message: reason }];
  return {
    action,
    allowed: action !== "deny",
    requestedMode,
    normalizedRequest,
    policy: { mode: policy.mode, rule, reason },
    policyRule: rule,
    rule,
    reason,
    diagnostics,
    suggestedNextActions,
    metadata: {
      lineCount: metadata.lineCount,
      byteSize: metadata.byteSize,
      ...(requestedRangeBytes === undefined ? {} : { requestedRangeBytes }),
    },
  };
}

function allowed(
  request: ReadRequest,
  requestedMode: ReadMode,
  normalizedRequest: NormalizedReadRequest,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
  rule = "NONE",
  reason = "read is within the configured disclosure policy",
  requestedRangeBytes?: number,
): ReadDecision {
  return decision(
    requestedMode,
    normalizedRequest,
    metadata,
    policy,
    rule,
    reason,
    requestedRangeBytes,
    false,
    rule === "NONE" ? [] : nextActions(metadata, policy),
    "allow",
  );
}

function invalidBoundary(
  request: ReadRequest,
  requestedMode: ReadMode,
  metadata: ReadFileMetadata,
  policy: ReadGovernorPolicy,
  rule: string,
  reason: string,
): ReadDecision {
  return decision(
    requestedMode,
    normalized(request, requestedMode),
    metadata,
    policy,
    rule,
    reason,
    undefined,
    true,
    [],
  );
}

export function decideRead(
  request: ReadRequest,
  fileMetadata: ReadFileMetadata,
  inputPolicy: ReadGovernorPolicy = DEFAULT_READ_GOVERNOR_POLICY,
): ReadDecision {
  const policy = resolveReadGovernorPolicy(inputPolicy);
  const requestedModeValue = request.mode ?? (policy.preferAuto ? "auto" : "raw");
  if (!isValidMode(requestedModeValue)) throw new Error(`invalid read mode: ${requestedModeValue}`);
  const requestedMode = requestedModeValue;

  if (fileMetadata.workspaceBoundaryValid === false) {
    return invalidBoundary(
      request,
      requestedMode,
      fileMetadata,
      policy,
      "WORKSPACE_BOUNDARY_INVALID",
      "workspace boundary is invalid",
    );
  }
  if (fileMetadata.symlinkBoundaryValid === false) {
    return invalidBoundary(
      request,
      requestedMode,
      fileMetadata,
      policy,
      "SYMLINK_BOUNDARY_INVALID",
      "symlink boundary is invalid",
    );
  }
  if (
    !Number.isSafeInteger(fileMetadata.lineCount) ||
    fileMetadata.lineCount < 0 ||
    !Number.isSafeInteger(fileMetadata.byteSize) ||
    fileMetadata.byteSize < 0
  ) {
    return invalidBoundary(
      request,
      requestedMode,
      fileMetadata,
      policy,
      "INVALID_FILE_METADATA",
      "file metadata is invalid",
    );
  }

  const range = explicitRange(request, fileMetadata);
  const hasRangeArguments = request.startLine !== undefined || request.endLine !== undefined;
  if (hasRangeArguments && range === undefined) {
    return invalidBoundary(
      request,
      requestedMode,
      fileMetadata,
      policy,
      "INVALID_RANGE",
      "startLine and endLine must be valid bounded lines",
    );
  }

  const actualLineCount = Math.max(1, fileMetadata.lineCount);
  if (range !== undefined && range.endLine > actualLineCount) {
    const normalizedRequest = normalized(request, requestedMode, range);
    return decision(
      requestedMode,
      normalizedRequest,
      fileMetadata,
      policy,
      "RANGE_OUT_OF_BOUNDS",
      `requested range ends after the file's ${fileMetadata.lineCount} lines`,
      range.bytes,
      policy.mode === "enforce",
    );
  }

  const requestedRangeBytes = range?.bytes;
  const rangeWithinLimits =
    range !== undefined &&
    range.lineCount <= policy.maxRawLines &&
    (range.bytes === undefined || range.bytes <= policy.maxRawBytes);

  if (requestedMode === "raw") {
    if (range !== undefined) {
      if (rangeWithinLimits || policy.mode === "off") {
        return allowed(
          request,
          requestedMode,
          normalized(request, "raw", range),
          fileMetadata,
          policy,
          "NONE",
          "explicit raw range is within the configured bounds",
          requestedRangeBytes,
        );
      }
      const rule = range.lineCount > policy.maxRawLines ? "RAW_RANGE_LINE_LIMIT" : "RAW_RANGE_BYTE_LIMIT";
      const reason =
        range.lineCount > policy.maxRawLines
          ? `raw range requests ${range.lineCount} lines; maximum is ${policy.maxRawLines}`
          : `raw range requests ${range.bytes ?? "unknown"} bytes; maximum is ${policy.maxRawBytes}`;
      return decision(
        requestedMode,
        normalized(request, "raw", range),
        fileMetadata,
        policy,
        rule,
        reason,
        requestedRangeBytes,
      );
    }

    const wholeFileAllowed =
      policy.allowWholeFile ||
      (fileMetadata.lineCount <= policy.allowWholeFileBelowLines && fileMetadata.byteSize <= policy.maxRawBytes);
    if (wholeFileAllowed || policy.mode === "off") {
      return allowed(
        request,
        requestedMode,
        normalized(request, "raw"),
        fileMetadata,
        policy,
        "NONE",
        "whole-file raw is permitted by policy",
        fileMetadata.byteSize,
      );
    }
    return decision(
      requestedMode,
      normalized(request, "raw"),
      fileMetadata,
      policy,
      fileMetadata.lineCount > policy.allowWholeFileBelowLines
        ? "WHOLE_FILE_RAW_LINE_LIMIT"
        : "WHOLE_FILE_RAW_BYTE_LIMIT",
      fileMetadata.lineCount > policy.allowWholeFileBelowLines
        ? `whole-file raw requests ${fileMetadata.lineCount} lines; small-file threshold is ${policy.allowWholeFileBelowLines}`
        : `whole-file raw requests ${fileMetadata.byteSize} bytes; maximum is ${policy.maxRawBytes}`,
      fileMetadata.byteSize,
    );
  }

  if (requestedMode === "auto" && rangeWithinLimits) {
    return allowed(
      request,
      requestedMode,
      normalized(request, "raw", range),
      fileMetadata,
      policy,
      "NONE",
      "auto selected a bounded raw range",
      requestedRangeBytes,
    );
  }

  const wholeRequest = range === undefined;
  const smallWholeFile =
    wholeRequest &&
    fileMetadata.lineCount <= policy.allowWholeFileBelowLines &&
    fileMetadata.byteSize <= policy.maxRawBytes;
  if (wholeRequest && (smallWholeFile || policy.allowWholeFile)) {
    return allowed(
      request,
      requestedMode,
      normalized(request, requestedMode === "auto" ? "raw" : requestedMode),
      fileMetadata,
      policy,
      "NONE",
      "representation is within the small-file threshold",
      fileMetadata.byteSize,
    );
  }

  const sourceRange =
    range === undefined ? safeRange(fileMetadata, 1, policy) : safeRange(fileMetadata, range.startLine, policy);
  if (sourceRange === undefined) {
    return decision(
      requestedMode,
      normalized(request, requestedMode, range),
      fileMetadata,
      policy,
      "NO_SAFE_BOUNDED_RANGE",
      `no ${policy.maxRawBytes}-byte bounded range is available for ${requestedMode}`,
      requestedRangeBytes,
      policy.mode === "enforce",
    );
  }

  const selectedMode = requestedMode === "auto" ? "outline" : requestedMode;
  const boundedReason = wholeRequest
    ? `${requestedMode} selected a bounded ${selectedMode} representation before broad source access`
    : `${selectedMode} range normalized to the configured bounded disclosure limits`;
  const boundedRule = wholeRequest ? "AUTO_BOUNDED_REPRESENTATION" : "BOUNDED_RANGE";
  const boundedDecision = allowed(
    request,
    requestedMode,
    normalized(request, selectedMode, sourceRange),
    fileMetadata,
    policy,
    boundedRule,
    boundedReason,
    requestedRangeBytes,
  );
  if (boundedRule === "BOUNDED_RANGE" && range !== undefined && !rangeWithinLimits) {
    boundedDecision.diagnostics = [{ severity: "warning", code: boundedRule, message: boundedReason }];
  }
  return boundedDecision;
}
