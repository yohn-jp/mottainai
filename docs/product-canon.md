# Mottainai — Product Canon

**Version:** 0.1 — Proposed  
**Scope:** Product vision, principles, outcomes, and boundaries  
**Status:** Adoption candidate

## 1. Product Vision

**Humans decide what should be achieved. Mottainai brings it to completion.**

Mottainai turns the capabilities of AI in software development into continuous, governed development outcomes rather than isolated conversations or one-off code generation.

Given a human-defined objective, requirements, constraints, and authority, Mottainai understands the necessary work, decomposes it, assigns it to appropriate executors, runs independent work concurrently, integrates the results, verifies them, and converges toward completion.

Humans should not have to issue fresh instructions for each step.

When work fails, Mottainai retains the information needed to recover and continues work that can safely proceed.

Only decisions that genuinely require human judgment are escalated, together with their rationale and available choices.

What Mottainai delivers is not an AI response or a record of activity, but **software outcomes that can be used, integrated, and evaluated**.

## 2. The Fundamental Problem

Improvements in AI coding capability do not, by themselves, make the entire software development process autonomous.

In complex development, humans still shoulder the work of:

- Breaking goals into executable assignments for individual AIs.
- Resolving dependencies and conflicts, sequencing work, and managing concurrency.
- Repeatedly explaining background, requirements, and constraints to different agents.
- Checking progress and deciding which assignment should start next.
- Reconciling outputs and recovering from conflicts and failures.
- Iterating through implementation, review, verification, and integration until the result is complete.

Once an objective is settled, much of this coordination should not require continuous human involvement.

Mottainai takes responsibility for coordination, execution, and recovery, leaving human attention available for product strategy, requirements, significant technical decisions, and final acceptance.

## 3. Intended Users and Value

Mottainai primarily serves individual developers, technical leads, and development teams of any size that perform multiple AI-assisted development tasks concurrently.

Its product value must not depend on a particular programming language, repository, AI model, service provider, or execution environment.

Its value is not merely faster code generation.

**It enables more correct development outcomes to be completed continuously and predictably with less human intervention.**

## 4. The Product Experience

### 4.1 From Objective to Outcome

A user provides the desired end state and necessary constraints.

Mottainai understands the gap between that objective and the current state, and identifies the work required to close it.

Where requirements are sufficiently defined, it does not ask the user to approve every execution step.

When requirements are undecided, contradictory, or outside delegated authority, it identifies the specific decision needed.

Throughout execution, the work remains aligned with the original objective.

### 4.2 Autonomous Execution and Continuation

Mottainai autonomously coordinates work initiation, assignment, progression, retry, repair, and completion assessment.

Humans need not repeatedly poll for status or allocate the next task.

Once dependencies clear, eligible work becomes executable automatically within the authorized constraints.

Failures in individual tasks do not prevent independent tasks from continuing.

**Development continues to make progress even when no human is watching.**

### 4.3 Effective Use of Available Capabilities

Mottainai treats available AIs, tools, and computing resources as execution capabilities serving the outcome.

It combines executors with differing strengths, quality, costs, speed, and constraints, assigning each task to an appropriate capability.

It does not waste expensive reasoning on trivial work or force lightweight executors to make judgments beyond their ability.

Independent work is parallelized, but increasing concurrency is not a goal when conflicts and rework would make overall completion slower.

The core product experience does not change when an individual AI or execution mechanism becomes unavailable.

### 4.4 Integration of Complex Work

Mottainai does not merely run assignments independently; it integrates them into one coherent completed outcome.

It continuously accounts for dependencies, modification boundaries, consistency, and completion criteria.

Correct individual assignments do not guarantee a correct combined system.

Mottainai therefore distinguishes local success from overall completion.

**Its responsibility is the correctness of the integrated outcome, not merely the success of parallel execution.**

### 4.5 Convergence on Quality

Mottainai does not stop when the first implementation is written.

It compares requirements, observed behavior, verification results, reviews, and failure evidence, then repairs demonstrated gaps.

It distinguishes established facts, unverified hypotheses, and states that cannot be verified.

It does not report an unverified or failed result as complete.

When a repair introduces a new defect, it restores consistency against the original objective.

This does not mean that correctness can be ignored during implementation. It means distinguishing first-pass completeness from the quality of the final integrated outcome and prioritizing the latter.

### 4.6 Continuity of State and Knowledge

Knowledge and progress required for development must not live solely in one AI conversation or ephemeral execution environment.

When humans or AI executors change, objectives, decisions, task state, deliverables, and verification evidence remain transferable.

After interruption, it is possible to determine what is complete, what remains, and where execution can safely resume.

Investigation and decisions are not repeated merely because their previous context was lost.

**Executors are replaceable; work and evidence persist.**

### 4.7 Safety and Authority

Autonomy does not imply unlimited operational authority.

Mottainai maximizes useful execution within the permissions and constraints supplied by the user.

