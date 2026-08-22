# Terminus 2 — Normative Agent Operating System Specification

**Document:** `SPEC.md`  
**Version:** 2.0.0-north-star  
**Research cut:** August 21, 2026  
**Status:** Normative target architecture and migration contract  
**Primary objective:** create the most capable, reliable, secure, efficient, inspectable and empirically improvable agent harness, centered on software engineering while supporting general computer agency.

## Normative language

**MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** are normative.

- **EXPERIMENTAL** features MUST remain disabled by default until their promotion gate passes.
- **OPEN** decisions MUST name an experiment and decision criterion.
- When requirements conflict, precedence is:
  1. user intent and applicable law/policy;
  2. security and non-bypassability invariants;
  3. durable effect and authorization semantics;
  4. protocol/state-machine definitions;
  5. explicit product requirements;
  6. examples and explanatory prose.
- A claimed capability MUST NOT be presented as supported unless current conformance evidence exists for the exact build and environment.

# 1. Product scope

Terminus MUST provide one runtime for:

- CLI/TUI;
- native desktop;
- IDE integration;
- web;
- mobile supervision;
- headless SDK/API;
- local, remote and hybrid execution.

It MUST support:

- coding and software engineering as its primary optimized workload;
- browser and desktop computer use;
- cloud, SaaS and infrastructure operations;
- research and document/artifact workflows;
- individual power users, teams and enterprises;
- offline/local operation and managed fleet operation.

# 2. Non-goals

Terminus MUST NOT:

- depend on one model provider for canonical semantics;
- treat a transcript as authoritative task state;
- grant models or extensions ambient host authority;
- expose raw credentials to models;
- claim exact-once external effects where the connector cannot prove them;
- hide critical trade-offs in one benchmark number;
- require a universal root agent;
- make a permanent OpenCode or other upstream fork its architectural boundary;
- promote harness changes using the same tasks visible to the optimizer.

# 3. Required invariants

## 3.1 Task invariant

Every operation MUST belong to a durable `TaskId`. A client conversation MAY be attached to a task but MUST NOT replace it.

## 3.2 Authority invariant

Every effect MUST be traceable to:

- principal;
- organization and department;
- task and attempt;
- policy version;
- capability/authorization instance;
- exact effect intent;
- worker and sandbox identity;
- result/evidence.

## 3.3 Effect invariant

No external or authoritative local mutation may bypass the Effect Ledger.

## 3.4 Secret invariant

Raw secret material MUST NOT enter:

- model input;
- model output;
- generic tool result;
- workflow state;
- ordinary artifact/log storage;
- extension address space.

## 3.5 Admission invariant

Model output, worker output and candidate workspace state MUST be non-authoritative until admitted.

## 3.6 Evidence invariant

A `Satisfied` acceptance claim MUST resolve to admitted evidence or an explicit named waiver.

## 3.7 Durability invariant

A control-plane process, worker or client failure MUST NOT erase durable task, workflow, effect, authorization or approval state.

## 3.8 Truth invariant

Support, enforcement and release claims MUST be generated from signed, non-expired conformance evidence.

# 4. Organizational model

## 4.1 Entities

```text
Organization
  └── Department*
        ├── OperatorAgent*
        ├── WorkerProfile*
        ├── PolicyLayer
        └── ResourceScope
```

## 4.2 Federation

- Terminus MUST NOT require a company-wide root operator.
- Each department MAY own one or more persistent operator agents.
- Operators MUST exchange typed tasks, questions, artifacts and approvals.
- Unknown destinations MUST be resolved by a deterministic Capability Directory.
- Cross-department authority MUST be explicit and attenuated.
- Organization policy MUST inherit into departments; departments MAY narrow but MUST NOT broaden hard organization constraints without named authority.
- Effective inherited policy, local overrides and denied capabilities MUST be visible.

# 5. Canonical identifiers and versions

The following MUST be globally unique and immutable:

