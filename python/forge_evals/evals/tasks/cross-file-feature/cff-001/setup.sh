#!/bin/bash
set -euo pipefail
mkdir -p src tests
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF
mkdir -p hidden
cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
touch src/__init__.py
cat > src/client.py <<'PY'
"""A tiny client used by three application entry points."""


class Client:
    def request(self, path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        """Return a deterministic response for the local fixture."""
        return {"path": path, "payload": payload or {}}
PY
cat > src/api.py <<'PY'
from .client import Client


class API:
    def __init__(self, client: Client) -> None:
        self.client = client

    def list_users(self) -> dict[str, object]:
        return self.client.request("/users")
PY
cat > src/cli.py <<'PY'
from .client import Client


def show_user(client: Client, user_id: str) -> dict[str, object]:
    return client.request(f"/users/{user_id}")
PY
cat > src/scheduler.py <<'PY'
from .client import Client


def refresh(client: Client) -> dict[str, object]:
    return client.request("/refresh")
PY
cat > tests/test_client.py <<'PY'
from src.api import API
from src.cli import show_user
from src.client import Client
from src.scheduler import refresh


def test_request_default_is_backward_compatible() -> None:
    assert Client().request("/health") == {"path": "/health", "payload": {}}


def test_call_sites_are_callable() -> None:
    client = Client()
    assert API(client).list_users()["path"] == "/users"
    assert show_user(client, "42")["path"] == "/users/42"
    assert refresh(client)["path"] == "/refresh"
PY
