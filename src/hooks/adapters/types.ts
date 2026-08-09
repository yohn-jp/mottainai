import type { TrustedHookContext } from "../context.js";
import type { HookClient, HookDecision, HookEvent } from "../types.js";

export interface HookAdapterContext extends TrustedHookContext {
  workspaceRoot: string;
}

export interface HookAdapterSuccess {
  ok: true;
  event: HookEvent;
}

export interface HookAdapterFailure {
  ok: false;
  reason: "malformed_client_event" | "adapter_unsupported";
  detail: string;
}

export type HookAdapterResult = HookAdapterSuccess | HookAdapterFailure;

export interface HookProjection {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookDiscoveryContext {
  workspaceRoot: string;
  homeDirectory: string;
  resolveCommand: (command: string) => string | undefined;
  probeVersion: (executable: string) => string | undefined;
}

export type ClientInstallState = "installed" | "not-installed" | "unsupported" | "incompatible";
export type ClientCompatibility = "compatible" | "unknown" | "incompatible";

export interface ClientDiscovery {
  client: HookClient;
  adapterVersion: string;
  state: ClientInstallState;
  compatibility: ClientCompatibility;
  clientVersion?: string;
  executable?: string;
  configPath: string;
  configPresent: boolean;
  configValid: boolean;
  reason?: string;
}

export interface ManagedHookDescriptor {
  marker: string;
  eventName: string;
  matcher: string;
  command: string;
}

export interface HookClientAdapter {
  readonly client: HookClient;
  readonly adapterVersion: string;
  readonly configRelativePath: string;
  readonly eventName: string;
  readonly matcher: string;
  configPath(context: { workspaceRoot: string; homeDirectory: string }): string;
  normalize(raw: unknown, context: HookAdapterContext): HookAdapterResult;
  project(decision: HookDecision, event: HookEvent): HookProjection;
  supportsDocument(value: unknown): boolean;
}
