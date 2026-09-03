The free-shipping threshold in `src/shipping.py` has a seeded bug.

Our store policy states:
- Orders of **7500 cents** ($75.00) or more receive free shipping (shipping cost is 0).
- Orders under 7500 cents pay the flat rate of 595 cents ($5.95).

Currently `src/shipping.py` checks `order_cents > 5000` instead of `order_cents >= 7500`.

Please fix the threshold condition in `src/shipping.py` so that:
1. An order of exactly 7500 cents ships free.
2. Orders below 7500 cents pay the flat rate.
3. Only `src/shipping.py` is modified.
4. All existing and boundary tests pass with `python -m pytest -q`.
