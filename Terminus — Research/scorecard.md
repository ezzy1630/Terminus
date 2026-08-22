# Harness Scorecard and Objective Dominance Framework

## 1. Purpose

This scorecard separates two questions:

1. **What does public evidence suggest each current harness is strong at?**
2. **What must Terminus prove before it can claim objective superiority?**

The public comparison is ordinal, not a disguised benchmark.

Legend:

- **Leader:** among the strongest publicly demonstrated systems in this dimension.
- **Strong:** mature and credible, but not clearly dominant.
- **Partial:** useful implementation with important gaps.
- **Minimal:** intentionally narrow or early.
- **Unknown:** closed or insufficient public evidence.
- **Target:** required north-star behavior; not a current claim.

## 2. Public-evidence comparison

### 2.1 Runtime, context and software-engineering interface

| System | Shared runtime / clients | Model-native optimization | Context / repo intelligence | Editing / ACI | Long-horizon continuity |
|---|---:|---:|---:|---:|---:|
| Codex | Leader | Leader | Strong | Strong | Strong |
| Claude Code | Strong | Leader | Strong | Strong | Strong |
| OpenCode | Leader | Strong | Strong | Strong | Strong |
| Pi | Partial | Strong | Minimal | Partial | Partial |
| Oh My Pi | Strong | Strong | Leader | Leader | Strong |
| Aider | Minimal | Strong | Leader | Leader | Partial |
| OpenHands | Strong | Strong | Strong | Strong | Strong |
| Cursor background agents | Leader | Strong | Strong | Strong | Leader |
| Devin | Strong | Strong | Strong | Strong | Leader |
| Kiro | Leader | Strong | Strong | Strong | Strong |
| Current Terminus implementation | Partial | Partial | Strong scaffolding | Partial | Minimal |
| Terminus north star | **Target: Leader** | **Target: Leader** | **Target: Leader** | **Target: Leader** | **Target: Leader** |

### 2.2 Effects, security and reliability

| System | OS isolation | Fine-grained authority | Secret isolation | External-effect transactions | Resume correctness | Independent verification |
|---|---:|---:|---:|---:|---:|---:|
| Codex | Strong | Strong | Strong | Unknown | Strong | Partial |
| Claude Code | Strong | Strong | Strong | Unknown | Strong | Partial |
| OpenCode | Partial | Partial | Partial | Minimal | Strong | Partial |
| Pi / Oh My Pi | Partial | Partial | Partial | Minimal | Partial | Partial |
| Aider | Minimal | Minimal | Minimal | Minimal | Partial | Strong local checks |
| OpenHands | Strong | Partial | Partial | Partial | Strong | Partial |
| Cursor | Strong | Partial/Unknown | Unknown | Strong workflow durability; effect semantics unknown | Leader | Strong |
| Devin | Strong | Partial/Unknown | Unknown | Unknown | Leader | Strong |
| Current Terminus implementation | Linux: Strong intent; macOS/Windows degraded; container overclaimed | Strong design, process-local implementation | Raw-value broker scaffold | Minimal | Minimal | Strong design, unverified integration |
| Terminus north star | **Target: Leader** | **Target: Leader** | **Target: Leader** | **Target: Unique leader** | **Target: Unique leader** | **Target: Leader** |

### 2.3 Orchestration, product and improvement

| System | Typed workflows | Multi-agent scheduling | Computer use | Operator UX | Eval discipline | Harness self-improvement |
|---|---:|---:|---:|---:|---:|---:|
| Codex | Partial | Strong | Strong in app | Leader | Strong internal, limited public | Unknown |
| Claude Code | Strong generated workflows | Strong | Strong | Leader | Strong internal, limited public | Partial/Unknown |
| OpenCode | Partial | Partial | Partial | Strong | Partial | Minimal |
| Oh My Pi | Partial | Strong primitives | Strong | Strong | Strong experimental culture | Strong metaharness experiments |
| OpenHands | Strong event flows | Strong | Strong | Strong | Strong | Partial |
| Cursor | Strong durable workflows | Strong | Leader | Leader | Strong internal | Unknown |
| Devin | Strong | Strong coordinator | Leader | Strong | Strong internal | Unknown |
| Kiro | Strong specs | Strong | Strong | Strong | Unknown | Unknown |
| NVIDIA AVO | Specialized evolutionary workflow | Main agent + stagnation supervisor | Domain-dependent | Research system | Public-set result; no controlled ablation | Leader in autonomous search concept |
| Current Terminus implementation | Strong spec, partial runtime | Strong spec, partial runtime | Scaffolding | Substantial clients claimed; not runtime-verified | Substantial framework; no HEAD CI evidence | Strong spec, not demonstrated |
| Terminus north star | **Target: Leader** | **Target: Leader** | **Target: Leader** | **Target: Leader** | **Target: public benchmark leader** | **Target: unique production-grade leader** |

