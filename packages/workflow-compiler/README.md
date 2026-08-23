# @terminus/workflow-compiler

Phase 7 Workflow and Skill Compiler — SPEC §8, §12, ADR-0036.

## Features

- **Workflow IR**: Typed, versioned directed graph of deterministic and model-owned nodes.
- **Source Provenance**: Character/line `SourceSpan` tracking from natural-language skills and prose specs.
- **Owner Test (SPEC §12.4)**: Classifies whether code owns mechanism (deterministic derivability) or models own judgment.
- **Static Validation Suite**:
  - Reachability & dead-end analysis;
  - Bounded loops & cycle termination variants;
  - Taint flow & trust boundary crossings;
  - Temporal effect ordering;
  - Mandatory-step witness path generation;
  - Capability attenuation against task ceilings;
  - Verifier independence (author != verifier).
- **Deterministic Controller**: Traversal engine with loop counters, guarded edges, and verify-repair-commit runtime.
- **Standard Workflows**: Reusable organizational workflows for software patches, migrations, reviews, and releases.
