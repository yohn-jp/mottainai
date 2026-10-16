# Mottainai — Product Capability Model

**Version:** 0.1 — Proposed  
**Status:** Phase 2 adoption candidate  
**Authority:** [Product Canon](product-canon.md)  
**Scope:** Product capabilities and acceptance outcomes, independent of implementation

## 1. Purpose and interpretation

This document translates the Product Canon into an assessable set of **product capabilities**. It specifies what Mottainai must be able to accomplish for its users, not how the software must be built.

A *capability* is a durable user-facing responsibility with an observable success or failure outcome. A *scenario* is an end-to-end demonstration that several capabilities work together. An *invariant* must hold across all capabilities. A *design decision* chooses how to realize these obligations and belongs to Phase 3 or later.

All capabilities below describe the intended complete product. Their order does not imply implementation priority or a minimum viable release. Neither an existing implementation nor a current Issue is evidence that a capability is required, satisfied, or unnecessary.

The model covers software development objectives that may span one or more projects, workspaces, codebases, environments, and stages of delivery. It does not assume a particular issue tracker, source-control system, AI provider, process runtime, transport, interface, or deployment mechanism.

### 1.1 The product promise

With an authorized objective and sufficient execution resources, a user can delegate software development work, leave it unattended, and return to an accurate account of **what was achieved, what remains, what was verified, and what genuinely needs a human decision**.

The product must not imply that all work can finish autonomously: missing authority, missing evidence, insufficient resources, and inherently human decisions are legitimate, explicit outcomes.

### 1.2 Contract vocabulary

- **Objective:** A human-defined desired software outcome and its constraints, authority, and acceptance expectations.
- **Work item:** A bounded unit of necessary progress toward an objective; not necessarily equivalent to a provider-specific ticket.
- **Executor:** An available AI, tool, compute facility, or authorized human action capable of performing an assigned role.
- **Evidence:** An attributable observation or result that supports, qualifies, or contradicts a claim.
- **Decision:** A choice whose authority, rationale, and consequences are explicit.
- **Outcome:** A delivered result together with its verified, unverified, blocked, or awaiting-acceptance condition.
- **Completion:** Satisfaction of the delegated objective, its constraints, and required verification; distinct from activity termination and distinct from human acceptance unless acceptance was delegated.

These are product concepts, **not prescribed classes, schemas, services, identifiers, or state-machine enums**.

## 2. Capability catalog

Each stable ID identifies one product responsibility. "Demonstration of fulfillment" states the observable evidence expected from a complete product; it does not prescribe a particular test harness.

### 2.1 Objective and authority definition

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| OBJ-01 | Capture the intended outcome | Preserve the user's desired end state, target scope, constraints, permissions, and completion intent without substituting an executor's objective. | A delegated task remains traceable to the original request; omitted constraints are not invented. |
| OBJ-02 | Establish actionable requirements | Identify missing, conflicting, ambiguous, or materially under-specified requirements and distinguish resolvable implementation choices from decisions reserved for humans. | Clear requests proceed without repetitive questions; an ambiguous consequential requirement yields a precise question before the affected action. |
| OBJ-03 | Define acceptance and proof | Establish what must be true at completion, which evidence is needed, and which decisions or approvals remain external. | A reviewer can distinguish the intended deliverable, required verification, and acceptance authority before execution. |
| OBJ-04 | Govern objective changes | Track approved requirement changes and their implications without silently replacing the original objective or treating untrusted suggestions as amendments. | Mid-execution changes have clear approval and impact; unaffected work continues where valid. |

### 2.2 Understanding and planning the work

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| PLN-01 | Establish the relevant current state | Obtain enough trustworthy, current evidence about the target and prior work to identify the gap, explicitly acknowledging unknown or stale information. | The proposed work reflects verified target conditions; unavailable state is never assumed favorable. |
| PLN-02 | Derive and bound necessary work | Decompose the gap into sufficiently independent, assessable work and avoid work not justified by the objective or its constraints. | Every proposed work item supports an acceptance condition or necessary dependency; unnecessary work is excluded. |
| PLN-03 | Model dependencies and readiness | Identify prerequisites, conflicts, decision gates, and resource constraints; distinguish runnable work from blocked or unknown work. | Independent work becomes eligible without manual rediscovery when authoritative blockers clear; stale evidence never makes work ready. |
| PLN-04 | Replan on material evidence | Adapt the work plan when results, failures, or approved changes alter feasibility or dependencies, while preserving decisions and scope. | A failed assumption changes the affected work plan and its explanation rather than triggering repeated or unauthorized work. |
| PLN-05 | Maintain whole-objective consistency | Track how local work contributes to the combined result across projects or components, including incompatible assumptions and overlapping modifications. | Contradictory outputs or competing edits are surfaced before claiming integrated completion. |

