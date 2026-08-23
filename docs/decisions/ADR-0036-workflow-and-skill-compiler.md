# ADR-0036: Workflow and skill compiler

- **Status:** ADOPTED
- **Date:** 2026-08-22
- **Decision owner:** runtime architecture owner + orchestration owner
- **Supersedes:** none
- **Related:** `Terminus — Research/roadmap.md` (Phase 7), SPEC §8 (Workflow IR), §12 (Workflow and skill compiler), §35 (Skills/MCP/plugins impl), ADR-0017 (Agent Skills), ADR-0020 (Expected-value scheduling), ADR-0021 (Verification DAG)

## Context

In standard agent architectures (such as Claude Code or OpenAI function calling loops),
orchestration is either a simple fixed loop or relies on dynamically generated Python/JS
scripts. While generated coordination scripts offer flexibility, letting arbitrary model-generated
code own privileged traversal violates our non-bypassability invariants, bypasses static
security boundaries, and creates unreplayable or non-deterministic execution states.

Conversely, rigid hardcoded pipelines fail when tasks require dynamic problem-solving,
specialist delegation, or exploratory steps.

Phase 7 resolves this tension by providing a **Workflow and Skill Compiler**:
1. Natural language skill procedures, Markdown guidelines, or structured workflows compile into typed **Workflow IR**.
2. Compilation retains exact **source-span provenance** for every node, edge, and constraint.
3. The **Owner Test** classifies whether an operation is deterministically derivable (owned by code/verifier) or requires taste/ambiguity resolution (owned by model or human).
4. A static verification suite checks reachability, bounded loops, taint flow across trust boundaries, temporal effect ordering, mandatory-step witness paths, capability attenuation, and verifier independence.
5. The **Deterministic Controller** in the control plane owns traversal, enforcing loop limits, retry policies, and verify-repair-commit cycles.

## Decision

### 1. Typed Workflow IR with Source Provenance

We define Workflow IR nodes as typed records with:
- `id`: unique node identifier;
- `kind`: `deterministic`, `model_judgment`, `human`, `connector`, `effect`, `verifier`, `subworkflow`;
- `owner`: implementation identifier or profile;
- `inputs` and `outputs` typed schemas;
- `requiredCapabilities`: minimal capability identifiers;
- `trustInputs`: minimum trust level for inputs;
- `preconditions` and `postconditions`: deterministic or model-checked predicates;
- `effectClass`: side-effect classification;
- `evidenceRequirements`: required evidence schemas;
- `retryPolicy`: retry count and backoff;
- `timeoutSeconds` and `budget`: resource and execution limits;
- `compensationNodeId`: compensation node for rollback/recovery;
- `sourceSpan`: character/line range in the source document (`SKILL.md` or prose);
- `ambiguityStatus`: explicit marker when prose is ambiguous;
- `taintPolicy`: taint acceptance and sanitization rules.

Edges are guarded with deterministic or model-evaluated condition expressions.

### 2. Owner-Test Classification (SPEC §12.4)

The compiler applies a strict rule:
- **Code owns mechanism:** If a decision or transformation can be deterministically derived from typed inputs (lint, test, build, typecheck, AST query, hash match), code owns it (`kind: "deterministic"` or `"verifier"`).
- **Model owns judgment:** If a decision requires open-world judgment, ambiguity resolution, or code synthesis, a model owns a typed slot (`kind: "model_judgment"`).
- **Human owns authorization/taste:** If an action requires policy override, human approval, or subjective taste, a human owns the slot (`kind: "human"`).
- **Trusted brokers own effects:** Modifying external state is designated `kind: "effect"` or `kind: "connector"`.

### 3. Static Safety Validation Suite

Before any workflow runs, the static compiler verifies:
1. **Type & Schema Compatibility:** Output schemas match successor input schemas.
2. **Reachability & Dead Ends:** All nodes are reachable from the root and connect to terminal states.
3. **Bounded Loops:** All cycles have explicit `maxIterations`, loop termination variants, and recovery paths.
4. **Taint Flow:** Untrusted inputs cannot reach sensitive sinks (effect nodes, shell commands, secret broker) without passing through an explicit sanitizer/verifier.
5. **Temporal Safety:** Mutating effects cannot execute before required approvals and prerequisite checks pass.
6. **Mandatory Step Coverage:** Verifies that required security/quality nodes (secret scans, tests, reviews) cannot be bypassed on any path to success, emitting formal `WitnessPath` objects.
7. **Capability Attenuation:** Node capabilities are strictly within the task authority ceiling.
8. **Verifier Independence:** Verifier nodes must not be owned by the actor that created the artifact under test.

### 4. Deterministic Verify-Repair-Commit Controller

The controller owns graph traversal:
- Models or generated scripts NEVER own authoritative graph traversal.
- Bounded loops track iteration counts and terminate safely.
- Verify-repair-commit runtime: node outputs must satisfy postcondition verifiers before being committed to task state; failures trigger repair loops or compensation nodes.
- State transitions produce atomic outbox messages for replay and observability.

### 5. Reusable Organizational Workflows

We provide pre-compiled, statically validated standard workflows:
- `software_patch_workflow`: Read -> Propose Patch -> Isolated Patch Transaction -> Verify (tests/lint/secret scan) -> Review -> Commit.
- `database_migration_workflow`: Schema inspection -> Compatibility check -> Dry run -> Rollback plan verification -> Human approval -> Commit.
- `security_review_workflow`: Static analysis -> Dependency audit -> Clean-context review -> Claim/evidence verification.
- `release_preparation_workflow`: Codegen check -> Test matrix -> Evidence collection -> System card generation.

## Alternatives Considered

- **Arbitrary Python/JS script orchestration (Claude Code style):** Rejected; gives arbitrary generated code execution privileges and bypasses compile-time safety and taint guarantees.
- **Purely hardcoded sequential pipelines:** Rejected; lacks the flexibility needed for dynamic software engineering and specialist subworkflows.
- **Unchecked LLM graph emission:** Rejected; models can generate invalid loops, bypass security steps, or hallucinate capability escalations without static verification.

## Consequences

- Workflow execution is deterministic, replayable, and safe against prompt injection.
- Ambiguous skill procedures are caught and assigned to explicit judgment slots rather than generating false guarantees.
- Mandatory safety steps (tests, secret scans, reviews) are mathematically proven to cover every path to task completion.

## Security Impact

Directly closes roadmap Phase 7 exit criteria:
- Eliminates arbitrary generated scripts owning privileged traversal.
- Quarantines and rejects malicious skill fixtures.
- Prevents tainted data from reaching sensitive sinks without verification.

## Evaluation Plan

- Unit tests for parser, owner test, static validator (reachability, loops, taint, temporal, mandatory steps, attenuation, verifier independence).
- Malicious skill rejection tests.
- Controller runtime execution and verify-repair-commit integration tests.
- Reusable workflow tests.
- Validated with `just check-all`.

## Rollback

The `@terminus/workflow-compiler` package is modular and can be rolled back without breaking lower-level task or effect primitives.
