"""Hidden test (SPEC §41.4 — never projected into model context)."""

from pathlib import Path


def test_workdir_exists(tmp_path: Path) -> None:
    """The workspace workdir exists and is writable."""
    (tmp_path / "marker").write_text("ok", encoding="utf-8")
    assert (tmp_path / "marker").read_text() == "ok"
