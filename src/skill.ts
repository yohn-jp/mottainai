/** Mottainai-owned operational playbooks mapping task intents to canonical CLI workflows. */

export const SKILL_MODEL_VERSION = "1.0.0";
export const MAX_SKILL_OUTPUT_BYTES = 4096;

export interface SkillWorkflowStep {
  readonly summary: string;
  readonly command: string;
}

export interface SkillScenario {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly invariants: readonly string[];
  readonly canonicalEntrypoint: string;
  readonly helpPointer: string;
}

const HELP_DISCLAIMER = "This playbook does not restate every flag; run the help pointer for precise syntax.";

export const SKILL_SCENARIOS: readonly SkillScenario[] = [
  {
    id: "choose-task-launch",
    title: "Choose task start or task run",
    whenToUse:
      "Use before starting Issue-bound work when deciding whether Mottainai should only create the managed Git task or create it and launch a Manager agent in one operation.",
    workflow: [
      {
        summary: "Inspect whether this worktree already belongs to an active managed task.",
        command: "mottainai task status",
      },
      {
        summary: "Create only the managed task/worktree when the agent will be launched or attached separately.",
        command: "mottainai task start <slug> --type <type> --issue <issue>",
      },
      {
        summary: "Alternatively, create the Issue-bound task and launch its Manager agent as one operation.",
        command: "mottainai task run <slug> --type <type> --issue <issue> --agent <agent>",
      },
    ],
    invariants: [
      "`task start` and `task run` are alternative launch entrypoints for one task; do not layer `task run` onto a task/worktree already created by `task start`.",
      "`task start` uses the normal task execution plan; unknown scope conservatively claims `**` as `exclusive-write`.",
      "`task run` launches through Manager; when no scope is supplied its launch boundary starts with an explicit repository-wide `**:read` fallback until later semantic/task operations replace it with concrete write claims.",
      "Nawabari remains the physical session/worktree/claim authority; a claim conflict is a safety refusal, not a signal to bypass Nawabari.",
      "If the same task is already active, reuse/attach that session or finish/close it before choosing the other launch path.",
      HELP_DISCLAIMER,
    ],
    canonicalEntrypoint: "mottainai task start | mottainai task run",
    helpPointer: "mottainai skill choose-task-launch",
  },
];

export function findSkillScenario(id: string): SkillScenario | undefined {
  return SKILL_SCENARIOS.find((scenario) => scenario.id === id);
}

export interface SkillIndexProjection {
  readonly version: string;
  readonly scenarios: readonly { id: string; title: string; whenToUse: string }[];
}

export interface SkillScenarioProjection {
  readonly version: string;
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly invariants: readonly string[];
  readonly canonicalEntrypoint: string;
  readonly helpPointer: string;
}

export function projectSkillIndexToJson(): SkillIndexProjection {
  return {
    version: SKILL_MODEL_VERSION,
    scenarios: SKILL_SCENARIOS.map(({ id, title, whenToUse }) => ({ id, title, whenToUse })),
  };
}

export function projectSkillIndexToText(): string {
  const lines: string[] = [`Mottainai skill scenarios (v${SKILL_MODEL_VERSION}):`, ""];
  for (const scenario of SKILL_SCENARIOS) {
    lines.push(`  ${scenario.id} - ${scenario.title}`);
    lines.push(`    ${scenario.whenToUse}`);
  }
  lines.push("");
  lines.push("Run `mottainai skill <scenario>` for the full playbook.");
  return lines.join("\n");
}

export function projectSkillScenarioToJson(scenario: SkillScenario): SkillScenarioProjection {
  return {
    version: SKILL_MODEL_VERSION,
    id: scenario.id,
    title: scenario.title,
    whenToUse: scenario.whenToUse,
    workflow: scenario.workflow,
    invariants: scenario.invariants,
    canonicalEntrypoint: scenario.canonicalEntrypoint,
    helpPointer: scenario.helpPointer,
  };
}

export function projectSkillScenarioToText(scenario: SkillScenario): string {
  const lines: string[] = [
    `${scenario.title} (${scenario.id})`,
    "",
    `When to use: ${scenario.whenToUse}`,
    "",
    "Workflow:",
  ];
  scenario.workflow.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.summary}`);
    lines.push(`     ${step.command}`);
  });
  lines.push("");
  lines.push("Invariants:");
  for (const invariant of scenario.invariants) lines.push(`  - ${invariant}`);
  lines.push("");
  lines.push(`Canonical entrypoint: ${scenario.canonicalEntrypoint}`);
  lines.push(`Exact syntax: ${scenario.helpPointer}`);
  return lines.join("\n");
}

function bounded(output: string): string {
  return Buffer.byteLength(output, "utf8") <= MAX_SKILL_OUTPUT_BYTES
    ? output
    : `${Buffer.from(output, "utf8").subarray(0, MAX_SKILL_OUTPUT_BYTES - 4).toString("utf8")}...`;
}

export function runSkillCli(argv: readonly string[]): number {
  const json = argv.includes("--json");
  const scenarioId = argv.find((arg) => !arg.startsWith("--"));
  if (scenarioId === undefined) {
    const value = json ? JSON.stringify(projectSkillIndexToJson()) : projectSkillIndexToText();
    console.log(bounded(value));
    return 0;
  }
  const scenario = findSkillScenario(scenarioId);
  if (scenario === undefined) {
    const message = `unknown skill scenario: ${scenarioId}`;
    if (json) console.log(JSON.stringify({ ok: false, error: { code: "unknown_skill", message } }));
    else console.error(message);
    return 1;
  }
  const value = json
    ? JSON.stringify(projectSkillScenarioToJson(scenario))
    : projectSkillScenarioToText(scenario);
  console.log(bounded(value));
  return 0;
}

export function projectTaskLaunchHelp(command: "start" | "run"): string {
  if (command === "start") {
    return [
      "mottainai task start <slug> --type <type> --issue <issue> [options]",
      "",
      "Create the managed Git task/worktree without launching a Manager agent.",
      "Unknown scope uses the normal conservative `**:exclusive-write` task claim.",
      "Do not follow this with `task run` for the same task/worktree; `task run` is an alternative launch path.",
      "",
      "Use `mottainai skill choose-task-launch` for the full launch playbook.",
    ].join("\n");
  }
  return [
    "mottainai task run <slug> --type <type> --issue <issue> --agent <agent> [options]",
    "",
    "Create the Issue-bound task and launch its Manager agent in one operation.",
    "Without explicit scope, Manager starts with a repository-wide `**:read` fallback until later operations replace it with concrete write claims.",
    "Do not run this on top of a task/worktree already created by `task start`; reuse/attach that session or finish/close it first.",
    "",
    "Use `mottainai skill choose-task-launch` for the full launch playbook.",
  ].join("\n");
}
