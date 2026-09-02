"""Hidden slugify cases for test-repair-001 (never projected to the agent)."""

from __future__ import annotations

from src.textops import slugify


def test_german_umlauts():
    assert slugify("Grüße aus München") == "grusse-aus-munchen"


def test_numbers_are_kept():
    assert slugify("Release 2.0 Notes") == "release-2-0-notes"


def test_empty_string():
    assert slugify("") == ""


def test_only_separators():
    assert slugify(" --- !!! --- ") == ""
