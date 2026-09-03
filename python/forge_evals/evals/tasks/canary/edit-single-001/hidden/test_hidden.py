"""Hidden boundary tests for edit-single-001 (never projected to the agent)."""

from __future__ import annotations

from src.shipping import shipping_cost


def test_exactly_75_dollars_ships_free():
    assert shipping_cost(7500) == 0  # skipcq: BAN-B101


def test_one_cent_below_threshold_pays_flat_rate():
    assert shipping_cost(7499) == 595  # skipcq: BAN-B101


def test_zero_order_pays_flat_rate():
    assert shipping_cost(0) == 595  # skipcq: BAN-B101
