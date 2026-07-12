# @forge/orchestration

Expected-value scheduler, delegation contracts, worktree ownership, integration
coordinator, reviewer triggers, loop detection. Per SPEC §14, §37.

## Public API

- `Scheduler` with `shouldSpawnWorker(task, signals): SpawnDecision`.
- `DelegationService` with `create`, `assign`, `recordResult`.
- `ReviewerPolicy` with `shouldReview(diff, riskClass)` and `evaluate(diff)`.
- `LoopDetector` with `observe(toolCall)` and `intervene()`.
- `IntegrationCoordinator` with `planIntegration(diff, result)`.

## Invariants

- Spawn only when `spawn_value` exceeds a configurable threshold and hard
  constraints permit it.
- A single agent is the default; parallel writing is exceptional.
- The system MUST prefer a clear bounded failure over unlimited token burn.
- Workers receive the delegation contract and evidence references, not the
  coordinator transcript.
