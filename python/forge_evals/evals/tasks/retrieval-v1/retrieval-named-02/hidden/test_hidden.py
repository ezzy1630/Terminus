"""Hidden edge-case tests for ledger calculations."""
from src.ledger import calculate_balance


def test_multiple_refunds():
    txs = [
        {"type": "deposit", "amount_cents": 10000},
        {"type": "refund", "amount_cents": 2500},
        {"type": "refund", "amount_cents": 1500},
    ]
    # 10000 + 2500 + 1500 = 14000
    assert calculate_balance(txs) == 14000


def test_mixed_transactions():
    txs = [
        {"type": "deposit", "amount_cents": 5000},
        {"type": "withdrawal", "amount_cents": 2000},
        {"type": "fee", "amount_cents": 150},
        {"type": "refund", "amount_cents": 350},
    ]
    # 5000 - 2000 - 150 + 350 = 3200
    assert calculate_balance(txs) == 3200


def test_refund_only():
    txs = [{"type": "refund", "amount_cents": 1250}]
    assert calculate_balance(txs) == 1250
