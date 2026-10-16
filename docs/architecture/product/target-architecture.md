# Mottainai — Target Product Architecture

**Version:** 0.1 — Proposed  
**Status:** Phase 3 target-architecture adoption candidate  
**Authorities:** [Product Canon](../../contracts/product/product-canon.md) and [Product Capability Model](../../contracts/product/capability-model.md)  
**Scope:** Logical architecture, authoritative ownership, interaction, trust, continuity, verification, and product-level certification

## 1. Architectural intent and decision boundary

**Mottainai is an outcome-oriented development control plane, not a general-purpose host, coding model, source-control authority, or task tracker.**

Its permanent responsibility is to turn a human-authorized development objective into bounded work, allocate available execution capabilities, coordinate and integrate contributions, substantiate completion, and deliver the result for the authorized next stage. Everything else is a replaceable supporting capability.

This is a target-state architecture chosen **from product requirements**, independent of current code, prior Issue decomposition, and named products. It defines logical responsibilities, not a required count of binaries, services, repositories, or processes. One deployment may combine logical components; a distributed deployment may split them without changing ownership.

The Product Canon and Capability Model are higher-level requirements. This proposed architecture is not permission to silently override existing operational contracts or migrate running installations. If adopted, Phase 4 must reconcile any existing architectural authorities and plan lawful changeovers explicitly. Until then, this document does not claim existing implementations comply.

### 1.1 Decisive choices

- **One logical owner of orchestration decisions.** Mottainai is authoritative for objective lineage, decomposition, work graph, scheduling intent, integration judgments, and completion assessments; other systems retain their own physical and provider state.
- **Authority and evidence are separate.** A source can supply observations or recommendations without acquiring the right to approve an action. Human permission is recorded and checked at every consequential boundary.
- **An event-driven, durable control loop.** Work progresses on observed changes to authoritative state; a model does not have to continually poll workers or reconstruct the task graph.
- **Opaque execution, explicit outcomes.** Mottainai may select and coordinate executors but must not pretend to own their process, workspace, or provider-specific lifecycle.
- **Provenance-preserving bounded context.** Large content remains retrievable from its owning source; reductions disclose loss and cannot replace required constraints or proof.
- **Verification is independent of execution.** Executor completion is merely candidate evidence; integrated acceptance criteria determine readiness for the next legitimate stage.
- **At-least-once coordination with effect reconciliation.** Recovery may replay requests; it may not assume exactly-once effects or blindly repeat uncertain external mutations.
- **Protection is a precondition, not an optimization variable.** Resource placement or model selection cannot relax isolation, consent, authorization, or evidence requirements.

## 2. Logical structure

The architecture has a **control plane**, **execution/evidence providers**, and a **human-facing projection**. The control plane may be local or remote; the partition is conceptual, not a mandatory network topology.

```text
 Human owner / authorized operator
       |   objectives, constraints, decisions, acceptance
       v
 +-------------------- Mottainai control plane ---------------------+
 | Intent & Decision Authority -> Work Planner -> Work Graph       |
 |              |                     |                |            |
 |              v                     v                v            |
 |         Policy / Admission ---> Ready Frontier -> Dispatcher    |
 |              |                                      |            |
 |              |                   Context Provisioner|            |
 |              |                            |         v            |
 |              |                          Execution Broker         |
 |              |                            |         |            |
 |              |                      Observation/Reconciler      |
 |              |                            |         |            |
 |              +--------> Integration & Assurance <---+            |
 |                                |                                  |
 |                         Completion & Handoff                     |
 |                                |                                  |
 |   Durable Work Ledger -- evidence references -- Cost Accounting  |
 |          |                            |                           |
 |   Projection & Decision Inbox <-------+                           |
 +----------|----------------------------|--------------------------+
            |                            |
            v                            v
   User/API/CLI/etc.           External capability authorities
                              - models and agent-run systems
                              - workspace / execution facilities
                              - repositories and development tools
                              - verification/evidence providers
                              - publication and external services
```

All cross-component decisions are expressed through scoped identities, observations, and explicit authorization. A direct executor-to-provider interaction is permitted only where its grant and resulting effects remain attributable and reconcilable. A control-plane diagram does not confer physical authority on Mottainai.

### 2.1 Logical component contracts

