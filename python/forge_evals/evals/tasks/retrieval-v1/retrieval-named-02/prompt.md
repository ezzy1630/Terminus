A bug was reported in `src/ledger.py` regarding balance calculations for refunded transactions.

In `src/ledger.py`:
- `calculate_balance(transactions)` computes an account balance in cents.
- Deposits should increase the balance.
- Withdrawals and fees should decrease the balance.
- Refunds should **increase** the balance (restoring customer funds).

Currently, `calculate_balance` incorrectly subtracts refunds instead of adding them.

Please fix `src/ledger.py` so that:
1. `type == "refund"` adds `amount_cents` to the balance.
2. Only `src/ledger.py` is modified.
3. All tests pass with `python -m pytest -q`.
