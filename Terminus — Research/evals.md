# Terminus Evaluation Program

## 1. Objective

The evaluation program exists to answer a falsifiable question:

> Under controlled and native conditions, does Terminus produce more verified, policy-compliant, regression-free outcomes with better cost, latency, recovery, security and human experience than every serious alternative?

It must prevent three common failures:

1. confusing a stronger model with a stronger harness;
2. optimizing public tasks until the benchmark is no longer informative;
3. hiding regressions behind one aggregate score.

## 2. Evaluation principles

1. **Model and harness effects are separated.**
2. **Native and locked comparisons are both reported.**
3. **Private rotating tasks are the primary promotion evidence.**
4. **Public tasks exist for reproducibility, not as the only truth.**
5. **Every run is pinned and replayable.**
6. **Success is independently verified.**
7. **Cost includes human attention.**
8. **Security and durability are hard constraints.**
9. **Repeated trials and uncertainty are reported.**
10. **The minimal harness remains a permanent control arm.**
11. **The optimizer cannot access hidden tasks or graders.**
12. **All exclusions and failures are published in the system card.**

## 3. Experimental unit

A run is identified by:

```text
TaskVersion
× EnvironmentSnapshot
× HarnessBuild
× HarnessProfile
× ModelVersion
× ModelProfile
× ReasoningEffort
× ToolSetVersion
× PolicyVersion
× Seed
```

The manifest also pins:

- source commit;
- dependency lockfiles;
- sandbox image/rootfs;
- external service fixtures;
- clock/network conditions where controlled;
- context compiler;
- retrieval index;
- workflow;
- verifier;
- budget;
- timeout;
- client-independent task input.

## 4. Comparison modes

### 4.1 Locked-harness comparison

Use the same model, reasoning budget, environment, task, wall-clock and broadly equivalent authority across harnesses.

Purpose: estimate harness contribution.

Limitations: some native capabilities cannot be perfectly normalized. Report every mismatch.

### 4.2 Native comparison

Use each product’s recommended model and configuration within a common dollar-hour and wall-clock envelope.

Purpose: compare what a real user can buy/use.

### 4.3 Component ablation

At fixed model and task:

- minimal control;
- + context compiler;
- + repository graph;
- + model-specific edit dialect;
- + verification;
- + workflow compiler;
- + router;
- + subagents;
- + memory;
- + computer use;
- + durability middleware.

Use factorial or fractional-factorial designs because component effects are non-additive.

### 4.4 Profile comparison

Evaluate Interactive, Autonomous, High Assurance, Review, Research, Incident, Local and Fleet modes separately. Do not average fundamentally different objectives without showing the frontier.

## 5. Baselines

Required controllable baselines, when legally and technically available:

- Terminus minimal mode;
- Terminus prior stable;
- Codex CLI/app runtime;
- Claude Code;
- OpenCode;
- Pi and Oh My Pi;
- Aider;
- OpenHands;
- mini-SWE-agent / SWE-agent;
- Cline or Roo Code;
- Kiro CLI/IDE;
- GitHub Copilot coding agent;
- Cursor background agent;
- Devin.

Closed/internal systems such as Stripe Minions or NVIDIA AVO may be analyzed from public evidence but are not assigned controlled scores unless executable access exists.

Every adapter must pass a conformance probe before inclusion. A no-op, self-reporting or fixture adapter is disqualified.

## 6. Task cohorts

### 6.1 Repository comprehension

- locate architecture and behavior across large monorepos;
- trace call/data/config paths;
- identify ownership and generated-source boundaries;
- answer questions with exact source evidence;
- distinguish runtime truth from documentation claims.

Metrics: answer correctness, evidence precision/recall, retrieval cost, stale-context rate.

### 6.2 Focused bug repair

- one or few files;
- hidden regression tests;
- misleading symptoms;
- environment and dependency failure variants.

Metrics: verified solve, first-patch solve, diff size, regressions, time/cost.

### 6.3 Cross-cutting refactor

- multi-package API migration;
- type/schema/codegen changes;
- temporary invalid-state requirement;
- test and documentation updates.

Metrics: complete dependency closure, semantic diff, unnecessary churn, merge conflicts.

### 6.4 Feature implementation

- ambiguous product requirements;
- existing design language and architecture constraints;
- frontend/backend/data changes;
- user-visible acceptance.

Metrics: acceptance coverage, integration correctness, visual quality, scope discipline.

### 6.5 Build, test and environment repair

- stale process;
- wrong checkout;
- generated artifacts;
- platform differences;
- flaky external dependency;
- permissions and toolchain.

Metrics: root-cause accuracy, exact artifact verification, false success.

### 6.6 Code review and security review

- correctness;
- security;
- concurrency;
- data integrity;
- performance;
- maintainability;
- test gaps.

Metrics: finding precision/recall/severity calibration, duplicate/noise rate, exploit confirmation in safe fixtures.

### 6.7 Browser and UI computer use

- form workflows;
- visual QA;
- responsive behavior;
- authentication handoff;
- ambiguous click/submit;
- prompt injection in page content.

Metrics: task success, target accuracy, duplicate actions, injection resistance, evidence quality.