| Logical responsibility | Owns | Consumes / produces | Does **not** own |
| --- | --- | --- | --- |
| Intent & Decision Authority | Durable approved objective revisions, approvals, decision requests and delegation scope | Human inputs, authenticated principal, authorized decision record | The human's underlying right to decide; target-source truth |
| Work Planner | Proposals for necessary bounded work, dependencies, proof requirements and revisions | Approved objective, observed target facts; proposed work graph | Unilateral scope expansion or approvals |
| Work Graph | Canonical objective-local work identity, relations and work/integration dependencies | Planning decisions; coherent graph revisions | External repository contents, executor health or mutable provider status |
| Policy & Admission | Mottainai admission verdicts for requested work and effect scopes, bound to current authority | Approved grants and external prerequisite observations | Creating privileges not supplied by the user or provider |
| Resource Catalog & Scheduler | Resource-selection and capacity-allocation **intent** | Provider capabilities, quotas, trust and resource availability | Model availability or physical machine capacity |
| Ready Frontier | Derived, versioned eligibility projection with blocker and freshness reasons | Work graph, policy, provider observations, effect reconciliation | Any independent ready/not-ready state authority |
| Dispatcher | One logical bounded dispatch reservation per work generation | Ready Frontier, capacity budget and authorization | Physical process creation, workspace locks, external completion |
| Context Provisioner | The derived task context manifest, selection, provenance and disclosure of loss | Approved instructions, facts and referenced source material | Replacing raw evidence, durable objective or upstream content authority |
| Execution Broker | Correlation between a work attempt and a provider-run reference | Admitted work, context, provider responses | Provider run truth, OS process lifecycle, physical workspace identity |
| Observation & Reconciler | Normalized observation provenance and reconciliation decisions | Provider status/events, artifact existence and external effects | Fabricated terminal states or assumption of complete logs |
| Integration Coordinator | Proposed and assessed integration candidates, cross-work consistency and repair requirements | Candidate results, actual target state and proof | Uncontrolled writes to repositories or provider-owned integration state |
| Assurance & Completion | Required-proof mapping, evidence assessment, completion/handoff judgment | Verification providers, integrated candidate, approved acceptance criteria | Human acceptance unless specifically delegated |
| Durable Work Ledger | Authoritative Mottainai-owned decisions, planned revisions, reservations, correlations and evidentiary index | Policy-approved mutations and observed facts | A second copy of an external provider's truth |
| Cost Accounting | Objective-level attributable cost and resource usage assessments | Provider measurements, activity and human intervention | Invented cost measurements or changing user budget |
| Projection & Decision Inbox | Authorized human-facing summary, progress and necessary decision prompts | Derived ledger, evidence, authoritative provider freshness | Mutation authority from simply viewing a dashboard |

The logical names above describe boundaries. They may be merged into one runtime process or assigned to separate implementations; splitting a component must not create two independently writable authorities for the same decision.

## 3. Authoritative state and identity model

### 3.1 Facts have explicit owners

| Fact / state | Ultimate authority | Mottainai's permitted representation |
| --- | --- | --- |
| Product objective, acceptance and risk authorization | Authenticated human or delegated governing organization | Versioned approved intent and authenticated decision evidence |
| Objective-to-work decomposition, plan version and dependencies | Mottainai Work Planner / Work Graph after policy validation | Durable canonical graph revision |
| Work eligibility | No standalone source; derived from canonical graph + current external observations | Recomputable Ready Frontier with freshness/provenance |
| Dispatch reservation and execution correlation | Mottainai dispatcher/ledger | Durable work-generation reservation and attempt mapping |
| Available model/tool/compute and actual consumed resources | Corresponding resource provider | Time-bounded capability and usage observations |
| Agent or execution-run lifecycle | Its execution provider | Opaque run reference, observed timestamps/states, gaps |
| Process/container/VM lifecycle | Physical runtime provider | Observation and requested operation with outcome |
| Workspace, branch and modification exclusivity | Workspace/source provider with actual enforcement | Authorized claim identity and observed lease/lock proof |
| File/content state and revision | Source repository or artifact owner | Immutable references, observed revision and integrity evidence |
| External publication, mutation or API action outcome | Target provider / source of effect | Attempt intent, idempotency identity if supported, reconciliation result |
| Raw verification observations | Actual verifier or external evidence producer | Evidence references, provenance, completeness and validity |
| Acceptance-condition assessment and integration readiness | Mottainai Assurance | Version-bound judgment based on identified proof |
| Final human acceptance | Authorized human or organization | Authenticated acceptance event or pending decision |
| Expense/budget usage | Metering/charging provider for raw costs, human for limits | Attributed estimates/measurements, unknown cost, enforced policy budgets |

