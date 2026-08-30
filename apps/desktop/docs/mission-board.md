# Board

The Board is a desktop projection of canonical V2 task state. It is not a second scheduler or a separate task database. Each card is one durable `TaskV2Snapshot`; the control plane remains authoritative.

## Opening work

- Click, press Return, or press Space on a task title to open an interactive
  task's exact conversation.
- Use Show context in the task actions menu to inspect a task without leaving
  the Board.
- The same menu exposes admitted task actions with roving keyboard focus.

Interactive tasks require a real session and thread. The control plane stores
the V1 and V2 projections under one task ID and exposes their conversation
context in the V2 snapshot. Operational records without a conversation remain
unassigned and open in the shared inspector; the client never invents a
thread.

## Columns

Columns are derived at render time:

- **Backlog:** `DRAFT`
- **Ready:** `READY`
- **In progress:** `RUNNING`, `WAITING_USER`, `WAITING_AUTH`, `WAITING_RESOURCE`, `PAUSED`, `BLOCKED`, `FAILED`, and `VERIFYING`
- **Done:** `COMPLETED`
- **Closed history:** `PARTIAL` and `CANCELLED`

`Needs you` is an attention filter and card treatment, not a workflow column. A task needs attention when it has a pending material question or is in `WAITING_USER`, `WAITING_AUTH`, `BLOCKED`, or `FAILED`.

## Mutations

Dragging and action menus request transitions already admitted by the V2 task state machine. Every request includes the task's observed version and a durable idempotency key. The board refreshes from canonical state after the response and after relevant task or material-question events.

Direct column drops are intentionally narrow:

- Backlog to Ready requests `DRAFT -> READY`.
- Ready to In progress requests `READY -> RUNNING`.

Review and resume actions remain explicit menu commands within In progress.
Dragging never implies a transition between two runtime states projected into
the same column.

Dragging a running task also exposes Pause and Cancel targets. Pause requests `RUNNING -> PAUSED`. Cancel requires confirmation. The board never offers a direct transition into Done: `COMPLETED` remains evidence-gated by the control plane.

## Deliberate boundaries

The first slice does not invent data the current V2 API does not expose:

- Mission names are derived from stable mission IDs because there is no mission-list read endpoint.
- Ready work is ordered by attention and last canonical update because there is no priority mutation contract.
- Cards do not claim an agent, provider, child-agent graph, or attempt progress because those observables are not part of the task snapshot.
- Show context opens the same inspector used by an active conversation.
- Structured interventions remain proposal-only until their kernel executor is available. The board uses admitted task transitions instead.

## Verification

Focused behavior is covered by `apps/desktop/tests/mission-board.test.tsx`,
including status projection, evidence-gated Done, attention derivation,
responsive layout, filtered-empty copy, native row controls, shared task
context, drag transition concurrency, and live reconciliation.
