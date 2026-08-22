import assert from "node:assert/strict";
import test from "node:test";
import {
  findSkillScenario,
  projectSkillIndexToJson,
  projectSkillIndexToText,
  projectSkillScenarioToText,
  projectTaskLaunchHelp,
} from "./skill.js";

test("skill index exposes the task launch decision playbook", () => {
  const index = projectSkillIndexToJson();
  assert.equal(index.version, "1.0.0");
  assert.deepEqual(index.scenarios.map((scenario) => scenario.id), ["choose-task-launch"]);
  assert.match(projectSkillIndexToText(), /mottainai skill choose-task-launch/u);
});

test("choose-task-launch explains the mutually exclusive claim models", () => {
  const scenario = findSkillScenario("choose-task-launch");
  assert.ok(scenario);
  const text = projectSkillScenarioToText(scenario);
  assert.match(text, /exclusive-write/u);
  assert.match(text, /\*\*:read/u);
  assert.match(text, /do not layer `task run`/iu);
  assert.match(text, /Nawabari remains the physical session\/worktree\/claim authority/u);
});

test("task start and task run help point to the launch skill and state the boundary", () => {
  const start = projectTaskLaunchHelp("start");
  const run = projectTaskLaunchHelp("run");
  assert.match(start, /\*\*:exclusive-write/u);
  assert.match(start, /alternative launch path/u);
  assert.match(run, /\*\*:read/u);
  assert.match(run, /already created by `task start`/u);
  assert.match(start, /mottainai skill choose-task-launch/u);
  assert.match(run, /mottainai skill choose-task-launch/u);
});
