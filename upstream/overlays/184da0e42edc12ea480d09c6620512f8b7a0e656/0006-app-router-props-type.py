#!/usr/bin/env python3
"""Provide the router root callback type lost through Solid Dynamic inference."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
path = root / "packages/app/src/app.tsx"
backup = path.with_name(f"{path.name}.terminus-overlay.bak")
if backup.exists():
    raise SystemExit(f"overlay backup already exists: {backup}")
shutil.copy2(path, backup)
source = path.read_text()
old = "                root={(routerProps) => ("
new = "                root={(routerProps: ParentProps) => ("
if old not in source:
    raise SystemExit("app router root callback did not match the pinned overlay base")
path.write_text(source.replace(old, new, 1))
