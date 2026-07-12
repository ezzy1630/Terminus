# @terminus/adapter-sdk — local rules

## Non-negotiable

- Adapters are untrusted. Terminus independently inspects the final workspace.
- Inner-harness self-report is not sufficient evidence.
- Schema failure gets at most one correction attempt.
- Declared/observed capability discrepancies may disable the adapter.

## What NOT to add

- Direct filesystem or network access (the kernel owns the sandbox).
- Trust in adapter-reported results without independent verification.