- `OrganizationId`
- `DepartmentId`
- `PrincipalId`
- `OperatorId`
- `TaskId`
- `WorkflowId`
- `WorkflowVersion`
- `AttemptId`
- `NodeRunId`
- `ModelInvocationId`
- `WorkerId`
- `SandboxLeaseId`
- `CapabilityId`
- `AuthorizationId`
- `ApprovalId`
- `EffectId`
- `ArtifactId`
- `EvidenceId`
- `ClaimId`
- `DecisionId`
- `QuestionId`
- `ConnectorId`
- `ExtensionId`

Mutable aggregates MUST carry monotonic versions. Commands MUST include an idempotency key and expected version when applicable.

# 6. Task contract

A task MUST include:

```yaml
task_id: string
organization_id: string
department_id: string
created_by: principal
mission: string
scope:
  resources: [Handle]
  allowed_effect_classes: [string]
  excluded_paths_or_systems: [string]
acceptance:
  - claim_id: string
    statement: string
    evidence_requirement: schema
constraints:
  security: []
  privacy: []
  cost: {}
  time: {}
  quality: {}
authority_ceiling: CapabilitySet
mode: interactive|autonomous|high_assurance|review|research|incident|local|fleet
status: TaskStatus
version: integer
```

Material scope expansion MUST create a new task version and MAY require approval.

# 7. Task state machine

```text
DRAFT
  -> READY
  -> RUNNING
  -> WAITING_USER | WAITING_AUTH | WAITING_RESOURCE | PAUSED
  -> VERIFYING
  -> COMPLETED | PARTIAL | BLOCKED | CANCELLED | FAILED
```

Rules:

- `COMPLETED` requires all required acceptance claims admitted.
- `PARTIAL` requires explicit unresolved claims.
- `FAILED` describes an unrecoverable task result, not merely a worker/process failure.
- Worker failure SHOULD transition a node/attempt into recovery, not the task into `FAILED`.
- `BLOCKED` MUST state the blocking dependency and evidence.
- Resume MUST preserve the same `TaskId`.

# 8. Workflow IR

## 8.1 Node schema

```yaml
node_id: string
kind: deterministic|model_judgment|human|connector|effect|verifier|subworkflow
owner: implementation_or_profile
inputs: typed_schema
outputs: typed_schema
capabilities: [CapabilityRequirement]
trust_inputs: [TrustRequirement]
preconditions: [Predicate]
postconditions: [Predicate]
effect_class: optional
evidence_requirements: [EvidenceRequirement]
retry_policy: RetryPolicy
timeout: duration
budget: ResourceBudget
compensation: optional NodeRef
successors: [GuardedEdge]
```

## 8.2 Compiler requirements

The workflow compiler MUST validate:

- all types and references;
- input/output compatibility;
- reachability;
- bounded loops;
- mandatory step coverage;
- capability attenuation;
- trust-boundary crossings;
- taint source-to-sink paths;
- effect ordering;
- separation of duties;
- temporal policy;
- idempotency;
- compensation or declared irreversibility;
- resource budgets;
- verifier independence.

Natural-language-to-IR compilation MUST retain source-span provenance. Ambiguous requirements MUST be marked for human/model judgment rather than falsely compiled as deterministic guarantees.

## 8.3 Execution ownership

The durable controller MUST own traversal. Generated Python, JavaScript, shell or other programs MUST NOT own privileged authoritative traversal unless compiled into approved IR or executed unprivileged inside a sandbox.

# 9. Agent Runtime Protocol

## 9.1 Transport independence

ARP MUST support local IPC, stdio, WebSocket, HTTP/2 or equivalent transports without changing domain semantics.

## 9.2 Required protocol properties

- schema version negotiation;
- generated typed clients;
- streaming events with resumable sequence;
- command idempotency;
- expected-version concurrency;
- explicit cancellation and pause;
- bounded inline data;
- artifact handles for large payloads;
- typed errors with retry classification;
- capability negotiation;
- authentication and workload identity;
- backpressure.

## 9.3 External adapters

- ACP MAY expose editor/client operations.
- MCP MAY expose tools, prompts and resources.
- A2A MAY exchange tasks with independent agents.
- AG-UI/A2UI MAY project frontend events/state.
- ATIF MAY export traces.

