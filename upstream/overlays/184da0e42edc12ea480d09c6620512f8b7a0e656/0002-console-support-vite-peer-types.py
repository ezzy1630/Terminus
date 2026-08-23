#!/usr/bin/env python3
"""Make the pinned console support config tolerate duplicate Vite peer types."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
path = root / "packages/console/support/vite.config.ts"
backup = path.with_name(f"{path.name}.terminus-overlay.bak")
if backup.exists():
    raise SystemExit(f"overlay backup already exists: {backup}")
shutil.copy2(path, backup)
source = path.read_text()
old = '''    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare_module",
      cloudflare: {
        nodeCompat: true,
      },
    }),'''
new = '''    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare_module",
      cloudflare: {
        nodeCompat: true,
      },
    }) as PluginOption,'''
if old not in source:
    raise SystemExit("console support Vite config did not match the pinned overlay base")
path.write_text(source.replace(old, new, 1))
