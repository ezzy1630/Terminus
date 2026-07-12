# forge-policy

Command and effect policy engine.

`PolicyEngine` evaluates a `NormalizedCommand` (resolved executable, argv,
shell AST, redirections, working directory, network destinations, secret
capabilities, taint sources, effect types) against a YAML-loaded `RuleSet`
and returns a strictest-wins `DecisionReport`. Built-in rules cover the
SPEC.md Section 13.5 examples: `allow-local-tests`, `prompt-git-push`,
`deny-download-pipe-interpreter`, `deny-protected-path-write`, and a
default-deny for external state writes.

The engine is intentionally pure: it makes no network calls, performs no
I/O, and never executes the command it inspects. Loading the rule set from
`policies/command/default.yaml` is a single `PolicyEngine::from_yaml` call.