**Rule:** An observation can be authoritative for *having been observed* without being authoritative for the *underlying condition*. For example, Mottainai owns the fact that a provider reported `succeeded` at time T, but does not own the provider's true state or infer that an objective is complete.

### 3.2 Logical identities

A complete design must distinguish:

- **Principal / organization / tenant scope:** who may authorize or inspect each objective, resource, and result.
- **Objective ID + revision:** long-lived objective, immutable accepted revisions and the active approved version.
- **Work ID + graph revision:** durable assignment identity independent of executable instance.
- **Attempt ID:** one launch/retry generation of an assignment; never reused for a different execution.
- **Provider run reference:** opaque external executor identity scoped to provider, account and endpoint; never treated as globally unique by name alone.
- **Resource and workspace claims:** provider-issued or provider-verified identities, lifetimes and exclusivity.
- **Dispatch reservation + fencing epoch:** one authorized concurrent writer intent for one work generation.
- **Effect ID:** intended consequential external operation, its prerequisites, correlation, outcome and uncertainty.
- **Target revision / integration candidate:** exact set of source revisions and contributed changes being assessed together.
- **Context snapshot ID:** selected relevant material, sources, approved instruction revision, truncation/retrieval metadata and digest.
- **Evidence ID + assessment revision:** result provenance, input candidate, producer, completeness, age and independent evaluation.
- **Decision ID:** authenticated approval, rejection, modification or required judgment with its authority and scope.

No identifier from one namespace can stand in for another. In particular: an issue ID is not a work attempt, a display name is not a workspace claim, an agent-run ID is not objective completion, a PR URL is not an accepted integration, and a successful tool response is not proof of an external side effect.

Identity is stable across retries while attempt and effect records change. Work tied to an older objective revision cannot silently authorize effects against a newer one.

### 3.3 Durability and derived data

The durable Mottainai-owned record minimally includes approved objective revisions, active graph revisions, policy decisions, dispatched reservations, attempt/provider correlations, context manifests, effect intents and observations, evidence indexes, assessments, and human decisions.

External source content, provider logs, workspace state, and source-control history remain with their owners. Mottainai retains the minimum immutable identity and retrieval context necessary to reconcile and prove claims; it need not copy private raw data indiscriminately.

The Ready Frontier, dashboard, cost summaries, and task summaries are **projections**. They may be cached but are not independent write authorities. A stale or non-reconstructible projection fails closed for consequential decisions.

A logically serialized decision boundary per objective (or equivalently enforced compare-and-set/fencing) prevents conflicting graph transitions and duplicate dispatch reservations. This is an ownership guarantee, not a mandate for a single-server deployment or a particular database/event-sourcing framework.

## 4. Control loop, dispatch, and authority gates

### 4.1 Objective-to-outcome control loop

```text
1. Capture approved objective revision and delegation
2. Observe target/source conditions with freshness and uncertainty
3. Produce a bounded work graph and expected proof per outcome
4. Derive which work is ready from authoritative dependencies and grants
5. Reserve authorized capacity and exclusivity for a specific generation
6. Provision minimal relevant context and start a provider-owned attempt
7. Observe/reconcile results, effects, artifacts and provider state
8. Integrate candidate changes and assess whole-objective consistency
9. Verify acceptance conditions against the exact integrated candidate
10. If defects: generate bounded repair; if human decision: escalate;
    if verified and permitted: hand off; if accepted: record acceptance
11. On every material event, recalculate affected readiness/assessments
```

This is a repeating loop, not a one-pass pipeline. Only **material authoritative changes** invalidate or create work. Planner-generated instructions and executable outputs are proposals until admitted under the relevant authority.

### 4.2 Readiness rules

Work is ready only when all of the following hold for the same objective/graph revision:

- Its applicable requirements, prerequisites, and permission scope are settled.
- Its dependency and integration prerequisites are satisfied by current, version-matched evidence.
- The target revision and workspace/ownership assumptions are not stale.
- A competent execution capability is available within budget, capacity, and isolation policy.
- No conflicting outstanding reservation or uncertain consequential effect prohibits a new writer.

