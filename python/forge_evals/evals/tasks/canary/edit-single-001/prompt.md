# Fix the free-shipping threshold

Task ID: `edit-single-001`

`shipping_cost` in `src/shipping.py` grants free shipping for orders strictly
over $50.00, but the published shipping policy says free shipping applies to
orders of **$75.00 or more** (an order of exactly $75.00 ships free; an order
of $74.99 pays the flat rate).

Fix `src/shipping.py` so the behavior matches the policy.

## Acceptance criteria

- `python -m pytest -q` passes (the suite includes boundary tests that are
  added at grading time and are not visible to you).
- Only `src/shipping.py` changed; every other tracked file stays untouched.

## Out of scope

- Any change to files other than `src/shipping.py`, including tests.
- Network egress.
