# Thread a currency field through the order pipeline

Task ID: `edit-multi-001`

The order pipeline currently handles amounts without a currency. Add a
`currency` field consistently across the pipeline:

1. `src/order.py` — `Order` takes a required `currency: str` field.
2. `src/receipt.py` — `render_receipt(order)` includes the currency on its
   receipt line, formatted as `<total> <currency>` (e.g. `1999 USD`).
3. `src/api.py` — `serialize_order(order)` emits a `"currency"` key with the
   order's currency.

Every construction site of `Order` must pass the new field; the public tests
show the expected shapes, and hidden tests exercise the three files
together.

## Acceptance criteria

- `python -m pytest -q` passes (hidden cross-file tests are added at grading
  time and are not visible to you).
- All three listed files changed; no unrelated file changed.

## Out of scope

- Any change to files other than `src/order.py`, `src/receipt.py`, and
  `src/api.py` (including tests).
- Network egress.
