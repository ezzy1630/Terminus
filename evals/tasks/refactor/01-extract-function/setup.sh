#!/usr/bin/env bash
# Setup script for refactor/01-extract-function.
set -euo pipefail

mkdir -p src
cat > src/format.py <<'PY'
"""Invoice formatting."""


def format_invoice(line_items):
    """Format a list of (description, cents) tuples into an invoice string.

    The price is formatted as dollars with a $ sign and two decimals.
    """
    lines = []
    total_cents = 0
    for description, cents in line_items:
        # The price-formatting logic is inlined here; extract it.
        if cents < 0:
            raise ValueError("price cannot be negative")
        dollars = cents / 100.0
        price_str = f"${dollars:.2f}"
        lines.append(f"  {description}: {price_str}")
        total_cents += cents
    total_dollars = total_cents / 100.0
    total_str = f"${total_dollars:.2f}"
    lines.append(f"  Total: {total_str}")
    return "\n".join(lines)
PY

cat > test_format.py <<'PY'
from src.format import format_invoice


def test_single_item():
    out = format_invoice([("Widget", 199)])
    assert "Widget: $1.99" in out
    assert "Total: $1.99" in out


def test_multiple_items():
    out = format_invoice([("Widget", 199), ("Gadget", 250)])
    assert "Widget: $1.99" in out
    assert "Gadget: $2.50" in out
    assert "Total: $4.49" in out


def test_negative_price_raises():
    import pytest
    with pytest.raises(ValueError):
        format_invoice([("Bad", -1)])
PY

mkdir -p hidden
cat > hidden/test_refactor.py <<'PY'
# Hidden tests — never projected to model context.
import ast
import pathlib


def test_format_price_exists():
    text = pathlib.Path("src/format.py").read_text()
    tree = ast.parse(text)
    funcs = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert "format_price" in funcs, "format_price function not found"


def test_format_price_signature():
    from src.format import format_price
    import inspect
    sig = inspect.signature(format_price)
    params = list(sig.parameters.keys())
    assert params == ["cents"], f"expected single param 'cents', got {params}"


def test_format_price_behavior():
    from src.format import format_price
    assert format_price(199) == "$1.99"
    assert format_price(0) == "$0.00"
    assert format_price(5) == "$0.05"


def test_format_invoice_still_uses_format_price():
    text = pathlib.Path("src/format.py").read_text()
    # format_invoice should call format_price
    assert "format_price(" in text, "format_invoice does not call format_price"


def test_no_duplicate_price_logic():
    text = pathlib.Path("src/format.py").read_text()
    # The f"${...:.2f}" pattern should appear in exactly one function body
    # (format_price), not in format_invoice.
    tree = ast.parse(text)
    fmt_calls_per_func = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            count = 0
            for child in ast.walk(node):
                if (isinstance(child, ast.JoinedStr)
                        and any("$" in c.value for c in ast.walk(child)
                                if isinstance(c, ast.Constant))):
                    count += 1
            fmt_calls_per_func[node.name] = count
    # format_invoice should not have the formatting pattern any more
    assert fmt_calls_per_func.get("format_invoice", 0) == 0, \
        "format_invoice still contains inline price formatting"
PY

echo "setup complete"