### 6.8 Cloud and external-system operations

- create/update issue/PR;
- CI diagnosis;
- deploy preview;
- database migration in fixture;
- messaging;
- infrastructure change.

Metrics: semantic effect correctness, authorization, idempotency, rollback/compensation, reconciliation.

### 6.9 Long-horizon software project

- 4–24 hour tasks;
- several milestones;
- context compaction;
- worker/model/provider failures;
- user interventions;
- subagent work and merge.

Metrics: final success, progress quality, recovery, repeated work, human attention, budget adherence.

### 6.10 Organizational/federated workflow

- work crosses departments;
- no root agent;
- capability-directory routing;
- approvals and separation of duties;
- artifact handoffs.

Metrics: correct routing, authority attenuation, coordination cost, bottlenecks, audit completeness.

### 6.11 Research and experiment

- formulate hypotheses;
- collect sources/data;
- run code experiments;
- preserve provenance;
- distinguish fact/inference/unknown.

Metrics: factual accuracy, source quality, reproducibility, experiment validity.

### 6.12 Adversarial and unknown-unknown tasks

- intentionally misleading docs;
- malicious skills/tool descriptors;
- contaminated memory;
- conflicting instructions;
- novel failure modes;
- hidden environment changes.

Metrics: safe behavior, calibration, detection, containment and recovery.

## 7. Verification design

Each task includes an independent verifier package:

```yaml
task:
  prompt: ...
  environment: pinned_snapshot
acceptance_claims:
  - id: C1
    statement: ...
    verifier:
      kind: deterministic|visual|external_receipt|human_blind
      implementation: ...
hard_failures:
  - scope_violation
  - credential_disclosure
  - duplicate_effect
  - stale_artifact
soft_metrics:
  - diff_size
  - latency
  - cost
```

The actor cannot edit verifiers or hidden fixtures. Graders run in a separate trusted environment. LLM judges may supplement but never replace deterministic checks when a deterministic oracle is possible.

## 8. Primary metrics

### 8.1 Outcome

- verified full completion;
- partial completion by claim;
- first-attempt completion;
- regression-free completion;
- user-visible acceptance;
- false completion rate;
- blocked/unknown calibration.

### 8.2 Scope and quality

- out-of-scope files/effects;
- unnecessary diff;
- duplicated/generated-file mistakes;
- architecture/style violations;
- maintainability review;
- finding precision/recall.

### 8.3 Efficiency

- input/output/reasoning/tool-schema tokens;
- cache read/write;
- model cost;
- compute/environment cost;
- storage/egress cost;
- time to first useful action;
- wall-clock and p50/p95/p99;
- tool calls;
- repeated/redundant work;
- human attention minutes.

### 8.4 Reliability

- worker/model/provider failure recovery;
- lost task/node state;
- duplicate or lost effects;
- ambiguous-effect reconciliation;
- resume equivalence;
- stale-worker commits;
- checkpoint/restore time;
- orphan/resource leakage.

### 8.5 Security

- prompt-injection success;
- unauthorized effect;
- secret disclosure;
- sandbox escape;
- cross-tenant/resource access;
- tool/skill poisoning;
- approval replay;
- memory poisoning;
- DLP violation;
- unsafe browser submission.

### 8.6 Human factors

- interventions per task;
- approval burden;
- review debt;
- time to understand current state;
- ability to predict next action;
- trust calibration;
- takeover/recovery success;
- perceived control and usefulness.

## 9. Semantic effect test suite

For every connector/action class test:

1. crash before preparation;
2. crash after authorization consumption;
3. crash after dispatch before receipt;
4. timeout with action executed;
5. timeout with action not executed;
6. duplicate callback/result;
7. stale worker response;
8. connector retry;
9. control-plane failover;
10. policy/revocation during flight;
11. compensation success;
12. compensation partial/residue;
13. human cancellation;
14. speculative branch loss.

Required result: no silent duplicate, no false terminal state, and explicit `UNCERTAIN` when truth is unavailable.

## 10. Resume conformance matrix

Run failures at every durable transition boundary:

| Component | Failure modes |
|---|---|
| client | disconnect, stale cursor, duplicate command |
| control plane | crash, leader change, DB timeout |
| outbox/inbox | duplicate, reorder, delayed delivery |
| model provider | timeout, truncation, invalid output, unavailable |
| worker | crash, lease loss, partition |
| sandbox | OOM, disk full, teardown failure |
| artifact store | delayed write, hash mismatch, unavailable |
| connector | timeout, ambiguous response, partial result |
| verifier | crash, disagreement, stale environment |

Compare uninterrupted and resumed outcomes using observational equivalence.

## 11. Security program

### 11.1 Repository attacks

- malicious `AGENTS.md`, `CLAUDE.md`, README and comments;
- dependency install scripts;
- symlink/path traversal;
- build output injection;
- generated-file confusion;
- hidden data exfiltration instructions.

### 11.2 Tool and extension attacks

- descriptor poisoning;
- rug-pull descriptor update;
- distributed multi-tool attack;
- compromised signed publisher;
- capability overrequest;
- output injection;
- extension escape.

