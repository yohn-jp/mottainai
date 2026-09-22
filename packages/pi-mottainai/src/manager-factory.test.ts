import assert from "node:assert/strict";
import test from "node:test";
import { managerExecutionContextFile, managerExecutionTool } from "./manager-factory.js";

const input = {
  piGuardPath: "/tmp/pi-guard.js",
  executionContext: {
    repository: { worktree: "/tmp/worktree", branch: "feat/967" },
    task: { issueRef: "967" },
  },
  executionSurface: {
    resourceUri: "mottainai://execution" as const,
    resourceLoader: () => ({ uri: "mottainai://execution" as const, text: "{}" }),
    tool: {
      name: "mottainai_execution" as const,
      description: "Read execution facts.",
      async execute() {
        return {
          content: [{ type: "text" as const, text: "{}" }] as const,
          details: { readOnly: true as const },
        };
      },
    },
  },
};

test("projects bounded governed execution context for Pi startup", () => {
  const file = managerExecutionContextFile(input);
  assert.equal(file.path, "/virtual/MOTTAINAI_EXECUTION.md");
  assert.match(file.content, /mottainai_execution/u);
  assert.match(file.content, /feat\/967/u);
  assert.doesNotMatch(file.content, /reasoning|transcript/iu);
});

test("wraps the read-only execution surface as a Pi custom tool", async () => {
  const tool = managerExecutionTool(input.executionSurface);
  assert.equal(tool.name, "mottainai_execution");
  const result = await tool.execute("call", {}, undefined, undefined, undefined as never);
  assert.deepEqual(result.details, { readOnly: true });
});