### 2.3 Resource and capability coordination

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| RES-01 | Understand available execution capability | Know which executors and resources are actually available, their relevant limits and permissions, and the uncertainty or freshness of that knowledge. | An unavailable model, tool, or environment is not selected as though ready. |
| RES-02 | Match work to competent executors | Select or delegate based on task demands, executor strengths, reliability, constraints, and expected total completion cost. | A high-judgment task is not silently assigned to an incapable executor; a simpler valid option may be preferred when it improves overall outcomes. |
| RES-03 | Coordinate capacity and concurrency | Use authorized parallel capacity for independent work while accounting for dependencies, resource contention, and integration costs. | Multiple ready tasks progress concurrently where beneficial; capacity limits and conflicting ownership are respected. |
| RES-04 | Adapt to resource changes | Respond to lost capacity, changed availability, and exhausted budgets without pretending that execution continued or relocating work beyond authorization. | The affected work becomes delayed, reassigned where authorized and safe, or blocked with the relevant reason; unrelated work can continue. |

### 2.4 Governed execution and integration

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| EXE-01 | Admit bounded work | Give an executor only authorized goals, capabilities, information, and change scope appropriate to its assignment. | Work outside admitted scope cannot be treated as an authorized contribution, even when an executor proposes it. |
| EXE-02 | Execute without coordinator polling | Advance admitted work, observe progress and terminal events, and release newly ready work without a human or supervising model repeatedly asking for status. | A multi-item objective advances through dependency releases while the user is absent. |
| EXE-03 | Correlate attempts and effects | Distinguish work identity, individual attempts, observed results, and external side effects so that retry or reconnection does not manufacture duplicate execution. | A repeated request or lost acknowledgement cannot silently apply the same consequential change twice. |
| EXE-04 | Integrate independent contributions | Reconcile outputs into a coherent candidate, resolving mechanical conflicts within delegated authority and escalating genuine semantic or permission decisions. | Locally successful but incompatible work is not reported as a globally complete result. |
| EXE-05 | Recover or terminate deliberately | Continue, retry, pause, cancel, or terminate work using actual observations and authorized policy; preserve unaffected work and evidence. | Failure or interruption has an attributable, recoverable outcome; no unbounded retry or invented cleanup guarantee occurs. |

### 2.5 Durable knowledge and continuity

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| CTX-01 | Preserve authoritative work memory | Retain objectives, approvals, decisions, relevant facts, assignment relationships, outcomes, and evidence independently of an individual conversation or executor. | A newly assigned executor can determine what is settled, pending, and forbidden without reconstructing it from chat history. |
| CTX-02 | Deliver relevant, bounded context | Provide the information necessary for correct action, distinguish sources and uncertainty, and allow retrieval of omitted material when needed. | Context limits do not silently discard a required constraint or turn a partial summary into complete evidence. |
| CTX-03 | Resume after interruption | Reconcile durable work records with actual executor and external state before continuing or creating replacement work. | After a restart, already completed or still running work is not duplicated; missing observations remain explicitly unknown. |
| CTX-04 | Preserve traceability over time | Retain relationships between objective, decision, action, result, verification, and later correction as the work evolves. | A user can identify why a material action was taken and what evidence supported its completion claim. |

### 2.6 Verification, correction, and completion

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| QLT-01 | Define evidence appropriate to risk | Determine which checks and observations are needed to support each acceptance condition, including integration, failure, and security boundaries where material. | A declared proof explains what it establishes and what it cannot establish. |
| QLT-02 | Establish result truthfully | Evaluate actual outcomes against requirements, distinguish local from integrated proof, and carry forward failures, omissions, and uncertainty. | Passing an isolated check does not imply integration success; missing verification is never shown as passing. |
| QLT-03 | Converge through bounded repair | Translate substantiated deficiencies into authorized correction work, repeat verification where the result was affected, and stop or escalate when progress cannot be justified. | An observed regression produces targeted correction and renewed proof rather than a false success or an endless repair loop. |
| QLT-04 | Determine deliverability and completion | Declare what is fulfilled, what remains, and whether a verified deliverable is ready for the authorized next stage; keep final acceptance separate unless delegated. | A user can tell whether the work is verified, ready for acceptance, blocked, or incomplete, with supporting evidence. |