Adapters MUST translate external data into canonical trust, authority, effect and evidence semantics. An external protocol MUST NOT weaken an invariant.

# 10. Durable storage

## 10.1 Required stores

- transactional relational/materialized state;
- append-only semantic event log;
- immutable content-addressed artifact/evidence store;
- encrypted secret/identity service;
- trace/telemetry store;
- analytics export.

## 10.2 Atomicity

State transition plus outbox insertion MUST be atomic. Worker/model/connector results MUST enter through an idempotent inbox.

## 10.3 Replication and recovery

The managed control plane MUST tolerate at least one process/node failure without data loss. Local mode MUST use crash-safe storage and fsync policy appropriate to configured durability.

## 10.4 Migrations

Migrations MUST be:

- versioned;
- backward/forward compatibility assessed;
- rehearsed on production-sized snapshots;
- accompanied by backup/restore/rollback evidence.

# 11. Resource handles

A handle MUST contain or resolve to:

```text
object_id
object_type
version
scope
allowed_operations
principal/task binding
authority epoch
provenance
trust label
expiry
integrity hash
```

Handles MUST be attenuable. Passing a handle MUST NOT broaden authority. Stale versions MUST fail or require explicit refresh.

# 12. Trust and taint

## 12.1 Trust classes

At minimum:

- `SYSTEM_TRUSTED`
- `USER_TRUSTED`
- `ORG_SIGNED`
- `PROJECT_SIGNED`
- `VERIFIED_EXTERNAL`
- `UNTRUSTED_REPOSITORY`
- `UNTRUSTED_TOOL`
- `UNTRUSTED_WEB`
- `UNTRUSTED_UI`
- `MODEL_GENERATED`

## 12.2 Privileged planner

The privileged intent planner SHOULD receive typed extracted facts rather than raw untrusted content. Raw content access MUST be explicit and logged.

## 12.3 Instruction authority

Text in repositories, web pages, tool descriptions, skill files, images, emails or UI MUST NOT gain instruction authority solely by being observed.

## 12.4 Taint enforcement

Taint MUST propagate through derived facts and artifacts. Policy MUST be able to block tainted data from sensitive sinks or require independent validation.

# 13. Policy

## 13.1 Layers

Effective policy compiles:

1. platform hard invariants;
2. organization;
3. department;
4. project/repository;
5. task;
6. mode;
7. user-approved override.

A lower layer MUST NOT override a higher hard denial.

## 13.2 Sequence policy

Policy MUST support temporal/sequence rules, not only call-level allow/deny. Example:

```text
secret_scan_passed
AND required_tests_passed
AND reviewer_principal != actor_principal
BEFORE repository.merge
```

## 13.3 Policy result

Each decision MUST include:

- allow/deny/approval-required;
- matched rules;
- effective scope;
- obligations;
- evidence requirements;
- reason;
- policy version/hash.

# 14. Capabilities and authorization

## 14.1 Capability properties

Capabilities MUST be:

- least privilege;
- resource-specific;
- operation-specific;
- task/principal bound;
- short-lived;
- epoch-bound;
- revocable;
- attenuable;
- auditable.

## 14.2 Authorization instances

An authorization MUST reference:

- exact or parameterized effect intent;
- maximum scope;
- effect class;
- principal;
- task version;
- use limit;
- expiry;
- required preconditions;
- human approval record where applicable.

## 14.3 Consumption

Authorization consumption MUST be durable and atomically related to effect preparation. A process-local map is non-conforming.

## 14.4 Administrative authority

Broad administrative capabilities MUST be unavailable to models and ordinary workers. Emergency elevation MUST be time-bounded, named and separately audited.

# 15. Approval

## 15.1 Approval presentation

The user MUST see:

- semantic action;
- target/resource;
- data leaving the system;
- credential/identity used;
- reversibility;
- consequences;
- evidence/preconditions;
- exact scope and duration;
- reason approval is needed.

## 15.2 Binding

The displayed proposal and executed effect MUST share a canonical semantic hash. Material change invalidates approval.