Every non-ready item has a typed reason and provenance, distinguishing `blocked`, `unavailable`, `unknown`, and deliberately `paused` conditions. These are **architectural categories**, not a prescribed public wire enumeration.

Provider events may awaken readiness calculation. Providers that cannot emit events may be observed via a bounded, freshness-aware adapter; this does not require a supervising model to poll or allow stale observations to become ready.

### 4.3 Dispatch and isolation

A dispatch is a durable **intent** with a work generation, authorization snapshot, capacity reservation, target identity, and fencing token. The actual run is created only through a provider that can enforce or attest the relevant workspace and execution boundaries.

On concurrent dispatch attempts, at most one active reservation wins for a work generation. External execution may still be uncertain: reservation uniqueness does **not** prove that a provider started only one process or performed an effect once. Before any replacement attempt, reconcile actual provider state and any outstanding effects.

Reassignment to another executor or environment requires explicit capability compatibility and authorization. It must not silently rebind a work item to a different repository, privilege domain, or host after runtime loss.

The dispatcher owns selection/intent; physical runtimes and workspace authorities own process lifecycle, isolation and claims. The control plane cannot strengthen a provider's isolation guarantees by merely recording an admission decision.

### 4.4 Event and observation semantics

Observations must include their source identity, target/resource revision where available, collection time, observation time where available, causal reference, freshness/expiry or unknown freshness, completeness, and error/gap status.

State-changing Mottainai decisions are durable before dependent work is dispatched. Asynchronous delivery is treated as **at least once**; consumers deduplicate by stable event/intent identity and reject stale generations. Reordering and duplicate provider notifications cannot reverse a known newer decision without a verified contradiction that triggers reconciliation.

No core state transition may rely only on transient UI state, model conversation memory, or a notification being delivered exactly once.

## 5. Lifecycle and completion boundaries

There are several **orthogonal** lifecycles. Combining them into one generic `done` field would be incorrect.

| Dimension | Meaningful conditions | Owner / decision rule |
| --- | --- | --- |
| Objective | Needs clarification; admitted; progressing; blocked/paused; verifying; ready for handoff; accepted/closed or explicitly abandoned | Mottainai projection from approved objective, work and assessment; acceptance is human-owned |
| Work item | Proposed; admitted; waiting/ready; reserved; executing; candidate produced; assessed; repair needed; terminal or cancelled | Mottainai orchestration; actual run status comes from provider |
| Execution attempt | Requested; provider acknowledged; active/terminal; status unknown; cancel requested but effect unresolved | Execution provider is authoritative; Mottainai correlates and reconciles |
| External effect | Proposed; authorized; issued; acknowledged; confirmed applied/not applied; unresolved | Target-effect provider establishes actual outcome; Mottainai owns intent and assessment |
| Integration candidate | Assembled; conflicted; verifying; invalidated; evidence-backed ready | Mottainai integration assessment against source-owned exact revisions |
| Acceptance criterion | Missing proof; verified pass; verified fail; inconclusive; stale/invalidated | Assurance owns scoped assessment; verifier owns underlying observation |
| Human handoff | Not requested; decision required; awaiting acceptance; accepted/rejected | Authorized human owns the actual decision |

These are conceptual condition sets, not an implementation-mandated enum. An objective may be blocked while independent work continues; a provider attempt may be terminal while a consequential effect remains unresolved; an integration candidate can be verified but not accepted.

**Completion gate:** all required acceptance conditions have adequate, current, version-matched proof; no unresolved conflicting effect, scope violation, or mandatory human decision is concealed; the integrated result is deliverable within delegated authority. If human acceptance is required, output is **ready for acceptance**, not automatically accepted.

## 6. Recovery, uncertainty, and external effects

### 6.1 Durable intent and effect reconciliation

Before an external consequential operation, persist its authorized intent, identity, exact target precondition where supported, expected effect, and any idempotency or conflict keys. Then issue it through the least-privileged allowed path.

On success, confirm against the actual target/provider. On a timeout, crash, missing acknowledgement, or inconsistent response, classify the effect as **unknown** until reconciled. Unknown is neither failed nor safe to retry.

Use provider-native idempotency keys and conditional writes when available; otherwise inspect target state and escalate if the effect cannot be determined. No architecture can promise exactly-once effects for arbitrary external systems that supply neither idempotency nor reliable observation.

