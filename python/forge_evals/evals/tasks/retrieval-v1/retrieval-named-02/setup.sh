#!/bin/bash
set -euo pipefail

mkdir -p src tests hidden
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF

touch src/__init__.py
cat > src/ledger.py <<'PY'
"""Ledger balance calculations with a seeded refund subtraction bug."""

from typing import Any, List, Dict


def calculate_balance(transactions: List[Dict[str, Any]]) -> int:
    """Calculate the net balance in cents from a sequence of transactions.

    Supported types:
      - "deposit": adds funds to the account
      - "withdrawal": removes funds from the account
      - "fee": deduction from the account
      - "refund": restores funds back into the account

    DEFECT: The implementation below erroneously subtracts refunds instead
    of adding them.
    """
    balance = 0
    for tx in transactions:
        tx_type = tx.get("type")
        amount = tx.get("amount_cents", 0)
        if tx_type == "deposit":
            balance += amount
        elif tx_type in ("withdrawal", "fee"):
            balance -= amount
        elif tx_type == "refund":
            # Seeded bug: should be balance += amount
            balance -= amount
    return balance
PY

cat > tests/test_ledger.py <<'PY'
from src.ledger import calculate_balance


def test_empty_ledger():
    assert calculate_balance([]) == 0


def test_deposit_and_withdrawal():
    txs = [
        {"type": "deposit", "amount_cents": 5000},
        {"type": "withdrawal", "amount_cents": 1200},
    ]
    assert calculate_balance(txs) == 3800
PY

cat > justfile <<'JUST'
test:
    python3 -m pytest -q
JUST

if [ -f "$TERMINUS_TASK_DIR/hidden/test_hidden.py" ]; then
  cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
fi
