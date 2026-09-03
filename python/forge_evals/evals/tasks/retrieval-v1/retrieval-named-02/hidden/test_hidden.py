"""Hidden edge-case tests for ledger calculations."""
from src.ledger import calculate_balance


def test_multiple_refunds():
    txs = [
        {"type": "deposit", "amount_cents": 10000},
        {"type": "refund", "amount_cents": 2500},
        {"type": "refund", "amount_cents": 1500},
    ]
    # 10000 + 2500 + 1500 = 14000
    if calculate_balance(txs) != 14000:
        raise AssertionError(f"Expected 14000 cents, got {calculate_balance(txs)}")


def test_mixed_transactions():
    txs = [
        {"type": "deposit", "amount_cents": 5000},
        {"type": "withdrawal", "amount_cents": 2000},
        {"type": "fee", "amount_cents": 150},
        {"type": "refund", "amount_cents": 350},
    ]
    # 5000 - 2000 - 150 + 350 = 3200
    if calculate_balance(txs) != 3200:
        raise AssertionError(f"Expected 3200 cents, got {calculate_balance(txs)}")


def test_refund_only():
    txs = [{"type": "refund", "amount_cents": 1250}]
    if calculate_balance(txs) != 1250:
        raise AssertionError(f"Expected 1250 cents, got {calculate_balance(txs)}")


def test_empty_transactions():
    if calculate_balance([]) != 0:
        raise AssertionError("Expected balance 0 for empty transaction list")
