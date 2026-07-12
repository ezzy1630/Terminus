# Hidden tests for refactor/01-extract-function. Never projected to model context.
import ast
import inspect
import pathlib


def test_format_price_exists() -> None:
    text = pathlib.Path("src/format.py").read_text()
    tree = ast.parse(text)
    funcs = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert "format_price" in funcs


def test_format_price_signature() -> None:
    from src.format import format_price
    sig = inspect.signature(format_price)
    params = list(sig.parameters.keys())
    assert params == ["cents"]


def test_format_price_behavior() -> None:
    from src.format import format_price
    assert format_price(199) == "$1.99"
    assert format_price(0) == "$0.00"
    assert format_price(5) == "$0.05"


def test_format_invoice_still_uses_format_price() -> None:
    text = pathlib.Path("src/format.py").read_text()
    assert "format_price(" in text


def test_no_duplicate_price_logic() -> None:
    text = pathlib.Path("src/format.py").read_text()
    tree = ast.parse(text)
    fmt_calls_per_func = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            count = 0
            for child in ast.walk(node):
                if isinstance(child, ast.JoinedStr):
                    for c in ast.walk(child):
                        if isinstance(c, ast.Constant) and isinstance(c.value, str) and "$" in c.value:
                            count += 1
            fmt_calls_per_func[node.name] = count
    assert fmt_calls_per_func.get("format_invoice", 0) == 0
