"""Hidden boundary tests for shipping cost calculation."""
from src.shipping import FLAT_RATE_CENTS, shipping_cost


def test_boundary_below_threshold():
    assert shipping_cost(7499) == FLAT_RATE_CENTS


def test_boundary_exact_threshold():
    assert shipping_cost(7500) == 0


def test_boundary_above_threshold():
    assert shipping_cost(7501) == 0


def test_old_threshold_pays_flat_rate():
    # An order of 6000 cents was incorrectly treated as free under > 5000 defect
    assert shipping_cost(6000) == FLAT_RATE_CENTS
    assert shipping_cost(5000) == FLAT_RATE_CENTS
