# Add a null check to `parse_user`

The `parse_user` function in `src/parser.py` currently raises an
`AttributeError` when given `None` or a dict missing the `"name"` key.
Several callers pass user-supplied data and do not guard against `None`.

Add a null check at the top of the function so that:
- If `data is None`, return `None`.
- If `data` is a dict but does not contain the `"name"` key, return `None`.

Do not change the function signature. Do not add new dependencies. The
acceptance criterion is that `parse_user(None)` returns `None` and
`parse_user({})` returns `None`, and that the existing tests in
`test_parser.py` still pass.

After your fix, run `pytest -q` to confirm nothing regressed.
