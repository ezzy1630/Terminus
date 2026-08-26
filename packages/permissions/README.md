# @terminus/permissions

Declarative tool permission engine for the Terminus control plane
(ADR-0045).

Concept port of the OpenCode permission model (ask | allow | deny per tool
with ordered glob rules, last matching rule wins) adapted to Terminus
fail-closed conventions:

- No rule matched ⇒ `ask` (the safe default). Callers may override the
  default explicitly, but the library never defaults to silent allow.
- Rules are evaluated against a `tool` id plus an opaque `subject` string
  (for `exec` the command line, for workspace tools the target path).
- Agent-scope rule sets are merged with session-scope approvals by
  concatenation: later rule sets win on conflict (session grants refine
  agent policy).
- Interactive approvals are remembered via an injected approval-memory port
  (`once` or `always`) so a decision is made exactly once per scope.
- Denials carry the matching rule so callers can render a deny-with-
  correction flow instead of a bare refusal.

Pure logic only: no process, filesystem, network, or kernel access. The
control plane owns enforcement wiring; this package owns evaluation.
