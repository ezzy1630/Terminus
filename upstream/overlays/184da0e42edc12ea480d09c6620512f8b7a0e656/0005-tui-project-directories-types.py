#!/usr/bin/env python3
"""Narrow the pinned generated SDK response at the TUI resource boundary."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
path = root / "packages/tui/src/component/dialog-move-session.tsx"
backup = path.with_name(f"{path.name}.terminus-overlay.bak")
if backup.exists():
    raise SystemExit(f"overlay backup already exists: {backup}")
shutil.copy2(path, backup)
source = path.read_text()
old = '''        return info.value
      }
    },
  )
  const directoryData = createMemo(() => directories() ?? props.initialDirectories)'''
new = '''        return info.value as ProjectDirectories | undefined
      }
    },
  )
  const directoryData = createMemo(
    () => (directories() as ProjectDirectories | undefined) ?? props.initialDirectories,
  )'''
if old not in source:
    raise SystemExit("TUI project-directory resource did not match the pinned overlay base")
path.write_text(source.replace(old, new, 1))