A retry creates a new **attempt** linked to the same bounded work and to the original effect intent, without reusing an old run identity. Destructive or publish-like operations require the effect-specific reconciliation gate before a new attempt.

### 6.2 Failure matrix

| Failure | Preserved evidence | Safe behavior |
| --- | --- | --- |
| Control-plane restart or lost leader | Approved objective/graph revision, reservations, attempt/effect references, proof indexes | Reconstruct projections; reconcile providers; fence stale dispatcher generation before new work |
| Executor process exit or lost connection | Provider identity, last observation, unknown interval, partial output references | Inspect actual provider run; do not equate missing status with termination |
| Workspace/claim expiry or identity change | Exact claim/target identity and observed freshness | Stop new writes; require re-admission against current authority |
| Provider loses events or observations arrive out of order | Observation gap, causality, provider watermarks where supported | Mark unknown/stale; reconcile rather than invent an event sequence |
| User revokes permission during work | Grant revision, acknowledged effect state, active reservations | Fence new actions and attempt scoped cancellation; report irreversible/in-flight effects honestly |
| External publication succeeds but acknowledgement is lost | Intent, target preconditions, provider correlation | Inspect remote effect before retry; unresolved effects block automatic duplicate publication |
| An agent produces incorrect or conflicting changes | Candidate identity, failure evidence, original acceptance criteria | Replan and repair within bounds; never substitute local success for integrated correctness |
| Critical source/evidence becomes unavailable | Last verified identity and age, missing source classification | Prevent affected readiness/completion; allow unrelated safe work |
| Cost or resource budget exhausted | Metered/estimated consumption, applicable budget revision | Stop initiating further cost-incurring work; request authorization or use permitted lower-cost alternative |
| Isolation or secret boundary is not enforceable | Required guarantee, provider capability claim, failing admission reason | Reject that execution placement rather than silently downgrade security |
| Cancellation acknowledges but descendants/effects may remain | Attempt reference, cancellation receipt, follow-up observation | Report termination unconfirmed; reconcile actual process/effect owner |

Recovery is successful when it preserves authority, avoids duplicated work and unsafe effects, and restores a truthful actionable state—not necessarily when all work resumes autonomously.

## 7. Context, knowledge, and evidence architecture

### 7.1 Context is a derived, inspectable view

The Context Provisioner constructs an executor-specific context from approved objective/constraint revisions, relevant target-state observations, settled decisions, required facts, tool permissions, and retrievable evidence references.

Each context view has source/revision provenance, a selection policy, a known budget, a disclosed completeness/loss classification, and a stable materialization identity. Required permissions, prohibitions, and acceptance constraints cannot disappear silently because the token budget was exhausted.

Context summaries are **not** new authoritative truths. An executor must be able to retrieve omitted detail from an approved source when necessary; if a required fact cannot fit or be retrieved, admission is blocked or the work is decomposed further.

Context deduplication, caching, shared prefixes, compression, and model-specific optimization are replaceable techniques evaluated for correctness and total outcome cost. The architecture commits to preserving meaning and traceability, not a particular tokenizer, retrieval index, compiler, or cache.

### 7.2 Evidence is attributable and scoped

An evidence record references the producing source, input revision and integrated candidate, observation time/freshness, integrity identity where available, result, limitations, and the exact acceptance claim it can support.

The Assurance component can combine admissible proofs into a completion assessment, but it cannot rewrite a failed or missing provider result as success. An artifact produced by an executor is candidate output; independent verification determines which assertions it establishes.

A source mutation, revised requirements, incompatible candidate, or expired evidence invalidates only the **affected** assessments. Unaffected durable facts and proofs remain reusable.

### 7.3 Knowledge is continuous, not conversational

Decisions, work plans, progress, outcome evidence, and external effect states survive executor replacement and session expiration. Raw transcripts may be transient or access-restricted; they are not the sole archive of settled product knowledge.

The system distinguishes durable accepted decisions from model hypotheses, retrieved content, and operational observations. A new executor is admitted with the smallest complete context needed to continue safely.

## 8. Integration, assurance, and human judgment

### 8.1 Integration is a distinct architectural responsibility

An integration candidate is identified by the exact source/artifact revisions and the work contributions it includes. Mottainai evaluates conflicting assumptions, interface compatibility, version dependencies, scope and acceptance conditions **at the combined candidate**, not by aggregating green individual work statuses.

