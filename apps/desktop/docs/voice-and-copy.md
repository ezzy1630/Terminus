# Terminus voice and copy

Terminus copy is plain, specific, calm, and technically honest.

- Say what the user can observe: “Terminus is still starting up.”
- Say what they can do next: “Try again in a moment.”
- Use sentence case and short labels.
- Keep identifiers selectable and preserve exact raw detail under a Details
  disclosure when it helps debugging.
- Do not expose internal subsystem names in the normal path. Avoid “kernel,”
  “control plane,” “durable journal,” “reconcile,” and protocol nouns unless a
  technical view is explicitly explaining that contract.
- Use product labels in navigation: Board, Needs attention, Agents, Task
  details, Activity, Changes, Replay, Evidence, and Usage. Keep “mission
  ledger,” “effect queue,” and similar domain terms inside technical detail.
- Do not print the same failure in the title bar, sidebar, and content area.
  The sidebar footer carries the quiet global runtime status; a working surface
  adds one compact notice only when the failure changes what that surface can do.
- Never turn unavailable data into success or an empty state. Say that the data
  could not be loaded and offer the real recovery action.

Examples:

- “The kernel is not ready” becomes “Terminus is still starting up.”
- “Failed to reconcile the durable request journal” becomes “Couldn't recover
  the saved request.”
- “Control plane offline: Failed to fetch” becomes “Terminus is offline,” with
  the raw error available under Details.
