# edit-single-001 — single-file edit canary

Free-shipping threshold fix confined to `src/shipping.py`. The public suite
documents two coarse cases; the graded suite adds hidden boundary tests
(exactly $75.00, $74.99, $0). Grader is deterministic: pytest plus a
changed-file scope check.