## 3. Why the north star can dominate without one impossible configuration

A single policy cannot simultaneously minimize latency, cost, approval burden and risk. Terminus should be evaluated as a **shared-runtime envelope**:

| Mode | Optimizes | Hard constraints |
|---|---|---|
| Interactive | first useful action, steering, low latency | no irreversible effects without exact authorization |
| Autonomous | end-to-end success, low intervention | durable checkpoints, budgets, stagnation recovery |
| High Assurance | correctness, evidence, security | independent verification and strict isolation |
| Review | recall and precision of findings | read-only authority by default |
| Research | information gain and provenance | source traceability and experiment isolation |
| Incident | diagnosis and controlled remediation speed | elevated audit and time-bounded authority |
| Local/Offline | privacy, availability and local cost | no hidden cloud dependency |
| Fleet | throughput and organizational coordination | quotas, fairness, policy inheritance and isolation |

The product is better if, for each meaningful workload, one supported profile lies on or beyond the incumbent Pareto frontier—and switching profiles does not change task identity or break continuity.

## 4. Objective superiority criteria

Terminus may use “best harness” only after all conditions below are met.

### 4.1 Controlled task success

For each competitor that can be run under controlled conditions:

- use the same model version, reasoning budget, tools/environment access, task text and wall-clock limit where technically possible;
- run at least five independent seeds for stochastic systems;
- use private rotating tasks and public reproducible tasks;
- report confidence intervals and all exclusions;
- compare native and locked configurations separately.

A release qualifies when:

- pooled verified completion is statistically better than every controlled competitor;
- it is not meaningfully worse on any critical cohort;
- and at least one supported Terminus mode occupies the best measured Pareto point for success, cost, latency and human attention.

### 4.2 Correctness and verification

- zero known false “completed” results in the high-assurance release suite;
- every completion claim resolves to exact evidence;
- no admitted patch has failing required checks;
- no stale artifact or wrong checkout is accepted;
- semantic diff and scope constraints pass;
- visual tasks include exact user-visible verification.

### 4.3 Durability

Across the fault matrix:

- no committed effect is duplicated;
- no authorized-but-unconsumed approval is silently reused;
- no task is marked failed merely because a worker died;
- every ambiguous external effect becomes `UNCERTAIN` and is reconciled before retry;
- resume produces an observationally equivalent result to uninterrupted execution, modulo declared nondeterminism.

### 4.4 Security

- zero critical escapes or credential disclosures in the release adversarial suite;
- untrusted repository, MCP, skill and browser content cannot directly authorize privileged effects;
- raw credentials never enter model context or general tool output;
- all extensions and workflow artifacts are identity-, version- and hash-bound;
- every effect has a principal, task, authority, policy decision and evidence trail.

### 4.5 Human experience

In repeated user studies with expert developers:

- lower median intervention time than each incumbent;
- lower review debt for equal task complexity;
- better calibrated trust;
- faster recovery from mistakes;
- no significant loss of user understanding in autonomous mode;
- CLI and native/IDE users can move between surfaces without continuity loss.

### 4.6 Cost and performance

- report model, compute, environment and human-attention cost;
- time to first useful action must be competitive in interactive mode;
- autonomous throughput must be competitive at equal quality;
- cache hit rate, context waste and unnecessary tool calls have explicit regression budgets;
- expensive orchestration must justify itself through measured expected value.

## 5. Release scorecard

Every release receives a multi-axis system card:

| Axis | Required evidence |
|---|---|
| Capability | cohort results, task artifacts and verifier output |
| Correctness | regression, scope and evidence metrics |
| Durability | crash/restart/partition/effect-reconciliation matrix |
| Security | adversarial suite and sandbox conformance |
| Cost | model + compute + storage + human attention |
| Latency | first action, median completion, tail completion |
| UX | intervention, review debt, understanding and trust |
| Extensibility | protocol and adapter conformance |
| Portability | local, remote and platform support evidence |
| Evolution | candidate provenance, ablations and rollback result |

No single weighted number is allowed to conceal a critical regression.
