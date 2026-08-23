#!/usr/bin/env python3
"""Make the pinned enterprise config tolerate duplicate Vite peer types."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
path = root / "packages/enterprise/vite.config.ts"
backup = path.with_name(f"{path.name}.terminus-overlay.bak")
if backup.exists():
    raise SystemExit(f"overlay backup already exists: {backup}")
shutil.copy2(path, backup)
source = path.read_text()
old = '''    nitro({
      ...nitroConfig,
      baseURL: process.env.OPENCODE_BASE_URL,
    }),'''
new = '''    nitro({
      ...nitroConfig,
      baseURL: process.env.OPENCODE_BASE_URL,
    }) as PluginOption,'''
if old not in source:
    raise SystemExit("enterprise Vite config did not match the pinned overlay base")
path.write_text(source.replace(old, new, 1))
