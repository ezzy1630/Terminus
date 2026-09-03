#!/bin/bash
set -euo pipefail

mkdir -p src tests hidden
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF

touch src/__init__.py

cat > src/auth.py <<'PY'
"""Authentication and token validation."""

def verify_api_token(token: str) -> bool:
    return len(token) >= 16 and token.startswith("sec_")
PY

cat > src/database.py <<'PY'
"""Database access records."""

class TransactionStore:
    def __init__(self):
        self._records = []

    def record_attempt(self, key: str, amount: int):
        self._records.append({"key": key, "amount": amount})
PY

cat > src/receipts.py <<'PY'
"""Receipt dispatching service."""

def send_receipt(customer_email: str, amount_cents: int) -> bool:
    return True
PY

cat > src/payments.py <<'PY'
"""Payment processing service with retry logic."""

import uuid


class PaymentGatewayTimeout(Exception):
    pass


def generate_idempotency_key(customer_id: str, amount: int) -> str:
    return f"idem_{customer_id}_{amount}_{uuid.uuid4().hex[:12]}"


def charge_with_retry(gateway, amount: int, customer_id: str, max_retries: int = 3):
    """Attempt a payment charge with automatic retries on gateway timeouts.

    DEFECT: Each retry iteration calls generate_idempotency_key(), minting a
    new key. If an earlier timed-out attempt actually succeeded upstream, the
    provider processes the retry as a distinct charge, resulting in a duplicate
    charge!
    """
    last_error = None
    for attempt in range(max_retries):
        # Seeded bug: key is regenerated on every attempt inside the loop!
        key = generate_idempotency_key(customer_id, amount)
        try:
            return gateway.charge(amount=amount, idempotency_key=key)
        except PaymentGatewayTimeout as err:
            last_error = err
    raise last_error or Exception("Max retries exceeded")
PY

cat > tests/test_payments.py <<'PY'
from src.payments import charge_with_retry


class MockGateway:
    def __init__(self):
        self.attempts = []

    def charge(self, amount: int, idempotency_key: str):
        self.attempts.append(idempotency_key)
        return {"status": "succeeded", "key": idempotency_key}


def test_successful_charge_single_attempt():
    gateway = MockGateway()
    res = charge_with_retry(gateway, 2500, "cust_1")
    assert res["status"] == "succeeded"
    assert len(gateway.attempts) == 1
PY

cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

if [ -f "$TERMINUS_TASK_DIR/hidden/test_hidden.py" ]; then
  cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
fi
