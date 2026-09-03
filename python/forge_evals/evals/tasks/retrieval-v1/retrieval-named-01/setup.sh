#!/bin/bash
set -euo pipefail

mkdir -p src tests hidden
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF

touch src/__init__.py
cat > src/shipping.py <<'PY'
"""Shipping cost calculation with a seeded threshold defect."""

FLAT_RATE_CENTS = 595


def shipping_cost(order_cents: int) -> int:
    """Return the shipping charge in cents for an order subtotal.

    Policy: orders of 7500 cents ($75.00) or more ship free; smaller orders
    pay the flat rate. The implementation below uses the wrong threshold.
    """
    if order_cents > 5000:
        return 0
    return FLAT_RATE_CENTS
PY

cat > tests/test_shipping.py <<'PY'
from src.shipping import shipping_cost


def test_small_order_pays_flat_rate():
    assert shipping_cost(4000) == 595


def test_clearly_large_order_ships_free():
    assert shipping_cost(12000) == 0
PY

cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

if [ -f "$TERMINUS_TASK_DIR/hidden/test_hidden.py" ]; then
  cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
fi
