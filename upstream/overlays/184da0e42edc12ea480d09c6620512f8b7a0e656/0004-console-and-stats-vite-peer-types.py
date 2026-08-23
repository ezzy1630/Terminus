#!/usr/bin/env python3
"""Make the pinned Nitro configs tolerate duplicate Vite peer types."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
paths = (
    root / "packages/console/app/vite.config.ts",
    root / "packages/stats/app/vite.config.ts",
)
old = '''    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }),'''
new = '''    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }) as PluginOption,'''
for path in paths:
    backup = path.with_name(f"{path.name}.terminus-overlay.bak")
    if backup.exists():
        raise SystemExit(f"overlay backup already exists: {backup}")
    shutil.copy2(path, backup)
    source = path.read_text()
    if old not in source:
        raise SystemExit(f"{path} did not match the pinned overlay base")
    path.write_text(source.replace(old, new, 1))