### 2.7 Human direction and intelligible oversight

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| HUM-01 | Escalate only necessary judgment | Present unresolved requirements, consequential risk, or unauthorized changes as actionable decisions with alternatives, impact, and a safe default of non-action. | A human receives one bounded decision request, not an undifferentiated stream of low-level errors. |
| HUM-02 | Provide accurate aggregate visibility | Show objective-level progress, delivered results, unresolved risks, blockers, and evidence freshness without requiring users to follow every executor. | A user can assess actual progress and intervention needs without inspecting raw execution transcripts. |
| HUM-03 | Support intentional intervention | Allow authorized humans to inspect, change approved objectives, pause, resume, cancel, or withdraw permissions with effects and limits clearly stated. | Intervention affects the intended scope; irreversible effects and any incomplete cancellation are not concealed. |
| HUM-04 | Enable explicit handoff | Present verified deliverables, remaining approvals, assumptions, limitations, and supporting evidence to the next legitimate owner or stage. | A user can accept, reject, or continue work without rediscovering prior decisions. |

### 2.8 Trust and resource accountability

| ID | Capability | Required product behavior | Demonstration of fulfillment |
| --- | --- | --- | --- |
| TRU-01 | Enforce delegated authority | Keep every action within the user's scope, applicable organizational policy, and required isolation between unrelated assets and assignments. | An executor cannot use access from one objective to authorize an unrelated action. |
| TRU-02 | Preserve instruction provenance | Distinguish the user's instructions and approved decisions from tool output, retrieved content, and other untrusted material. | Malicious or conflicting material encountered during work cannot elevate its own authority. |
| TRU-03 | Protect sensitive information | Apply appropriate confidentiality, access control, and disclosure limits to credentials, user data, work artifacts, and observability outputs. | An ordinary executor or progress viewer does not gain unrelated secrets or privileged diagnostic data. |
| TRU-04 | Reconcile consequential external actions | Identify uncertain effects of publication, deletion, infrastructure mutation, or other externally visible changes and require proof or appropriate authority before repeating. | After a timeout, the product distinguishes confirmed failure, confirmed success, and unknown effect rather than assuming retry is harmless. |
| ECO-01 | Account for end-to-end resource use | Attribute model, compute, waiting, duplicate work, rework, and human attention costs to outcomes sufficiently to understand tradeoffs. | Users can compare accepted-outcome cost rather than misleading isolated token or invocation totals. |
| ECO-02 | Optimize for accepted outcomes | Make execution tradeoffs that improve expected quality-adjusted completion cost within human-set budget, deadline, and risk limits. | Cheaper local execution is not preferred when it predictably increases total rework; imposed limits remain authoritative. |

## 3. Invariants across all capabilities

These invariants are non-negotiable, including during failures, retries, integration, and operator intervention.

1. **The objective remains human-owned.** Delegated implementation judgment never becomes authority to redefine product intent, acceptance, or risk tolerance.
2. **Authorization precedes effects.** No action may create, expand, or inherit authority merely by being technically executable.
3. **Observed is not inferred.** Unknown, stale, partial, failed, blocked, and verified observations remain distinguishable; missing data is not converted to success, absence, zero, or completion.
4. **Execution is not completion.** An executor finishing, an artifact existing, a check passing, a change being published, and a human accepting it are distinct facts.
5. **Global correctness supersedes local success.** Local proofs do not establish integrated compatibility or objective completion.
6. **Work identity survives executor replacement.** Reconnection and retry cannot silently create duplicate concurrent writers or externally visible effects.
7. **Interruption is a recoverable product condition.** Preserve what is known, reconcile what is unknown, and continue unrelated safe work.
8. **Context reduction must disclose loss.** A summary or bounded context is not a substitute for omitted authority, required evidence, or exact constraints.
9. **Untrusted data never supplies authority.** Sources may inform a decision but cannot approve it.
10. **Finite resources remain real.** Budgets, deadlines, resource readiness, and permissions are constraints, not targets to bypass for autonomy.
11. **Progress is evidence-based.** Visible progress is derived from deliverables and validated state, not the volume of agent activity.
12. **A required human decision is a first-class outcome.** A legitimate block is preferable to an unauthorized workaround.
13. **Optimization must not erase proof.** A faster or cheaper path is acceptable only when the required safety and completion evidence is preserved.
14. **Each responsibility has one authoritative decision boundary.** Different contributors may supply evidence, but incompatible competing truths must not be silently merged.

