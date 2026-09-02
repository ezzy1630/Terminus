# diag-001 — read-only diagnosis canary

The agent must locate a seeded off-by-one bug in `src/ledger.py` and write a
diagnosis to `DIAGNOSIS.md` naming the module, the function, and quoting the
defective expression. No other file may change. The grader is purely
deterministic repository-state checking; there is no LLM judge on the
success path.

Archetype coverage: read-only diagnosis with an empty diff expectation.