## 15.3 Approval fatigue

Low-risk reversible effects MAY be preauthorized by policy. Irreversible, externally visible or expanded-scope effects require exact authorization according to mode and policy.

# 16. Transactional Effect Ledger

## 16.1 States

Required states:

- `PROPOSED`
- `POLICY_CHECKED`
- `AUTHORIZATION_REQUIRED`
- `AUTHORIZED`
- `PREPARED`
- `DISPATCHED`
- `OBSERVED`
- `VALIDATED`
- `COMMITTED`
- `DENIED`
- `CANCELLED`
- `UNCERTAIN`
- `RECONCILING`
- `COMPENSATING`
- `COMPENSATED`
- `RESIDUE`
- `MANUAL_RECONCILE`

## 16.2 Effect record

```yaml
effect_id: string
task_id: string
attempt_id: string
principal: string
connector_or_worker: string
intent:
  type: string
  canonical_parameters: object
resource_handles: [Handle]
effect_class: string
semantic_idempotency_key: string
authorization_id: string
policy_decision_id: string
state: EffectState
dispatch_attempts: []
observations: []
validation: []
compensation: optional
uncertainty_reason: optional
version: integer
```

## 16.3 Retry

A dispatched effect MUST NOT be retried after timeout/crash until reconciliation establishes safe retry or the connector’s idempotency contract makes duplication impossible.

## 16.4 Candidate branches

Speculative/parallel branches MUST use separate effect epochs. Losing branches MUST NOT commit externally visible effects.

# 17. Secret and identity broker

## 17.1 Prohibited APIs

Production code MUST NOT expose `secret.value()`, generic environment injection or raw token retrieval to models/extensions.

## 17.2 Brokered operations

Authenticated operations MUST be performed by trusted connectors using:

- workload identity;
- short-lived OAuth/access token;
- vault dynamic credential;
- signed request;
- delegated capability.

## 17.3 Destination and operation binding

Credential use MUST be bound to connector, destination, operation, task, effect and expiry. Network destination metadata alone is insufficient.

## 17.4 Logging

Logs MUST exclude raw secret material and sensitive request fields. Secret detection/redaction is defense in depth, not the primary isolation mechanism.

# 18. Network and connector enforcement

## 18.1 Transport layer

A lower-level broker MAY enforce DNS/IP/port/scheme/private-network and byte budgets.

## 18.2 Application layer

Credentialed or sensitive operations MUST use an L7 connector that understands semantic actions, methods, paths and result receipts.

## 18.3 Browser egress

Browser navigation and form submission MUST be effects with target and data-flow policy. Accessibility-tree or page text MUST NOT authorize them.

# 19. Sandbox

## 19.1 Risk tiers

- Tier 0: pure deterministic/read-only service.
- Tier 1: local restricted process.
- Tier 2: hardened container with explicit OCI policy.
- Tier 3: microVM/VM with brokered I/O.
- Tier 4: dedicated/isolated environment for high-risk or untrusted workloads.

Policy selects the minimum tier.

## 19.2 Required controls

Where applicable:

- filesystem allowlist and read-only root;
- isolated writable overlay;
- non-root/user namespace;
- capability drop;
- seccomp/system-call policy;
- no-new-privileges;
- PID/process-tree isolation;
- CPU/memory/pid/disk/time limits;
- network deny or broker-only path;
- device denial;
- no ambient secrets;
- signed/pinned image/rootfs;
- process and sandbox identity;
- teardown and residue scan.

## 19.3 Effective enforcement

The backend MUST report measured effective controls, not intended configuration. `Configured` is not `Enforced`.

## 19.4 Degraded behavior

A secure mode MUST fail closed when required controls are degraded or unsupported. A backend MUST NOT accept a restrictive profile merely because a platform API exists when profile generation/wiring is absent.

## 19.5 Platform support

Linux, macOS and Windows support declarations MUST be independent. Container support MUST identify runtime, kernel and configuration.

# 20. Process and job service

## 20.1 Worker primitive

Local process supervision MAY be process-local, provided authoritative job/task state remains durable in the control plane.

