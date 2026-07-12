#!/usr/bin/env python3
"""Enforce the OpenCode source/divergence contract at release time."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "upstream/opencode.lock.json"
BUDGET_PATH = ROOT / "upstream/divergence-budget.yaml"
BYPASS_PATH = ROOT / "docs/security/effect-bypass-register.yaml"


def fail(message: str) -> None:
    print(f"[upstream-check] {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    lock = json.loads(LOCK_PATH.read_text())
    if lock.get("status") != "pinned":
        fail("OpenCode lockfile is not pinned")
    commit = lock.get("pinned", {}).get("commit")
    if not isinstance(commit, str) or len(commit) != 40:
        fail("OpenCode lockfile has no valid commit")

    inherited = ROOT / "vendor/opencode" / commit
    if not inherited.is_dir():
        fail(f"immutable OpenCode source is not imported at {inherited}")

    budget = yaml.safe_load(BUDGET_PATH.read_text())
    per_release = budget.get("budget", {}).get("per_release", {})
    modified = budget.get("modified_files", [])
    if len(modified) > int(per_release.get("max_modified_files", 0)):
        fail("OpenCode modified-file divergence budget exceeded")
    hours = sum(float(item.get("conflict_hours", 0)) for item in modified)
    if hours > float(per_release.get("max_merge_conflict_hours", 0)):
        fail("OpenCode merge-conflict-hour budget exceeded")
    for item in modified:
        source = item.get("source")
        if not isinstance(source, str) or not (inherited / source).is_file():
            fail(f"divergence entry does not reference a real inherited file: {source}")

    bypass = yaml.safe_load(BYPASS_PATH.read_text()) or {}
    entries = bypass.get("entries", [])
    for item in entries:
        source = item.get("source")
        if not isinstance(source, str) or not (ROOT / source).exists():
            fail(f"effect-bypass entry does not reference a real file: {source}")
    if int(per_release.get("max_bypass_register_open", 0)) == 0:
        open_entries = [item for item in entries if item.get("status") not in {"contained", "removed"}]
        if open_entries:
            fail(f"effect-bypass register has {len(open_entries)} open entries")

    subprocess.run(["bash", str(ROOT / "scripts/verify-upstream-pin.sh")], check=True)
    print(f"[upstream-check] source imported and divergence budget is within limits for {commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
