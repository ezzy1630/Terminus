# Extract `format_price` from `format_invoice`

The `format_invoice` function in `src/format.py` does two things: it
formats the price (cents → dollars with a `$` sign and two decimals)
and it composes the full invoice string. Extract the price-formatting
logic into a new function `format_price(cents: int) -> str` and have
`format_invoice` call it.

Requirements:
- The new `format_price` function lives in `src/format.py` alongside
  `format_invoice`.
- `format_invoice`'s public behavior is unchanged.
- The price-formatting logic appears in exactly one place after the
  refactor (no duplication).
- All existing tests pass without modification.

This refactor is a multi-step edit but stays within a single file. The
verification plan should include `parse`, `diagnostics`, `narrow_tests`,
and `acceptance`.

After your refactor, run `pytest -q` to confirm nothing regressed.