Executors must not unilaterally expand task scope or interfere with unrelated work and assets.

Untrusted information must not be promoted into user instructions or authorization.

When work encounters insufficient authority, uncertain external effects, or a significant security decision, Mottainai reports the issue instead of silently bypassing it.

A task stopped for safety is not necessarily a failed task; claiming success while concealing the reason for the stop is unacceptable.

### 4.8 Appropriate Communication with Humans

Making users read extensive execution logs or continuous progress narration is not Mottainai's purpose.

Normally, users need a clear view of overall progress, completed outcomes, remaining work, and material risks.

When intervention is needed, Mottainai states what happened, which objective is affected, why the issue cannot be resolved autonomously, and what decision is required.

Evidence for decisions and execution remains inspectable when needed.

Transparency is not synonymous with volume of information.

**Users receive the information necessary to make the right decision at the time that decision is required.**

## 5. Responsibilities of Humans and Mottainai

Humans own product objectives, requirements, acceptable risks, execution authority, and final acceptance.

Mottainai takes responsibility for planning, coordination, assignment, tracking, evidence collection, repair, and integration in pursuit of approved objectives.

Ordinary implementation decisions may be made autonomously within delegated authority.

Material changes to objectives or requirements, significant privilege expansion, and acceptance of consequential risk remain human decisions unless explicitly delegated.

This boundary persists even as the capabilities of executors improve.

Mottainai's ideal is not to remove humans from development, but **to avoid waiting for them except where human judgment is actually needed**.

## 6. Efficiency

Mottainai does not measure efficiency by token count, AI invocation count, or execution duration alone.

The relevant measure is the total cost of delivering an outcome that can be accepted.

That cost includes model usage, compute, waiting, duplicate work, failure-driven rework, human intervention, integration, and verification.

Saving tokens at the expense of more rework is not efficiency.

If additional high-quality reasoning reduces total completion cost, spending more tokens is the right choice.

**Mottainai minimizes resource consumption that does not contribute to outcomes, rather than minimizing tokens themselves.**

## 7. Definition of Completion

A task is not complete simply because an AI process terminated or some code exists.

Completion means the intended objective and constraints have been met, the required verification has been performed, and the result can be handed to the next legitimate stage of use.

When evidence necessary to establish completion is missing, Mottainai reports that gap.

When work required for completion remains, it is explicitly incomplete.

When external approval or permission is necessary, Mottainai respects that boundary and produces the strongest handoff state it can lawfully achieve.

At the product level, Mottainai should continually converge multiple independent and dependent development tasks toward completion—not merely handle one isolated fix.

## 8. Non-Goals

Mottainai is not intended to be merely a chat AI, code generation model, token compression utility, task board, or CI executor.

Nor is reproducing every external capability internally a goal.

It should use existing capabilities where appropriate while coordinating them toward a single development objective.

Agent count, supported-model count, tool count, and feature count are not success measures in themselves.

It is not a goal to let an AI unilaterally redefine a human's product objectives or disregard legitimate authority boundaries in the name of autonomy.

## 9. Product Success Measures

Product maturity is assessed through outcomes:

**Delivery:** The proportion of work that actually satisfies acceptance criteria and the time to completion.

**Autonomy:** Reduction in human status polling, task reassignment, repeated instruction, and manual recovery.

**Quality:** Reduction in defects after final integration, rework, and unsupported claims of verified success.

**Continuity:** Ability to resume after interruption or executor replacement without losing work, decisions, or evidence.

**Efficiency:** Improvement in the total cost per accepted outcome, including human time, inference, compute, and rework.

**Trust:** Ability of users to rely on reported state, supporting evidence, and respected authority boundaries when making decisions.

These measures should be evaluated through real software development, not a single benchmark or model score.

## 10. Highest-Level Product Principles

When deciding whether to adopt a feature or design:

1. **Prioritize the objective.** Follow the user's desired end state, not an incidental implementation or existing structure.
2. **Establish correctness with evidence.** Do not conflate execution, success, and completion.
3. **Reduce human intervention.** Do not return automatable coordination to humans; request only decisions that matter.
4. **Use available capabilities effectively.** Exploit parallelism and execution capacity within authorized constraints.
5. **Continue through failure.** Do not let a failed execution destroy the work as a whole.
6. **Respect authority and truth.** Do not sacrifice legitimate permissions, safety, or evidence for autonomy or speed.
7. **Optimize total cost.** Favor end-to-end completion efficiency over local token or invocation savings.
8. **Do not mistake means for ends.** Do not tie the product's reason for being to a particular AI, runtime, framework, or existing implementation.

---

## Product North Star

**Mottainai enables a human to define what should be built, then autonomously coordinates the work required to deliver a verified result—without wasting human attention, losing context, or compromising control.**

Humans determine the objective.

Mottainai coordinates the intelligence and execution capacity required to achieve it.

And brings the work to completion.
