# @terminus/rollout

Canonical session trajectory format and projection (ADR-0047).

A rollout is the durable, ordered record of everything that happened in a
session: user/assistant messages, provider attempts, tool calls and results,
compaction events, checkpoints, gate verdicts, usage rollups, and raw
semantic events. It is the substrate for resume, fork, export, debugging,
and — because completion-gate verdicts ride along as first-class items —
for turning ordinary sessions into labeled trajectory data.

Design constraints honored here:

- The control plane's persisted semantic-event log is the storage substrate
  (`SemanticEvent` rows); this package defines the portable **projection**
  of those rows into rollout lines plus the JSONL wire form. No duplicate
  write path.
- Ordering is total: `(occurred_at, aggregate_sequence, event_id)`.
- Every line validates against a versioned zod schema; decoders reject
  unknown item types instead of guessing (fail closed).
- Bounded by construction: individual items larger than
  `MAX_ROLLOUT_ITEM_BYTES` are rejected at encode time so no consumer can
  silently rely on truncated history.