## 4. Product-level capability relationships

These are logical dependencies between product obligations, **not a prescribed execution pipeline, component diagram, or sequential implementation plan**.

| Stage or gate | Prerequisite capability | Enables | Mandatory failure/uncertainty behavior |
| --- | --- | --- | --- |
| Delegation is valid | OBJ-01–04; TRU-01–02 | Planning and authorized action | Ask for an actual missing decision; do not fabricate intent or permission. |
| Work can be planned | PLN-01–02; CTX-01–02 | Bounded work and dependency mapping | Record unknown source state and avoid speculative modifications. |
| Work can be dispatched | PLN-03; RES-01–04; EXE-01; TRU-01 | Autonomous concurrent execution | Unknown readiness, ownership conflict, or exhausted budget is not ready. |
| Work can advance unattended | EXE-02–05; CTX-03–04 | Dependency release, integration, and recovery | Lost executors or ambiguous effects require reconciliation before retry. |
| Contributions can be integrated | PLN-05; EXE-04; CTX-04 | Candidate whole-objective result | Conflicts or gaps remain visible until resolved or escalated. |
| A result can be verified | OBJ-03; QLT-01–03; TRU-04 | Evidence-backed completion judgment | Unexecuted or incomplete verification stays unverified. |
| A result can be handed off | QLT-04; HUM-01–04 | Human acceptance or authorized next stage | Preserve required approval and stop at the authority boundary. |
| Efficiency can be claimed | ECO-01–02; QLT-04 | Outcome-relative optimization | Do not call a short failed attempt or an unaccepted output an efficiency win. |

The capabilities form a feedback system, not a one-way waterfall: new evidence can invalidate planning, integration can reveal new work, an approval can unblock execution, and verification can require repair. At all times, authority and evidence constrain the next transition.

## 5. End-to-end acceptance scenarios

These scenarios define observable product outcomes. Phase 3 may select how to demonstrate them; this document does not prescribe technologies, fixture designs, or automated tests.

