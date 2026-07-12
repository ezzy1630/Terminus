# Checkpoint Template

Use this template to compose a checkpoint when the active turn is
compaction-triggered, when the task is interrupted, or when the active
agent delegates to another agent. The checkpoint is the ONLY state the
receiving agent sees beyond the task contract; everything else is
re-derived from artifacts and the world state.

A validator confirms that no unresolved requirement, prohibition,
decision, incomplete mutation, failure lesson, or required evidence
disappears. If the validator fails, the compaction is rejected and the
active turn fails back to a longer context.

---

## goal

- objective: {the task objective, verbatim from the contract}
- acceptance_criteria:
  - {criterion 1}
  - {criterion 2}
- non_goals:
  - {non-goal 1}

## scope

- allowed_paths:
  read: {list}
  write: {list}
- allowed_effects: {list}
- prohibited_effects: {list}

## state

- phase: {PLANNING | IMPLEMENTING | VERIFYING | FINALIZING | COMPLETED | BLOCKED}
- status: {one-line summary}
- workspace: {workspace id}
- branch: {branch name}
- head_sha: {git sha}
- context_epoch: {epoch id}

## decisions

- statement: {what was decided}
  rationale: {why}
  evidence_refs: [artifact://..., artifact://...]
  reversible: {true | false}

## progress

- completed:
  - {completed step 1}
  - {completed step 2}
- active:
  - {active step 1}
- blocked:
  - {blocked step with reason}

## working_set

- relevant_files:
  - {path#symbol}
- modified_files:
  - {path @ sha256:...}
- tests:
  - {test name -> PASS | FAIL | NOT_RUN}
- jobs:
  - {job id -> state}

## failures

- attempted: {what was attempted}
  observed_result: {what happened, verbatim from the report artifact}
  lesson: {what to do differently}
  do_not_repeat: {the specific anti-pattern to avoid}

## unknowns

- question: {open question}
  consequence: {what is blocked}
  next_probe: {the next probe to resolve it}

## next_actions

- action: {the next concrete action}
  verification: {how to verify the action succeeded}

## source_refs

- artifact://sha256/...  — {description}
- artifact://sha256/...  — {description}

---

## Composition rules

- Every required acceptance criterion MUST have at least one evidence
  reference or be listed under `unknowns` with a `next_probe`.
- Every modified file MUST appear in `working_set.modified_files` with
  its current sha256.
- Every failure MUST have a `lesson` and a `do_not_repeat`. Do not omit
  failures to make the report look cleaner.
- Every decision MUST have a `rationale` and at least one `evidence_refs`
  entry, OR be marked `reversible: true` with a clear rollback path.
- `next_actions` MUST be concrete: a specific action and a specific
  verification. "Continue working on the task" is not acceptable.

## What NOT to include

- Do not include raw tool output. Reference the artifact.
- Do not include the full transcript. Reference the episode.
- Do not include secret values. Reference the capability name only.
- Do not include untrusted content as if it were trusted. Tag it.
- Do not paraphrase failure output. Quote the artifact line.
