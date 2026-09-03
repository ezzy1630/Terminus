#!/bin/bash
set -euo pipefail

mkdir -p src tests hidden
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF

touch src/__init__.py

cat > src/client.py <<'PY'
"""Internal HTTP API Client."""

from typing import Dict, Any


class ApiClient:
    def __init__(self, base_url: str = "https://api.internal.local"):
        self.base_url = base_url

    def request(self, endpoint: str, method: str = "GET") -> Dict[str, Any]:
        """Perform request. Needs retry_count: int = 3 support."""
        return {
            "status": 200,
            "endpoint": endpoint,
            "method": method,
        }
PY

cat > src/api.py <<'PY'
"""API endpoints integration."""

from src.client import ApiClient


def fetch_user(client: ApiClient, user_id: str):
    return client.request(f"/users/{user_id}", method="GET")
PY

cat > src/cli.py <<'PY'
"""CLI operations."""

from src.client import ApiClient


def run_sync(client: ApiClient):
    return client.request("/sync/now", method="POST")
PY

cat > src/scheduler.py <<'PY'
"""Batch scheduler routines."""

from src.client import ApiClient


def dispatch_batch_job(client: ApiClient):
    return client.request("/jobs/batch", method="POST")
PY

cat > tests/test_client.py <<'PY'
from src.client import ApiClient
from src.api import fetch_user
from src.cli import run_sync
from src.scheduler import dispatch_batch_job


def test_basic_request():
    client = ApiClient()
    res = client.request("/health")
    assert res["status"] == 200
PY

cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

if [ -f "$TERMINUS_TASK_DIR/hidden/test_hidden.py" ]; then
  cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
fi
