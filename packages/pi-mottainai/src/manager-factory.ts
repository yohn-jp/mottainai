import {
  DefaultResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiMottainaiRuntime, type WorkerRuntimeAdapter } from "./runtime.js";

export interface ManagedPiExecutionSurface {
  readonly resourceUri: "mottainai://execution";
  readonly resourceLoader: () => { uri: "mottainai://execution"; text: string };
  readonly tool: {
    readonly name: "mottainai_execution";
    readonly description: string;
    readonly execute: () => Promise<{
      content: readonly [{ type: "text"; text: string }];
      details: { readonly readOnly: true };
    }>;
  };
}

export interface ManagedPiRuntimeInput {
  readonly piGuardPath: string;
  readonly executionContext: {
    readonly repository: { readonly worktree: string };
    readonly [key: string]: unknown;
  };
  readonly executionSurface: ManagedPiExecutionSurface;
}

export function managerExecutionTool(surface: ManagedPiExecutionSurface): ToolDefinition {
  return {
    name: surface.tool.name,
    label: "Mottainai execution",
    description: surface.tool.description,
    promptSnippet: "Read the canonical admitted Mottainai execution facts.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    async execute() {
      return surface.tool.execute();
    },
  };
}

export function managerExecutionContextFile(input: ManagedPiRuntimeInput): { path: string; content: string } {
  return {
    path: "/virtual/MOTTAINAI_EXECUTION.md",
    content: [
      "# Mottainai governed execution",
      "",
      "This Pi session is bound to a Mottainai-governed execution.",
      "Use the read-only mottainai_execution tool for exact current execution facts.",
      "Do not rediscover your assigned branch, base, worktree, authority, scope, or verification contract via Git history.",
      "",
      "Startup projection:",
      JSON.stringify(input.executionContext),
    ].join("\n"),
  };
}

/**
 * Construct the production Pi SDK runtime while keeping Pi-specific loader
 * semantics inside the adapter package.
 */
export async function createManagedPiMottainaiRuntime(input: ManagedPiRuntimeInput): Promise<WorkerRuntimeAdapter> {
  const cwd = input.executionContext.repository.worktree;
  const contextFile = managerExecutionContextFile(input);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    additionalExtensionPaths: [input.piGuardPath],
    agentsFilesOverride: (current) => ({
      agentsFiles: [...current.agentsFiles, contextFile],
    }),
  });
  await resourceLoader.reload();

  return new PiMottainaiRuntime({
    sessionOptions: {
      cwd,
      resourceLoader,
      customTools: [managerExecutionTool(input.executionSurface)],
    },
  });
}
