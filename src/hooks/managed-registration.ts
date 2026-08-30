import fs from "node:fs";
import path from "node:path";
import {
  MANAGED_CAPABILITY_REGISTRATION_ID,
  MANAGED_CAPABILITY_REGISTRATION_MARKER,
  MANAGED_MCP_EXEC_TOOL_NAME,
  MANAGED_MCP_SERVER_NAME,
  type ManagedCapabilityIdentity,
} from "./capabilities.js";

export interface ManagedCapabilityRegistrationVerificationInput {
  workspaceRoot: string;
  homeDirectory: string;
  configPath: string;
  dispatcherCommand: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): { exists: boolean; value?: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? { exists: true, value: parsed } : { exists: true };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exists: false } : { exists: true };
  }
}

function commandWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/gu;
  for (const match of command.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) words.push(value.replace(/'\\''/g, "'"));
  }
  return words;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function registrationFromServers(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return undefined;
  const registration = value.mcpServers[MANAGED_MCP_SERVER_NAME];
  return isRecord(registration) ? registration : undefined;
}

function hasRegistration(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.mcpServers) &&
    Object.prototype.hasOwnProperty.call(value.mcpServers, MANAGED_MCP_SERVER_NAME)
  );
}

/**
 * Resolve Claude's effective project registration with its documented
 * precedence. An invalid higher-precedence registration fails closed instead
 * of falling through to a lower-precedence server with the same name.
 */
function effectiveRegistration(
  input: ManagedCapabilityRegistrationVerificationInput,
): Record<string, unknown> | undefined {
  const root = path.resolve(input.workspaceRoot);
  const homeConfig = readJson(path.join(input.homeDirectory, ".claude.json"));
  if (homeConfig.exists && homeConfig.value === undefined) return undefined;
  if (homeConfig.exists && homeConfig.value !== undefined) {
    const projects = homeConfig.value.projects;
    if (isRecord(projects) && Object.prototype.hasOwnProperty.call(projects, root)) {
      const project = projects[root];
      if (!isRecord(project) || !isRecord(project.mcpServers)) return undefined;
      const registration = project.mcpServers[MANAGED_MCP_SERVER_NAME];
      if (registration !== undefined) return isRecord(registration) ? registration : undefined;
    }
  }

  const projectConfig = readJson(path.join(root, ".mcp.json"));
  if (projectConfig.exists) {
    if (projectConfig.value === undefined) return undefined;
    if (!isRecord(projectConfig.value.mcpServers)) return undefined;
    if (hasRegistration(projectConfig.value)) return registrationFromServers(projectConfig.value);
  }

  if (homeConfig.value !== undefined && hasRegistration(homeConfig.value))
    return registrationFromServers(homeConfig.value);
  return undefined;
}

/**
 * Prove that the effective Claude registration named `mottainai` starts the
 * same Mottainai entry point and configuration used by the managed hook.
 * Claude's raw hook payload has no stronger registration identity.
 */
export function verifyManagedCapabilityRegistration(
  input: ManagedCapabilityRegistrationVerificationInput,
): ManagedCapabilityIdentity | undefined {
  const registration = effectiveRegistration(input);
  if (registration === undefined) return undefined;

  const command = registration.command;
  const args = arrayOfStrings(registration.args);
  const expectedCommand = commandWords(input.dispatcherCommand);
  if (
    typeof command !== "string" ||
    args === undefined ||
    expectedCommand.length === 0 ||
    JSON.stringify([command, ...args]) !== JSON.stringify(expectedCommand)
  )
    return undefined;

  const cwd = registration.cwd;
  if (
    cwd !== undefined &&
    (typeof cwd !== "string" || path.resolve(input.workspaceRoot, cwd) !== path.resolve(input.workspaceRoot))
  ) {
    return undefined;
  }

  const environment = registration.env;
  if (
    !isRecord(environment) ||
    environment.MOTTAINAI_MANAGED_CAPABILITY !== MANAGED_CAPABILITY_REGISTRATION_MARKER ||
    environment.MOTTAINAI_CONFIG !== path.resolve(input.configPath)
  ) {
    return undefined;
  }

  return {
    client: "claude",
    registrationId: MANAGED_CAPABILITY_REGISTRATION_ID,
    capabilityId: "process.exec",
    toolName: MANAGED_MCP_EXEC_TOOL_NAME,
  };
}
