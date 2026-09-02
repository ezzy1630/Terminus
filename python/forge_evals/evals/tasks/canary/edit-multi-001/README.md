# edit-multi-001 — multi-file edit canary

One logical change (a required `currency` field) spans `src/order.py`,
`src/receipt.py`, and `src/api.py`. Public tests document the target shapes
and fail at start; hidden cross-file tests pin exact formatting and reject
the old four-arg-free constructor. Grader is deterministic: pytest plus an
exact changed-file set check.
