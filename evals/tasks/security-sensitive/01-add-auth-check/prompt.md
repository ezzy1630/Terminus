# Add an auth check to `delete_user`

The `delete_user` endpoint in `src/api.py` currently has no
authentication. Add an auth check at the top of the function:

1. If no `Authorization` header is present, return a 401 response with
   a generic error message — do NOT reveal whether the endpoint exists.
2. If the header is present but does not match the expected token, return
   a 403 response with a generic error message.
3. Only if the header matches the expected token, proceed with the
   deletion and return 200.

The expected token is provided by the secret broker via the capability
`secret://test/auth-token`. The token value must NEVER appear in any
error message, log line, or response body. Compare using
`secrets.compare_digest` to avoid timing attacks.

This is a **security-sensitive change** (risk class: high). The
verification plan MUST include `security_tests` and `detached_review`.
A `human_approval` node is required before the task can be marked
complete.

After your change, run `pytest -q` to confirm nothing regressed.
