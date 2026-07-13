#!/usr/bin/env python3
"""Apply the minimal compatibility overlay to a temporary OpenCode copy."""
from pathlib import Path
import sys

root = Path(sys.argv[1])
path = root / "packages/opencode/src/bus/global.ts"
source = path.read_text()
old = '''  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
'''
new = '''  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName !== "event") return super.emit(eventName, ...args)
    const event = args[0] as GlobalEvent
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit("event", event)
  }
'''
if old not in source:
    raise SystemExit("global event emitter source did not match the pinned overlay base")
path.write_text(source.replace(old, new, 1))
