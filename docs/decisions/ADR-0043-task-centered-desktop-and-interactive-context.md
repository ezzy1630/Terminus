# ADR-0043: Task-centered desktop and interactive conversation context

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** runtime architecture owner + clients owner + desktop UX owner
- **Supersedes:** ADR-0038 section 5 desktop navigation and its allowance for v2-only tasks on the interactive desktop Board
- **Related:** ADR-0038 task identity and projections, SPEC task/thread model, SPEC client architecture

## Context

The desktop currently presents task conversation, Mission Board, and ten
operator views as peer destinations. That exposes control-plane resource
boundaries as product navigation. The result is a crowded sidebar, repeated
task detail screens, and no clear primary workflow.

The runtime already projects a v1 task and its ARP v2 representation under one
durable task ID. A persisted v1 `Task` row supplies the real session and thread
context. ARP v2 also permits tasks without that context. Those records are
valid for non-interactive orchestration, but they cannot open a conversation
and therefore do not satisfy the desktop Board contract.

Task and Thread remain separate aggregates. Requiring a real thread for an
interactive task does not merge their lifecycles or make conversational history
the task's source of truth.

## Decision

### 1. Interactive task context

Every task admitted to an interactive client workspace MUST have a real
conversation context:

```text
task_id + session_id + thread_id
```

The control plane resolves this context from the authoritative persisted v1
`Task` row whose ID equals the canonical ARP v2 task ID. It MUST NOT create a
best-effort mapping row, match tasks by title, or infer session/thread identity
in a client.

Creating an interactive ARP v2 task requires an existing session and thread in
that session. The control plane creates the v1 task projection and canonical v2
snapshot under one ID in the same admitted operation. A missing or cross-session
thread fails validation.

Non-interactive ARP v2 records MAY remain without conversation context. They
appear under Operations as unassigned records, not on the interactive Board.
Assigning one to a real project validates the session/thread, creates the v1
projection under the same ID transactionally, and emits the canonical context
attachment event. Attachment is idempotent, expected-version guarded, and
restart-safe. The system never fabricates earlier turns or placeholder threads.

### 2. Desktop information architecture

The desktop is a task-first coding-agent client. Its permanent sidebar contains:

- New task;
- Search;
- Board;
- Needs attention when actionable work exists;
- pinned and recent tasks grouped by project;
- Projects;
- Agents;
- Settings.

Board remains a first-class board/list workspace. Opening a contextual task
routes to its exact conversation. An unassigned operational record opens its
details and real project-assignment action. Board filter, selection, and scroll
state survive navigation back from a task.

Organization Map, Department Rooms, and the capability directory become one
Agents workspace. Task-scoped operator capabilities move into one on-demand
details panel with Overview, Evidence, Usage, Activity, Changes, and Replay.
Attention and structured interventions become one Needs attention workflow.
The command palette retains direct access to every capability.

This grouping supersedes ADR-0038's requirement that ten cockpit views appear
as peer sidebar destinations. It preserves the underlying capability and its
typed control-plane contract.

### 3. Interaction and visual system

The default task workspace is the document-style conversation with a bottom
composer. Task details are hidden until requested and remembered per task.
Approvals and material questions appear where work stopped.

The visual system uses cold neutral surfaces, quiet separators, compact desktop
density, minimal elevation, and color only for focus, selection, status, diffs,
warnings, and consequential actions. Both light and dark appearances remain
supported. Automatic animation is limited to state transitions and feedback.

## Consequences

### Positive

- Board cards have deterministic conversation routing.
- The normal workflow exposes one task model instead of v1/v2 client concepts.
- Advanced capability remains available without flooding permanent navigation.
- V2-only operational records remain honest and assignable.

### Negative

- Interactive task creation now requires session/thread context.
- Public API and client compatibility tests must cover conversation-context
  resolution and assignment.
- Desktop navigation and accessibility tests require broad updates.
- Existing unassigned v2 records need an explicit Operations state until a real
  project is chosen.

## Security and reliability

Clients do not receive authority from conversation context. Session and thread
identity are scoped presentation data. The server validates ownership and
session/thread membership before returning or attaching context. Attachment
uses the existing task ID and task contract; it cannot widen task authority.

Unknown attachment settlement is reconciled before retry. A failed persistence
or event-publication step cannot return a linked task. Restart recovery derives
context from the persisted task row and repairs the v2 projection before the
public listener accepts requests.

## Verification

- V1 create resolves the same-ID V2 conversation context.
- Interactive V2 create without context fails.
- Interactive V2 create with context creates both projections under one ID.
- Non-interactive V2 records remain explicitly unassigned.
- Assignment rejects invalid scope, survives restart, and is idempotent.
- Board activation opens the exact session/thread/task transcript.
- Loading, empty, stale, malformed, offline, and unassigned states remain
  distinguishable.
- Keyboard, focus, dark/light, reduced-motion, and packaged Electron paths are
  exercised on the rendered application.

## Migration and rollback

No mapping table is introduced. Persisted v1 `Task` rows already carry the
durable session/thread relation. Existing contextual tasks resolve immediately.
Existing v2-only records remain unassigned until an operator supplies a real
project. Rolling back the desktop grouping does not delete context. Rolling
back the public attachment contract requires the normal protocol compatibility
window and cannot erase an already-created v1 projection.
