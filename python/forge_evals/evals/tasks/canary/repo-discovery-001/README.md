# repo-discovery-001 — repository discovery canary

Three plausible services, one seeded double-charge defect in
`billing/src/charges.py::charge_with_retry` (three total attempts, no
idempotency key). The prompt names only the symptom; the agent must explore
and report exact structured facts in `DISCOVERY.json`. Grader checks the
ground truth fields deterministically and enforces read-only behavior.