## 20.2 Process requirements

- environment clear by default;
- explicit cwd and executable resolution;
- process-tree ownership;
- bounded output and artifact spill;
- timeout;
- stdin/signal/cancel;
- PTY when requested;
- sandbox identity and policy;
- exact exit/termination reason.

## 20.3 Job state

Durable job state MUST include worker lease, process identity, desired state, observed state and reconciliation history. A restart MUST reload jobs from durable storage.

# 21. Context and State OS

## 21.1 Authoritative state

Authoritative state MUST be structured and recomputed where possible. Model recollection is non-authoritative.

## 21.2 Context IR

Context IR MUST contain typed blocks with:

- content or handle;
- purpose;
- source;
- version/hash;
- trust/taint;
- priority;
- cache class;
- loss policy;
- token estimate;
- expiry.

## 21.3 Manifest

Every model invocation MUST persist:

- candidates considered;
- included/omitted blocks;
- ordering;
- transforms/compaction;
- hashes;
- tool schemas;
- model/profile/version;
- cache prediction and actual result.

## 21.4 Stable prefix

Provider renderers SHOULD maximize stable exact prefixes without placing volatile state, timestamps or random IDs before cacheable content.

## 21.5 Compaction

Compacted claims MUST link to exact evidence. Task contract, authority, effect/approval state and unresolved blockers MUST survive compaction.

# 22. Repository intelligence

Terminus SHOULD maintain:

- lexical and semantic index;
- AST/symbol/reference graph;
- build/dependency graph;
- test impact;
- ownership;
- Git history and change coupling;
- runtime traces;
- generated-source relationships;
- schema/database relationships.

Retrieval MUST be evaluated by downstream task success, not only relevance labels.

# 23. Memory

## 23.1 Classes

- episodic;
- semantic;
- procedural;
- user preference;
- organization/project fact;
- failure lesson.

## 23.2 Admission metadata

Every memory MUST include scope, evidence, confidence, provenance, creation, expiry, sensitivity and contradiction links.

## 23.3 Isolation

User/org memory MUST be separate from global harness optimization. Private memory MUST NOT leak into public candidates or cross-tenant evaluation.

# 24. Agent–computer interface

## 24.1 Bounded output

Every tool MUST bound inline output, expose truncation and spill exact content to an artifact.

## 24.2 Source identity

Read/search results MUST include version/hash and provenance.

## 24.3 Editing

Edits MUST apply against expected versions in isolated candidate state. Model-specific edit dialects MAY be used behind one canonical transaction interface.

## 24.4 Shell

Shell execution MUST be structured where possible. Shell strings MUST be classified and policy checked; the shell MUST NOT be a bypass around effect services.

## 24.5 Progressive disclosure

Specialized tool schemas MUST be loaded only when relevant. Tool activation and descriptor changes MUST be recorded in the context manifest and may invalidate cache.

# 25. Computer use

## 25.1 State

A computer-use action MUST reference a versioned UI observation and target identity.

## 25.2 Target verification

Sensitive actions MUST use semantic target verification and SHOULD require before/after visual or structured evidence.

## 25.3 Ambiguous submission

Timeout after click/submit MUST produce `UNCERTAIN`, not automatic retry.

## 25.4 Takeover

Human takeover MUST transfer input control without losing task/effect history. Resume MUST re-observe state before acting.

# 26. Models and profiles

## 26.1 Canonical core

No provider-specific field may become the only representation of a task/effect/evidence concept.

## 26.2 Deep profiles

Profiles MAY specialize:

- instructions;
- context ordering;
- tools and schema dialect;
- edit format;
- reasoning effort;
- continuation;
- compaction;
- cache;
- structured-output repair;
- known-error mitigation.

## 26.3 Pinning

Every attempt MUST pin profile and model versions. “Latest” is non-reproducible and prohibited in release evals.

## 26.4 Routing

Routing MUST be based on measured cohort performance, constraints and cost/latency. Model choice changes MUST be visible and auditable.

# 27. Multi-agent orchestration

## 27.1 Spawn criterion

