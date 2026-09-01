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
cat > src/order.py <<'PY'
"""Order model (add the currency field here)."""


class Order:
    """A purchasable order with an amount in minor units."""

    def __init__(self, sku: str, quantity: int, unit_cents: int) -> None:
        self.sku = sku
        self.quantity = quantity
        self.unit_cents = unit_cents

    @property
    def total_cents(self) -> int:
        return self.quantity * self.unit_cents
PY
cat > src/receipt.py <<'PY'
"""Receipt rendering (include the currency here)."""

from .order import Order


def render_receipt(order: Order) -> str:
    """Render the one-line receipt for an order."""
    return f"{order.sku} x{order.quantity} = {order.total_cents}"
PY
cat > src/api.py <<'PY'
"""API serialization (emit the currency here)."""

from .order import Order


def serialize_order(order: Order) -> dict:
    """Return the wire representation of an order."""
    return {"sku": order.sku, "quantity": order.quantity, "total_cents": order.total_cents}
PY
cat > tests/test_pipeline.py <<'PY'
from src.api import serialize_order
from src.order import Order
from src.receipt import render_receipt


def test_order_total():
    order = Order("sku-1", 2, 500, "USD")
    assert order.total_cents == 1000


def test_receipt_includes_currency():
    order = Order("sku-1", 2, 500, "USD")
    assert render_receipt(order) == "sku-1 x2 = 1000 USD"


def test_serialization_includes_currency():
    order = Order("sku-1", 2, 500, "USD")
    assert serialize_order(order)["currency"] == "USD"
PY
cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST
