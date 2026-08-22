#!/usr/bin/env python3
"""Use standard tsc for console-support typecheck on environments without native tsgo."""
from pathlib import Path
import sys

root = Path(sys.argv[1])
path = root / "packages/console/support/package.json"
if path.is_file():
    source = path.read_text()
    old = '"typecheck": "tsgo --noEmit"'
    new = '"typecheck": "tsc --noEmit"'
    if old in source:
        path.write_text(source.replace(old, new, 1))