Subagents SHOULD be spawned only when expected value exceeds configured threshold.

## 27.2 Delegation contract

Each delegation MUST declare:

- objective;
- input handles;
- scope/authority ceiling;
- output schema;
- evidence requirements;
- budget/deadline;
- write isolation;
- return path.

## 27.3 Writes

Concurrent writers MUST use isolated candidate workspaces. Only admission may merge.

## 27.4 Review

Reviewers MUST not share mutable workspace state with actors and MUST not inherit merge/deploy authority.

## 27.5 Stagnation supervisor

Long tasks MUST have an independent supervisor that can detect:

- repeated actions;
- no new evidence;
- unresolved failure cycles;
- budget burn;
- confidence collapse;
- narrowing search;
- unsafe escalation.

It may pause, replan, spawn a critic, change strategy within policy or request attention.

# 28. Verification

## 28.1 Verification plan

Every task MUST compile acceptance criteria into a verification DAG.

## 28.2 Evidence types

- deterministic test/result;
- static analysis;
- runtime trace;
- visual evidence;
- external receipt;
- independent review;
- user acceptance;
- benchmark measurement.

## 28.3 Environment identity

Evidence MUST include exact source snapshot, dependencies, configuration, sandbox/image and relevant external versions.

## 28.4 Completion

Actor self-report MUST NOT satisfy acceptance. A completion statement is generated from admitted claims and unresolved items.

# 29. Operator experience

## 29.1 Required surfaces

All clients MUST expose task status, acceptance, risk, effects and evidence appropriate to form factor.

## 29.2 Cockpit

Desktop/web SHOULD expose:

- organization map;
- department and agent rooms;
- workflow;
- world state;
- risk/effect queue;
- claim/evidence graph;
- artifacts/diffs;
- execution view;
- fleet/budget;
- replay.

## 29.3 Questions

The attention coordinator MUST avoid questions whose answer does not materially affect interpretation, authority, risk or acceptance.

## 29.4 No hidden reasoning requirement

Terminus MUST NOT depend on exposing private chain-of-thought. It MUST expose actionable plans, decisions, evidence, state and uncertainty.

# 30. Modes

Modes MUST compile into explicit policy, verification, routing, sandbox, autonomy and check-in settings. They MUST NOT be undocumented prompt presets.

At minimum:

- interactive;
- autonomous;
- high assurance;
- review;
- research;
- incident;
- local/offline;
- fleet.

Mode changes MUST be recorded and MUST NOT silently broaden authority.

# 31. Extensions

## 31.1 Packaging

Extensions MUST declare identity, version, hash, publisher, capabilities, data flows, network destinations, schemas and runtime.

## 31.2 Isolation

Extensions MUST execute out of process, in WASM or in a sandboxed worker. In-process ambient-authority plugins are prohibited in production.

## 31.3 Descriptor trust

Tool/skill descriptor changes MUST invalidate prior aggregate-set authorization and trigger conformance/policy reevaluation.

## 31.4 Marketplace

A managed marketplace MAY provide signatures, provenance, reproducible builds, scanning, revocation and trust tiers. Installation MUST remain user/admin controlled.

# 32. Observability

Traces MUST support component, experience and decision attribution:

- which component supplied context/tool/rule;
- what the model saw;
- why the system chose a model/tool/workflow edge;
- exact effects and policy decisions;
- user interventions;
- verifier results;
- cost/latency/cache;
- failures and recovery.

Sensitive traces MUST obey tenant, data-residency and retention policy.

# 33. Causal replay

The system SHOULD support:

- deterministic replay of non-model steps;
- model re-execution under pinned inputs;
- counterfactual profile/component runs;
- effect simulation;
- context inclusion/omission analysis;
- human-intervention comparison.

External effects MUST be mocked or redirected during replay.

# 34. Evaluation

Release evaluation MUST follow `evals.md` and include:

- controlled model × harness comparisons;
- private rotating tasks;
- repeated seeds;
- success/correctness/security/durability/cost/latency/attention;
- public and locked configurations;
- chaos and adversarial suites;
- system card.