| ID | Situation | Required end-to-end outcome | Principal coverage |
| --- | --- | --- | --- |
| S01 | A sufficiently specified objective contains several independent changes. | Mottainai decomposes the work, advances eligible work concurrently without user polling, integrates outputs, presents verified readiness, and leaves final acceptance to the authorized party. | OBJ, PLN, RES, EXE, QLT, HUM |
| S02 | A consequential requirement has two plausible interpretations. | Only the affected work pauses; the user receives the exact decision and implications; unrelated safe work may continue. | OBJ-02, PLN-03, HUM-01 |
| S03 | A prerequisite completes while other workers are active. | Newly eligible dependent work can start within authorized capacity without a coordinating model repeatedly polling. | PLN-03, RES-03, EXE-02 |
| S04 | Two individually valid changes conflict when combined. | Integration reports the contradiction, determines permitted corrective work, and does not claim global completion before re-verification. | PLN-05, EXE-04, QLT-02–03 |
| S05 | A worker crashes or a service disappears mid-task. | Durable work state survives; actual state is reconciled before resuming; independent work continues and no duplicate writer is invented. | EXE-03, EXE-05, CTX-01, CTX-03 |
| S06 | An external action times out after possible execution. | Mottainai does not assume failure and repeat it; it classifies the effect as established success, established failure, or unresolved and acts only within delegated authority. | EXE-03, TRU-04 |
| S07 | A fetched file or tool response instructs the AI to exceed its authorization. | That instruction is treated as untrusted data and cannot change scope, permissions, or acceptance. | OBJ-04, TRU-01–03 |
| S08 | A requested action exceeds permissions or acceptable risk. | The action does not occur; the user receives an actionable block or approval request, with precise scope and consequences. | EXE-01, HUM-01, TRU-01 |
| S09 | A check is missing, inconclusive, or unavailable. | The result stays explicitly unverified or blocked, even if code exists or other checks pass; the user receives the next safe handoff. | QLT-01–04, HUM-04 |
| S10 | A repair fixes one defect but causes a regression elsewhere. | The regressed acceptance condition becomes unsatisfied; affected verification and repair repeat without endless blind retry. | PLN-04, QLT-02–03 |
| S11 | The original executor is replaced with another model or tool. | Settled constraints, decisions, relevant context, current work state, and proof carry forward without replaying all discovery or relaxing authority. | RES-04, CTX-01–04 |
| S12 | The user revises the objective while work is underway. | Mottainai records authorized scope change, invalidates affected plans/proofs, preserves unaffected valid work, and explains changed completion conditions. | OBJ-04, PLN-04, QLT-04, HUM-03 |
| S13 | A user pauses or revokes authority during execution. | No new unauthorized effects begin; affected work is safely stopped or explicitly marked non-cancellable/uncertain; unaffected allowed work is distinguished. | HUM-03, EXE-05, TRU-01, TRU-04 |
| S14 | A model becomes unavailable or the approved budget is exhausted. | Mottainai uses an authorized substitute only when fit and safe, otherwise reports capacity/budget blockers without inventing progress. | RES-01–04, ECO-02, HUM-02 |
| S15 | Work spans two isolated projects sharing a product objective. | The plan and integrated proof cover both projects, while their distinct authority and confidential information remain isolated. | PLN-05, EXE-04, CTX-04, TRU-01–03 |
| S16 | A complete objective ends at a publication or acceptance boundary that the user did not delegate. | Mottainai delivers the strongest verified handoff within authority and accurately reports the pending external action; it does not silently publish or accept. | OBJ-03, QLT-04, HUM-04, TRU-01 |
| S17 | A status viewer has less privilege than the executing worker. | The viewer can understand progress and outstanding decisions without gaining raw secrets or unrelated execution authority. | HUM-02, TRU-01, TRU-03 |
| S18 | Two execution strategies differ in price, speed, and rework rate. | Under the same objective and proof requirements, the product can justify a choice using expected end-to-end cost and constraints, not token count alone. | RES-02–03, ECO-01–02, QLT-04 |

**Product-completion criterion:** All capability responsibilities, invariants, and these representative scenarios must be demonstrably supported in the intended supported environments. An individual scenario may legitimately finish in a truthful blocked or awaiting-human state; success means respecting the specified condition, not forcing every scenario to reach autonomous completion.

## 6. Canon traceability and coverage

Traceability shows that the Product Canon's promises are represented without assuming particular tools or the current architecture.

| Product Canon obligation | Primary capability coverage |
| --- | --- |
| §4.1 Objective to outcome | OBJ-01–04, PLN-01–02, QLT-04 |
| §4.2 Autonomous execution and continuation | PLN-03–04, EXE-02–05, CTX-03 |
| §4.3 Effective use of capabilities | RES-01–04, ECO-01–02 |
| §4.4 Integration of complex work | PLN-05, EXE-03–04, QLT-02–04 |
| §4.5 Convergence on quality | OBJ-03, QLT-01–04 |
| §4.6 Continuity of state and knowledge | CTX-01–04, EXE-05 |
| §4.7 Safety and authority | OBJ-04, EXE-01, HUM-03, TRU-01–04 |
| §4.8 Appropriate human information | HUM-01–04, CTX-04, QLT-04 |
| §5 Human/Mottainai responsibility boundary | OBJ-01–04, HUM-01–04, TRU-01 |
| §6 End-to-end efficiency | RES-02–04, ECO-01–02, QLT-04 |
| §7 Completion | OBJ-03, EXE-04, QLT-01–04, HUM-04 |
| §8 Non-goals | §7 below; invariants 1, 9, 13, 14 |
| §9 Success measures | Outcome measures in §8 below |
| §10 Highest-level principles | Invariants in §3 and all cross-capability scenarios in §5 |

No existing implementation, Issue, or external component is declared authoritative by this mapping.

## 7. Product boundaries and non-goals

