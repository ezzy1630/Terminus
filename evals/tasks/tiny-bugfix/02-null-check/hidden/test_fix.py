# Hidden tests for tiny-bugfix/02-null-check. Never projected to model context.
from src.parser import parse_user


def test_parse_user_none() -> None:
    assert parse_user(None) is None


def test_parse_user_missing_name() -> None:
    assert parse_user({"age": 30}) is None


def test_parse_user_empty_dict() -> None:
    assert parse_user({}) is None