# 35. Evolution Lab

## 35.1 Isolation

The optimizer MUST NOT access hidden tests, graders, promotion thresholds or production secrets.

## 35.2 Candidate

Every candidate MUST include evidence, root cause, target component, predicted fixes/regressions, resource effect and security effect.

## 35.3 Validation

Candidates MUST pass static, replay, focused held-out, broad held-out, security and chaos stages before canary.

## 35.4 Promotion

Promotion MUST be signed and reversible. Violated predictions or release regressions MUST trigger rollback.

## 35.5 Causality

Bundled changes SHOULD be decomposed or factorially tested. The system MUST avoid attributing improvement to a prompt when tools/middleware changed simultaneously.

# 36. Release truth and system cards

A release MUST publish:

- exact commit and build provenance;
- supported clients/platforms/backends;
- effective enforcement matrix;
- required workflow runs;
- test/eval result artifacts;
- security findings and accepted risks;
- known limitations;
- performance/cost;
- migration/rollback evidence;
- expiration of evidence.

These fields MUST be generated from artifacts. Hard-coded empty limitations are prohibited.

# 37. CI/CD

## 37.1 Branch coverage

Every protected/default/release branch MUST run required CI. A branch-name mismatch is a release blocker.

## 37.2 Required classes

- format/lint/type;
- unit/property/integration;
- protocol/codegen drift;
- boundary/non-bypassability;
- sandbox conformance;
- security/dependency/supply chain;
- fault injection and resume;
- eval smoke;
- release eval;
- migration/restore/rollback;
- SBOM/signature/provenance.

## 37.3 Fuzzing

Short fuzz-smoke MAY be per-PR. Scheduled fuzzing MAY be non-blocking during development, but promoted corpora and critical findings MUST gate release.

# 38. Minimal control mode

Terminus MUST retain a minimal reference harness:

- one model/profile;
- small shell/read/edit interface;
- linear history;
- no memory;
- no subagents;
- no advanced retrieval;
- same sandbox/effect/evidence invariants.

It serves as:

- performance control;
- complexity challenge;
- recovery path;
- local/offline fallback;
- ablation baseline.

# 39. Performance and cost

The primary objective is verified successful tasks per combined model, compute, elapsed and human-attention cost, subject to hard security/correctness constraints.

The system MUST track:

- tokens by class;
- cache reads/writes/invalidation;
- tool calls and schemas;
- model/compute cost;
- environment cost;
- time to first useful action;
- wall-clock and tail;
- user interventions and review time;
- unnecessary diff/work;
- orchestration overhead.

# 40. Failure semantics

Required failure classifications:

- invalid request;
- policy denied;
- approval denied/expired;
- capability expired/revoked;
- stale handle/version;
- worker unavailable;
- sandbox unsupported/degraded;
- model unavailable/refusal/invalid output;
- verifier failed;
- effect uncertain;
- connector reconciliation required;
- budget exhausted;
- user attention required;
- internal invariant violation.

Errors MUST identify safe retry behavior. “Internal error” without state guidance is non-conforming.

# 41. Security threat model

Must include:

- malicious repository content;
- dependency scripts;
- compromised MCP/tool/skill;
- extension supply chain;
- prompt injection;
- browser indirect injection;
- credential exfiltration;
- sandbox escape;
- symlink/path traversal;
- DNS rebinding/SSRF;
- confused deputy;
- cross-agent authority escalation;
- stale worker/fencing;
- replayed approval/token;
- poisoned memory;
- malicious verifier;
- compromised model provider;
- telemetry leakage;
- cross-tenant isolation.

Each threat MUST map to prevention, detection, containment and recovery tests.

# 42. Migration from current Terminus

## 42.1 Phase-zero freeze

Before feature expansion:

- fix CI branch triggers;
- run and publish baseline;
- classify every stub/degraded component;
- remove hard-coded support claims;
- generate system card;
- forbid “durable/enforced/production adapter” labels without evidence.

## 42.2 Strangler sequence