### 11.3 Browser/computer-use attacks

- indirect prompt injection;
- fake login;
- overlay/coordinate shift;
- accessibility-tree spoof;
- clipboard and download attacks;
- confirmation-page ambiguity;
- duplicate submit.

### 11.4 Identity and credential attacks

- token replay;
- stale authorization;
- confused deputy;
- connector destination substitution;
- cross-task capability use;
- log/artifact leakage;
- revocation race.

### 11.5 Red-team release gate

Critical findings block release. High findings require remediation or explicit time-bounded risk acceptance from named owners, with compensating control and public/internal system-card disclosure as appropriate.

## 12. Chaos and resource program

- control-plane process kill;
- DB failover/latency;
- queue duplication/reordering;
- worker pool exhaustion;
- provider rate limit;
- network partition;
- DNS change;
- clock skew;
- disk full;
- artifact corruption;
- memory pressure/OOM;
- cgroup/pid limit;
- browser crash;
- IDE/client version mismatch;
- partial deployment;
- schema migration rollback.

Track time to recovery, data/effect correctness and operator burden.

## 13. Statistical protocol

### 13.1 Trial count

- development smoke: one deterministic seed;
- focused comparison: minimum five independent trials;
- release cohorts: enough trials for predeclared power, generally 10–30 depending on variance and cost;
- human studies: power analysis and repeated-measures design where possible.

### 13.2 Analysis

- paired task comparisons;
- bootstrap confidence intervals;
- mixed-effects models for task/model/harness;
- non-inferiority margins for critical cohorts;
- correction for multiple comparisons;
- survival analysis for time-to-completion;
- Pareto/frontier analysis;
- report effect sizes, not only p-values.

### 13.3 Missing data

Timeouts, infrastructure failures and refusals are outcomes, not silently dropped rows. Exclusions require predeclared rules and publication.

## 14. Benchmark integrity

- public tasks are versioned and contamination-assessed;
- private tasks rotate and remain inaccessible to optimizer/runtime developers where feasible;
- task creation and grader ownership are separated;
- hidden-test file paths and hashes are protected;
- production incidents are transformed into sanitized tasks without leaking answers;
- duplicate/near-duplicate tasks are detected;
- result artifacts are signed;
- leaderboard claims identify exact task set and date.

## 15. Harness Evolution Lab evaluation

### 15.1 Optimizer split

- training/failure traces;
- development tasks;
- focused holdout;
- broad holdout;
- security holdout;
- final locked release holdout.

The optimizer sees only allowed partitions.

### 15.2 Candidate evidence

A candidate is rejected if it:

- lacks a source failure;
- cannot name the changed component;
- alters grader/budget/hidden access;
- improves only its source task;
- regresses a hard constraint;
- has unexplained cost/security impact;
- cannot be rolled back.

### 15.3 Multi-fidelity ladder

1. static/type/policy;
2. unit/simulation;
3. trace replay;
4. source-failure tasks;
5. focused hidden cohort;
6. broad hidden matrix;
7. chaos/security;
8. canary;
9. production posterior.

### 15.4 Attribution

Use component flags and factorial ablations. Maintain a repair memory containing:

- flaw signature;
- source traces;
- attempted repairs;
- measured effects;
- interactions;
- rejected hypotheses;
- rollback history.

## 16. Operator UX studies

Participants should include:

- expert power users;
- ordinary professional developers;
- team leads/reviewers;
- security/operations users;
- enterprise administrators.

Tasks:

- start and steer;
- interrupt;
- approve;
- recover from wrong direction;
- inspect evidence;
- take over browser/terminal;
- review a completed change;
- resume on another surface;
- manage several parallel tasks.

Measure understanding with factual questions about current state and next effects, not only satisfaction surveys.

## 17. Release gates

A stable release MUST pass:

### Gate A — Correctness

- no critical false completions;
- predeclared task-success threshold;
- no critical cohort meaningful regression from stable;
- exact artifact/environment checks.

### Gate B — Durability

- full resume matrix;
- zero silent duplicate committed effects;
- zero lost durable authorization state;
- all ambiguous cases reconciled or surfaced.

### Gate C — Security

- no critical;
- platform sandbox conformance;
- injection/tool/credential suite;
- dependency/supply-chain evidence.

### Gate D — Efficiency

- cost/latency/review budgets;
- no unexplained cache or context regression;
- orchestration benefit demonstrated.

### Gate E — UX

- intervention and review-debt thresholds;
- continuity across supported clients;
- approval comprehension.

### Gate F — Release truth

- signed artifacts;
- exact CI run;
- generated support matrix;
- known limitations;
- risk acceptance;
- system card.

## 18. Dominance gate

Terminus may claim broad leadership only when:

1. locked comparisons show statistically better pooled verified completion than every runnable competitor;
2. no critical cohort is meaningfully worse;
3. its profile envelope contains the best measured Pareto points for success, cost, latency and human attention;
4. security and durability hard gates pass;
5. results reproduce on a held-out rerun;
6. exact limitations and unavailable comparisons are disclosed.

“Best” is a continuously expiring claim. It must be revalidated when models, competitors or task distributions change.
