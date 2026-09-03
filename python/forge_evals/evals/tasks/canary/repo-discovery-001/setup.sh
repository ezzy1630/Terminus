#!/bin/bash
set -euo pipefail
# Three plausible services; only one contains the fault. No README maps the
# tree: the agent must explore (incomplete initial context by design).
mkdir -p inventory/src notify/src billing/src
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF
touch inventory/src/__init__.py notify/src/__init__.py billing/src/__init__.py
cat > inventory/src/stock.py <<'PY'
"""Inventory reservation. Unrelated to payments, despite its name."""


def reserve_stock(sku: str, quantity: int) -> bool:
    """Reserve stock; placeholder for the discovery distraction path."""
    return quantity > 0
PY
cat > notify/src/delivery.py <<'PY'
"""Customer notifications with its own (correct) retry loop."""


def send_receipt(email: str, order_id: str) -> bool:
    """Send the receipt notification; retries are idempotent by order id."""
    for _attempt in range(2):
        if _deliver(email, order_id):
            return True
    return False


def _deliver(email: str, order_id: str) -> bool:
    return bool(email) and bool(order_id)
PY
cat > billing/src/charges.py <<'PY'
"""Payment charges with the seeded double-charge defect."""

# Realism note: notify's retry loop is correct (idempotent by order id);
# this module's retry loop is not. Discovery must tell them apart.


class PaymentTimeout(Exception):
    """The payment provider did not answer in time."""


def charge_with_retry(order_id: str, amount_cents: int) -> bool:
    """Charge the order, retrying when the provider times out.

    Seeded defect: the retry re-issues the charge without an idempotency
    key, so a timeout followed by a successful retry charges the customer
    twice.
    """
    for _attempt in range(3):
        try:
            return _provider_charge(order_id, amount_cents)
        except PaymentTimeout:
            continue
    return False


def _provider_charge(order_id: str, amount_cents: int) -> bool:
    """Stub of the outbound provider call; raises to exercise the retry."""
    raise PaymentTimeout(f"provider did not answer for {order_id}")
PY
cat > billing/src/ledger.py <<'PY'
"""Billing ledger (records charges; not the fault site)."""


def record_charge(order_id: str, amount_cents: int) -> None:
    """Append the charge to the ledger."""
    print(f"charge {order_id} {amount_cents}")
PY
cat > justfile <<'JUST'
check-readonly:
    @git status --porcelain
JUST