1. introduce ARP v2 and domain IDs alongside current protocol;
2. implement durable task/event/outbox/inbox substrate;
3. place current process/sandbox primitives behind worker service;
4. implement Effect Ledger and authorization consumption;
5. replace secret handle path with brokered connectors;
6. migrate context compiler to handles/world-state queries;
7. add workflow IR/compiler;
8. migrate orchestration and model profiles;
9. migrate clients to ARP v2;
10. implement evolution lab and release evidence generation;
11. retire OpenCode-specific control-plane internals after parity gates.

## 42.3 Data migration

Existing sessions, artifacts and eval results MUST be importable with explicit confidence/provenance. Legacy events MUST NOT be assigned stronger semantics than they originally had.

# 43. Conformance levels

- **L0 Protocol:** schema and basic client conformance.
- **L1 Local Safe:** local task, sandbox, effect and evidence invariants.
- **L2 Durable:** crash-safe task/workflow/effect/authorization state.
- **L3 Distributed:** multi-worker fencing, partitions and remote fleet.
- **L4 High Assurance:** trust separation, independent verification, strict connectors and security suite.
- **L5 Evolutionary:** sealed optimizer, held-out promotion and rollback.
- **L6 Dominance:** objective comparison gates in `scorecard.md` and `evals.md`.

A release MUST state its level per platform and feature. Conformance is not all-or-nothing.

# 44. Initial acceptance gates

The first Terminus 2 production milestone MUST demonstrate:

1. one task started in CLI, supervised in desktop and approved on mobile/web using one identity;
2. controller crash and worker crash recovery without lost state;
3. exact authorization consumed once across retries;
4. simulated external timeout enters `UNCERTAIN` and reconciles before retry;
5. malicious repository instruction cannot authorize network/secret use;
6. raw secret never appears in model/tool/artifact/log scans;
7. isolated parallel writers cannot overwrite each other;
8. completion claims link to exact test/diff/environment evidence;
9. unsupported sandbox fails closed;
10. system card is generated from CI artifacts;
11. minimal mode remains competitive on its cohort;
12. a harness candidate can be proposed, held-out-tested, canaried and rolled back.

# 45. Open decisions

## OPEN-1: Durable workflow engine

Candidates: purpose-built event/outbox service, Temporal-compatible engine, or another proven durable workflow substrate.

Decision criterion:

- semantic transaction integration;
- local-first embeddability;
- deterministic replay constraints;
- operational burden;
- throughput/latency;
- licensing;
- failure-injection results.

## OPEN-2: Primary managed sandbox

Candidates: Firecracker/cloud-hypervisor microVMs, gVisor/Kata hardened containers, managed third-party sandboxes.

Decision criterion:

- isolation;
- startup/snapshot performance;
- computer-use support;
- networking/credential broker integration;
- cost;
- portability;
- conformance.

## OPEN-3: Canonical Workflow IR serialization

Candidates: protobuf-first, JSON-schema-first, or typed language/DSL with generated schemas.

Decision criterion:

- static validation;
- diff/review ergonomics;
- forward compatibility;
- multi-language tooling;
- source provenance.

## EXPERIMENTAL-1: Learned router

Disabled until it beats deterministic routing on broad held-out cohorts without security, cost or tail-latency regression.

## EXPERIMENTAL-2: Automatic workflow synthesis

Generated workflows may execute only after compiler validation and within authority ceilings. Production default requires measured improvement.

## EXPERIMENTAL-3: Harness self-modification

The optimizer may propose code/config changes but cannot self-promote. Human or policy-governed signed promotion remains required until a stronger assurance case exists.

# 46. Final product requirement

Terminus is successful when a user can give it a difficult, ambiguous, multi-system objective and trust that:

- it will understand enough of the real environment;
- choose the right models, tools and specialists;
- act with exactly the granted authority;
- survive failures and continue;
- never pretend an uncertain action succeeded or failed;
- verify the exact user-visible outcome;
- explain state, evidence, risk and decisions without transcript archaeology;
- improve over time without silently becoming worse;
- and remain equally usable from a terminal, IDE, desktop, web, mobile or API.

That is the bar for the best harness.
