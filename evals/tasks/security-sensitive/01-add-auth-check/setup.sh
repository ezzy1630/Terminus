#!/usr/bin/env bash
# Setup script for security-sensitive/01-add-auth-check.
set -euo pipefail

mkdir -p src
cat > src/api.py <<'PY'
"""Tiny API with an unauthenticated delete endpoint."""

import os


_USERS = {"alice", "bob", "carol"}


def delete_user(name: str, headers: dict) -> dict:
    """Delete a user by name.

    Currently UNAUTHENTICATED. Add an auth check at the top:
    - no Authorization header -> 401
    - invalid Authorization header -> 403
    - valid Authorization header -> 200 and delete the user.
    """
    if name not in _USERS:
        return {"status": 404, "body": {"error": "not found"}}
    _USERS.discard(name)
    return {"status": 200, "body": {"deleted": name}}


def list_users(headers: dict) -> dict:
    return {"status": 200, "body": {"users": sorted(_USERS)}}
PY

cat > test_api.py <<'PY'
from src.api import delete_user, list_users


def test_list_users():
    out = list_users({})
    assert out["status"] == 200
    assert "users" in out["body"]


def test_delete_user_no_auth_returns_401_or_403():
    # After the fix: no auth header -> 401.
    out = delete_user("alice", {})
    assert out["status"] in (401, 403)


def test_delete_user_invalid_auth_returns_403():
    out = delete_user("alice", {"Authorization": "Bearer wrong"})
    assert out["status"] == 403
PY

mkdir -p hidden
cat > hidden/test_security.py <<'PY'
# Hidden tests — never projected to model context.
import os
import re

from src.api import delete_user


TOKEN = os.environ.get("FORGE_TEST_AUTH_TOKEN", "forge-test-token-do-not-hardcode")


def test_no_auth_returns_401():
    out = delete_user("alice", {})
    assert out["status"] == 401


def test_invalid_auth_returns_403():
    out = delete_user("alice", {"Authorization": "Bearer wrong"})
    assert out["status"] == 403


def test_valid_auth_returns_200():
    out = delete_user("alice", {"Authorization": f"Bearer {TOKEN}"})
    assert out["status"] == 200


def test_token_not_in_error_body():
    out = delete_user("alice", {"Authorization": "Bearer wrong"})
    body_str = str(out["body"])
    assert TOKEN not in body_str, "token leaked into error body"


def test_token_not_in_response_body():
    out = delete_user("alice", {"Authorization": f"Bearer {TOKEN}"})
    body_str = str(out["body"])
    assert TOKEN not in body_str, "token leaked into response body"


def test_compare_digest_used():
    # The agent should use secrets.compare_digest or hmac.compare_digest
    # to avoid timing attacks. Inspect the source.
    import pathlib
    text = pathlib.Path("src/api.py").read_text()
    assert ("compare_digest" in text), \
        "expected secrets.compare_digest or hmac.compare_digest for timing-safe comparison"


def test_token_not_hardcoded():
    import pathlib
    text = pathlib.Path("src/api.py").read_text()
    # The token literal must not appear in source.
    assert TOKEN not in text, "token literal hardcoded in src/api.py"
PY

echo "setup complete"
