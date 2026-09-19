"""Hidden boundary tests for shipping cost calculation."""
from src.shipping import FLAT_RATE_CENTS, shipping_cost


def test_boundary_below_threshold():
    if shipping_cost(7499) != FLAT_RATE_CENTS:
        raise AssertionError("Expected flat rate for 7499 cents")


def test_boundary_exact_threshold():
    if shipping_cost(7500) != 0:
        raise AssertionError("Expected free shipping for 7500 cents")


def test_boundary_above_threshold():
    if shipping_cost(7501) != 0:
        raise AssertionError("Expected free shipping for 7501 cents")


def test_old_threshold_pays_flat_rate():
    # An order of 6000 cents was incorrectly treated as free under > 5000 defect
    if shipping_cost(6000) != FLAT_RATE_CENTS:
        raise AssertionError("Expected flat rate for 6000 cents")
    if shipping_cost(5000) != FLAT_RATE_CENTS:
        raise AssertionError("Expected flat rate for 5000 cents")