The underlying repository, artifact, or deployment provider remains the physical authority for applying a change. The Integration Coordinator owns the *decision to propose/accept a candidate for verification*, never a free-standing right to mutate source.

A semantic disagreement, unmet acceptance condition, or unsupported security tradeoff becomes scoped repair work or an actionable human decision. Mechanical resolution is permitted only when authorized and independently verifiable.

### 8.2 Completion is a proof-bearing decision

The Assurance component takes the accepted objective revision, applicable criteria, exact candidate revision, provider-backed evidence and known unresolved effects. It produces an attributable assessment for **each** criterion and a whole-objective conclusion.

A repair invalidates the exact affected proofs and triggers proportionate re-verification. Retrying identical failed work without changed evidence or a meaningful hypothesis is not progress; bounded retry and escalation prevent infinite repair loops.

Completion and publication are separate: publishing, merging, releasing, deploying, and accepting a result are effects or decisions that require their own authority. A verified candidate stops at the strongest lawful handoff boundary.

### 8.3 Human judgment is a typed control-plane event

The Decision Inbox aggregates only judgments outside delegated authority: unresolved consequential product semantics, risk acceptance, privilege expansion, impossible proof, or non-reconcilable effects.

Each request states the blocked objective/work, observed evidence, alternatives and consequences, the default non-action, and the independent work that can still proceed. Decision outcomes amend the relevant approved revision; they do not silently modify unrelated objectives.

A viewer may understand status without inheriting execution privileges. Inspection and mutation rights are independent.

## 9. Trust, security, and resource boundaries

### 9.1 Security principals and grants

The architecture recognizes the human/organization principal, objective/grant scope, control-plane decision boundary, executor identity, workspace/resource principal, evidence viewer, and each external provider's identity. Their identities and permissions cannot be conflated.

Every consequential action requires an explicit grant scoped to target, operation, authority issuer, constraint revision, and validity. Capability discovery does not grant permission. Untrusted repository text, model output, web content, review comments, and tool results cannot mint or widen authority.

Execution placement must make the required filesystem, process, network, credential, and cross-project isolation enforceable by the actual runtime/provider. Unsupported or unverifiable isolation is a blocker, not a soft warning.

### 9.2 Sensitive information and mediated effects

Sensitive sources are disclosed on a minimum-necessary basis under the relevant executor and viewer permissions. A log or compact projection does not gain the right to display raw credentials, unrelated private code, hidden prompts, or target-host details merely because an internal executor can observe them.

Secrets should be mediated for the exact authorized operation where possible; the orchestration ledger stores grants and references rather than reusable plaintext credentials. The exact mechanism is a Phase 4 implementation choice, but uncontrolled ambient secret inheritance is outside the target security boundary.

External effects are attributable, bounded, authorized and reconcilable. Generic tool execution does not exempt an action from those requirements.

### 9.3 Cost and concurrency controls

The scheduler optimizes **expected cost to verified outcome**, considering model effort, provider latency, compute, waiting, conflict probability, integration, verification, retries, and human coordination. Safety and acceptance obligations are hard constraints, never traded away to increase throughput.

Resource information carries provenance and freshness. Budget usage distinguishes measured, estimated, and unknown components. Unavailable measurements cannot be represented as zero or used to assert savings.

Concurrency decisions account for provider capacity, workspace ownership, integration conflicts, and critical-path benefit. A rational scheduler can keep capacity unused when additional work would predictably increase total cost or risk.

## 10. Public surfaces, deployment, and degraded operation

### 10.1 Public product surfaces

The product exposes logical operations regardless of presentation technology:

| Surface | Permitted information / intent | Boundary |
| --- | --- | --- |
| Objective intake and amendment | Scope, acceptance, delegation, authorized revisions | Human authentication and objective authority |
| Work/status inspection | Objective graph, actionable/blocked progress, observed provider freshness | Read-only projection is not mutation authority |
| Decision/approval inbox | Explicit questions and approved answers | Approval changes only its stated scope/revision |
| Work execution control | Start, pause, resume, cancel and inspect within active grants | Must reconcile executor, workspace and effects |
| Evidence and handoff | Criteria assessment, source identities, integrated candidate, delivery limitations | Access-controlled; no false completion |
| Resource/cost inspection | Capacity assumptions, metering provenance, objective-level cost | Estimated and unavailable remain explicit |

Interfaces may be interactive, machine-consumed, or automated. A session UI is a view; a tool endpoint is an adapter; neither is the authoritative store for the work lifecycle.

