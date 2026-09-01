# Make the failing suite green

Task ID: `test-repair-001`

`python -m pytest -q` currently fails. The tests in `tests/test_slugify.py`
encode the intended behavior of `slugify` in `src/textops.py`; the
implementation is wrong. Repair `src/textops.py` so the whole suite passes.

The tests are the specification. Do not change any file under `tests/` —
additional hidden cases run against your implementation at grading time.

## Acceptance criteria

- `python -m pytest -q` passes.
- No file under `tests/` (or `hidden/`) changed.

## Out of scope

- Editing tests or adding configuration to make failures disappear.
- Network egress.
