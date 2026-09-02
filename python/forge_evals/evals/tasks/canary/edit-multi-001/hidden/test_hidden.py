"""Hidden cross-file tests for edit-multi-001 (never projected to the agent)."""

from __future__ import annotations

import inspect

import pytest
from src.api import serialize_order
from src.order import Order
from src.receipt import render_receipt


def test_order_requires_currency():
    with pytest.raises(TypeError):
        Order("sku-2", 1, 100)  # type: ignore[call-arg]


def test_receipt_format_exactly():
    order = Order("sku-2", 3, 250, "EUR")
    assert render_receipt(order) == "sku-2 x3 = 750 EUR"  # skipcq: BAN-B101


def test_serialization_emits_currency_last_key():
    payload = serialize_order(Order("sku-2", 3, 250, "EUR"))
    assert payload == {  # skipcq: BAN-B101
        "sku": "sku-2",
        "quantity": 3,
        "total_cents": 750,
        "currency": "EUR",
    }


def test_render_receipt_signature_still_takes_order():
    assert "order" in inspect.signature(render_receipt).parameters  # skipcq: BAN-B101