### 10.2 Deployment-neutral composition

A supported product environment may be a single local installation, a managed remote installation, or a multi-user/multi-executor deployment. The target architecture does **not** require a specific OS, VM, container, orchestration framework, distributed database, AI vendor, or cloud service.

Each supported deployment profile must state which execution capabilities, isolation assurances, external providers, connectivity, durability, and recovery guarantees it actually supplies. A profile may have a narrower **supported capability set**, but it cannot claim full Product Canon compliance while omitting a required supported scenario.

Control-plane and executor placement may differ. A remote boundary must preserve authenticated principal, objective scope, provider identity, confidentiality, and observable effects. A disconnected provider becomes unavailable/unknown; no implicit host-local fallback or relocation is allowed.

When there is no usable model, insufficient isolation, an unreachable verification provider, or absent authorization, the product remains usable for safe inspection and decision-making while affected work is explicitly blocked. Truthful degraded operation is preferable to apparent progress.

## 11. Architectural choices and rejected alternatives

| Selected direction | Rejected alternative | Product reason |
| --- | --- | --- |
| Central **logical** orchestration ownership, external physical authorities | One product-owned copy of every provider lifecycle | Avoid conflicting truths and confused-deputy authority |
| Recomputable Ready Frontier driven by authoritative events/observations | Coordinator repeatedly asks agents whether something can start | Reduce human/model attention and stale state joins |
| Durable work/effect intent and scoped reconciliation | Retry any call that times out | External operations cannot generally guarantee exactly-once execution |
| Separate work, attempt, evidence, integration, and acceptance state | A global `running / success / fail` state machine | Prevent local activity being misreported as delivered software |
| Exact integrated candidate and proof-linked assessment | Declare completion when all leaf tasks report success | Combined software can fail despite successful leaves |
| Provider-neutral capability interfaces | Hard-code one preferred model, runner, repository host, or deployment provider | Keep the product's value independent of implementation choices |
| Loss-aware context manifests with retrieval | Truncate or compress all material into unqualified summaries | Preserve required constraints, facts, and provenance |
| Authorization and isolation as preconditions | Accept looser boundaries when cheaper or faster | Product trust is not exchangeable for throughput |
| Outcome-relative cost accounting | Optimize prompt-token count or concurrent agent count | Minimize total cost to accepted results |
| Typed human decision requests | Either seek approval for every step or auto-approve every blocker | Preserve user authority without recurring coordination overhead |

This document deliberately chooses **logical** architecture. Physical technology, interface schemas, particular data stores, execution/sandbox products, installation profiles, and rollout/migration vehicles are not chosen here.

## 12. Capability-to-architecture coverage

Every Phase 2 capability is mapped to a primary owner and its required proof boundary. Coverage is a target obligation, not a claim about present implementation.

| Capability IDs | Primary architectural owner(s) | Certification responsibility |
| --- | --- | --- |
| OBJ-01, OBJ-02, OBJ-03, OBJ-04 | Intent & Decision Authority; Policy; Planner | Revisions, requirements and approval/scope are coherent and demonstrably authorized |
| PLN-01, PLN-02, PLN-03, PLN-04, PLN-05 | Planner; Work Graph; Ready Frontier; Integration | Source freshness, bounded decomposition, readiness, replanning and cross-work consistency |
| RES-01, RES-02, RES-03, RES-04 | Resource Catalog; Scheduler; Dispatcher | Capability provenance, fit, safe concurrency, and outage adaptation |
| EXE-01, EXE-02, EXE-03, EXE-04, EXE-05 | Admission; Dispatcher; Execution Broker; Reconciler; Integration | Scoped launch, autonomous flow, attempt/effect correlation, integration and safe recovery |
| CTX-01, CTX-02, CTX-03, CTX-04 | Durable Work Ledger; Context Provisioner; Reconciler | Continuity, completeness/loss, safe restart, and traceability |
| QLT-01, QLT-02, QLT-03, QLT-04 | Assurance & Completion; Integration; Planner | Proof adequacy, truthful assessment, bounded repair, exact handoff state |
| HUM-01, HUM-02, HUM-03, HUM-04 | Decision Inbox; Projection; Intent Authority; Handoff | Scoped intervention, useful status, authorized change and acceptance handoff |
| TRU-01, TRU-02, TRU-03, TRU-04 | Policy & Admission; Context; Effect Reconciler | Enforcement, provenance, confidentiality and uncertain-effect classification |
| ECO-01, ECO-02 | Cost Accounting; Scheduler; Assurance | Outcome-relative cost with honest metering and hard budget constraints |