- **Mottainai owns orchestration toward outcomes, not every underlying capability.** Execution, reasoning, tool access, project storage, and verification can be provided by other systems. Phase 3 decides the ownership and integration boundaries.
- **Mottainai is not an independent product owner.** It does not invent product strategy, quietly relax a requirement, approve consequential risk, or confer its own permissions.
- **Mottainai is not synonymous with its interface.** A dashboard, CLI, message stream, ticket system, or agent harness may expose capabilities but is not itself the product obligation.
- **Mottainai is not a task-completion counter.** Finishing many individual assignments without coherent verified delivery does not satisfy the model.
- **Mottainai is not a model, compression system, CI runner, or infrastructure platform.** Those may serve capabilities but are not the product's defining value.
- **Mottainai does not promise infallible AI judgment, unlimited resources, or autonomous completion under every condition.** It promises truthful progress, bounded action, recoverability, and escalation when those limits matter.
- **Mottainai does not require one universal implementation.** Compatible providers, environments, and user interfaces are design choices to evaluate against the same capability obligations.

## 8. Outcome metrics and evidence standards

The Product Canon's six success dimensions are measured at the **objective** level, with comparable scope, risk, constraints, and acceptance standards. Exact targets, sampling, and instrumentation are Phase 3/later decisions, not invented guarantees here.

| Dimension | Product-level metric | Mandatory interpretation |
| --- | --- | --- |
| Delivery | Acceptance-qualified objective completion rate; elapsed time to verified handoff | Count only work whose required conditions are established; separate blocked and not-yet-verified objectives. |
| Autonomy | Human interventions and coordinator-driven polling/reassignment per completed objective | Distinguish genuine user decisions from administrative supervision; reducing supervision may not bypass needed approvals. |
| Quality | Defects found after integrated handoff; rework until acceptance; unsupported completion claims | Local test counts are not a substitute for integrated proof. |
| Continuity | Recoverable interruption rate; work/evidence lost; duplicate or unsafe recovery actions | A legitimate explicit block is better than invented recovery. |
| Efficiency | Total attributable model, compute, wait, human coordination, integration, verification, and rework cost per accepted outcome | Do not call a short failed or unfinished run an improvement. |
| Trust | Accurate completion/blocking claims, authority boundary violations, provenance availability, and inappropriate information disclosures | A security violation or knowingly false completion claim is not offset by throughput. |

Evidence must identify its objective and relevant conditions, be attributable to the observation that produced it, remain fresh enough for the claim, and disclose known incompleteness. Measurement coverage and uncertainty must remain visible. Product quality claims require evidence from representative end-to-end work, not just internal subsystem demonstrations.

## 9. Handoff to Phase 3 — questions, not decisions

Phase 3 is responsible for selecting a target architecture that satisfies this model. It must answer, at minimum:

1. Which responsibility is the authoritative owner of each objective, work, execution, evidence, decision, identity, and permission fact?
2. Which information and events must survive interruption, and which can be reconstructed from authoritative sources?
3. Where are the trust boundaries among users, untrusted input, executors, tools, infrastructure, and external systems?
4. How are readiness, resource assignment, work isolation, concurrency, reconciliation, and integration realized without duplicating authorities?
5. How are context selection, retrieval, evidence lineage, and bounded presentation implemented without concealing required facts?
6. How is end-to-end verification composed across independent work, and how are repair and completion decisions controlled?
7. What are the product's interfaces, supported deployment/environment boundaries, and failure behavior when capabilities are absent?
8. How are completion cost, human intervention, fidelity of reported state, and security outcomes measured?
9. Which existing components are reused, replaced, or removed **after** proving they fit the responsibilities above?
10. What capability-oriented certification proves the architecture implements this product model?

Phase 3 must **not** reinterpret current code, repository Issues, agent names, runtime topology, or earlier ADRs as additions to the Product Canon. Where this model exposes a genuine product-level ambiguity, the ambiguity must be resolved against the Product Canon before making a technical design choice.

## 10. Phase 2 completion standard

This model is ready to act as the product-level capability canon when:

- Every promise in the Product Canon maps to a stated capability or invariant.
- Every capability has a user-visible responsibility and falsifiable fulfillment evidence.
- The integrated objective lifecycle covers preparation, concurrent work, dependencies, failure/recovery, verification, completion, and acceptance.
- Authority, privacy, uncertainty, partial failure, and external side effects are treated as first-class product conditions.
- End-to-end scenarios cover both successful delivery and legitimate non-completion without presupposing an implementation.
- The boundary to Phase 3 remains explicit: **this document chooses product obligations, not components, APIs, protocols, persistence technologies, or implementation work items**.

Adoption requires the normal human review and repository governance of this proposal. It is not a claim that the current implementation already fulfills these obligations.
