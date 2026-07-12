"""Hidden test for tiny-bugfix/01-fix-typo.

This file is NEVER projected into the model context. It is run by the
grader after the agent declares the task complete.
"""
import pathlib
import re


def test_typo_fixed_in_source() -> None:
    text = pathlib.Path("src/lib.py").read_text()
    assert "recieve" not in text, "typo 'recieve' still present in src/lib.py"
    assert re.search(r"receives?\b", text), "no correct spelling 'receive' found"