**Coverage check:** 4 OBJ + 5 PLN + 4 RES + 5 EXE + 4 CTX + 4 QLT + 4 HUM + 4 TRU + 2 ECO = **36 capabilities**.

## 13. Scenario certification seams

Each Phase 2 end-to-end scenario must be shown through the architecture's **actual boundaries**. A passing isolated unit demonstration is insufficient for a claim spanning multiple authorities.

| Phase 2 scenario | Required composed architectural proof |
| --- | --- |
| S01 — multiple independent changes | Objective admission -> work graph -> concurrent governed execution -> integration -> verifiable handoff |
| S02 — ambiguous consequential requirement | Scoped clarification gate with independently continuing work |
| S03 — dependency release | Authoritative blocker changes -> recomputed frontier -> non-duplicated bounded dispatch |
| S04 — conflicting contributions | Actual integrated candidate conflict -> rejected completion -> scoped resolution |
| S05 — worker/runtime disappearance | Durable work/attempt correlation -> fresh provider reconciliation -> no duplicate writer |
| S06 — external mutation timeout | Effect intent -> ambiguous outcome -> remote inspection or explicit stop; no blind retry |
| S07 — injected instructions | Untrusted content isolation -> unchanged approved grants and objective |
| S08 — insufficient authority | Admission rejection -> precise human decision; no effects |
| S09 — missing verification | Explicit incomplete proof -> withheld completion and evidence-backed handoff |
| S10 — regression during repair | Candidate/proof invalidation -> bounded repair -> affected re-verification |
| S11 — different replacement executor | Durable decisions/context provenance -> compatible new attempt without lost grants or facts |
| S12 — mid-flight objective revision | Human-approved revision -> selective work/proof invalidation -> bounded replan |
| S13 — pause/revocation | Revoked authorization -> dispatch fencing, cancellation attempt, residual-effect accounting |
| S14 — lost capacity/budget | Resource observation -> safe alternate placement or truthful capacity/budget block |
| S15 — two isolated projects | One objective graph -> scoped identities/workspaces -> cross-project integration without information leak |
| S16 — non-delegated publication/acceptance | Verified candidate -> limited authorized handoff; no unauthorized publish/accept |
| S17 — lower-privilege status viewer | Authenticated read projection -> minimal disclosure; no escalation through inspection |
| S18 — two resource strategies | Comparable accepted-outcome proof and cost provenance -> justifiable decision within hard constraints |

Certification evidence must document supported environment/profile, exact objective/authority revisions, relevant provider conditions, result and gaps. Failure, unavailable, blocked and human-decision outcomes count only when they are the **expected truthful behavior**, not as proxies for completing an unrelated positive path.

## 14. Phase 3 exit and Phase 4 handoff

Phase 3 delivers these **decisions**:

1. Product-owned and provider-owned facts have distinct, explicit authorities.
2. The major logical components and their interactions are defined.
3. Work identity, attempt identity, external effect identity and acceptance identity are not conflated.
4. Ready work can advance without human/model polling while stale and unknown authority fails closed.
5. Recovery uses durable intent, fencing and observation—not assumptions of exactly-once execution.
6. Context and evidence remain attributable, bounded and honest about loss.
7. Integration, verification, handoff and final acceptance are distinct.
8. Trust, isolation, authority and cost constraints are enforced across boundaries.
9. All 36 capabilities and 18 scenarios have identifiable certification seams.

**Phase 4 is a separate decision programme**, not part of this PR. It must:

- Evaluate candidate existing components **against** these boundaries rather than deriving requirements from their current shape.
- Select physical ownership and platform implementations only with evidence that the selected interfaces and failure semantics meet the logical contracts.
- Reconcile existing ADRs and operational authorities with explicit compatibility, migration, replacement or supersession decisions before implementation.
- Translate the target architecture into bounded implementation contracts and dependency-aware work without preemptively editing unrelated Issues.
- Define executable certification and support profiles for the composed architecture.

No existing implementation is certified, deprecated, or rewritten by this document. Adopting the target architecture establishes a desired direction; it does not imply that current deployments have changed.
