import { describe, expect, test } from "bun:test";
import { decodeTerminalInput } from "../src/input.js";

describe("terminal input decoder", () => {
  test("decodes navigation and control keys", () => {
    expect(decodeTerminalInput("\u001b[A")).toEqual([
      { kind: "key", name: "up", text: "", ctrl: false, shift: false, alt: false },
    ]);
    expect(decodeTerminalInput("\u0010")).toEqual([
      { kind: "key", name: "p", text: "", ctrl: true, shift: false, alt: false },
    ]);
  });

  test("keeps a bracketed paste together", () => {
    expect(decodeTerminalInput("\u001b[200~fix this\nthen test\u001b[201~")).toEqual([
      { kind: "key", name: "text", text: "fix this\nthen test", ctrl: false, shift: false, alt: false },
    ]);
  });

  test("splits terminal-batched typing into individual keys", () => {
    expect(decodeTerminalInput("bd")).toEqual([
      { kind: "key", name: "b", text: "b", ctrl: false, shift: false, alt: false },
      { kind: "key", name: "d", text: "d", ctrl: false, shift: false, alt: false },
    ]);
  });

  test("decodes SGR mouse clicks and wheel input", () => {
    expect(decodeTerminalInput("\u001b[<0;12;8M")).toEqual([
      { kind: "mouse", action: "down", button: "left", x: 12, y: 8 },
    ]);
    expect(decodeTerminalInput("\u001b[<65;12;8M")).toEqual([
      { kind: "mouse", action: "scroll_down", button: "none", x: 12, y: 8 },
    ]);
  });
});
