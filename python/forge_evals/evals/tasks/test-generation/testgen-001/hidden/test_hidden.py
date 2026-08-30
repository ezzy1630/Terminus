"""Private mutation-resistant checks for generated parser tests."""

from src.parser import parse_tokens


def test_parser_contract_is_unchanged() -> None:
    assert parse_tokens("") == []
    assert parse_tokens("   \t\n") == []
    assert parse_tokens("solo") == ["solo"]
    assert parse_tokens("alpha beta\n") == ["alpha", "beta"]
    assert parse_tokens("café 東京") == ["café", "東京"]
