export interface KeyInput {
  readonly kind: "key";
  readonly name: string;
  readonly text: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface MouseInput {
  readonly kind: "mouse";
  readonly action: "down" | "up" | "move" | "scroll_up" | "scroll_down";
  readonly button: "left" | "middle" | "right" | "none";
  readonly x: number;
  readonly y: number;
}

export type TerminalInput = KeyInput | MouseInput;

const NAMED_SEQUENCES: Readonly<Record<string, string>> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001b[H": "home",
  "\u001b[F": "end",
  "\u001b[1~": "home",
  "\u001b[4~": "end",
  "\u001b[5~": "pageup",
  "\u001b[6~": "pagedown",
  "\u001b[3~": "delete",
  "\u001b[Z": "tab",
};

function key(name: string, text = "", options: Partial<Omit<KeyInput, "kind" | "name" | "text">> = {}): KeyInput {
  return {
    kind: "key",
    name,
    text,
    ctrl: options.ctrl ?? false,
    shift: options.shift ?? false,
    alt: options.alt ?? false,
  };
}

// skipcq: JS-0067
const MOUSE_BUTTONS: readonly ("left" | "middle" | "right" | "none")[] = ["left", "middle", "right", "none"];
// skipcq: JS-0067
const SCROLL_ACTIONS: Record<number, MouseInput["action"]> = {
  64: "scroll_up",
  65: "scroll_down",
};

// skipcq: JS-0067
function getMouseAction(code: number, finalChar: string): MouseInput["action"] {
  if ((code & 32) !== 0) return "move";
  return finalChar === "M" ? "down" : "up";
}

const MOUSE_PATTERN = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/;

// Wheel events carry the button bits differently from press/release events:
// codes 64/65 map directly to scroll actions and never carry a button.
const decodeScrollMouse = (code: number, x: number, y: number): MouseInput | null => {
  const scroll = SCROLL_ACTIONS[code];
  if (scroll === undefined) return null;
  return { kind: "mouse", action: scroll, button: "none", x, y };
};

// skipcq: JS-0067
export function decodeMouse(sequence: string): MouseInput | null {
  const match = MOUSE_PATTERN.exec(sequence);
  if (match === null) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const scroll = decodeScrollMouse(code, x, y);
  if (scroll !== null) return scroll;
  return {
    kind: "mouse",
    action: getMouseAction(code, match[4] as string),
    // The mask always lands inside MOUSE_BUTTONS (4 entries), so the index
    // lookup is total; `code % 4` is equivalent to `code & 3` for non-negative
    // codes and keeps the decision structure flat.
    button: MOUSE_BUTTONS[code % MOUSE_BUTTONS.length] as MouseInput["button"],
    x,
    y,
  };
}

/** Decode one terminal data chunk. Bracketed paste is returned as text. */
export function decodeTerminalInput(data: Uint8Array | string): readonly TerminalInput[] {
  const value = typeof data === "string" ? data : new TextDecoder().decode(data);
  if (value.startsWith("\u001b[200~") && value.endsWith("\u001b[201~")) {
    return [key("text", value.slice(6, -6))];
  }

  const mouse = decodeMouse(value);
  if (mouse) return [mouse];
  const named = NAMED_SEQUENCES[value];
  if (named) return [key(named, "", { shift: value === "\u001b[Z" })];

  // Raw-mode terminals may batch fast typing into one data event. Dispatch
  // ordinary text one character at a time so navigation bindings and prompt
  // editing behave identically whether bytes arrive together or separately.
  const characters = [...value];
  if (characters.length > 1 && !value.includes("\u001b")) {
    return characters.flatMap((character) => decodeTerminalInput(character));
  }

  if (value === "\r" || value === "\n") return [key("enter")];
  if (value === "\t") return [key("tab")];
  if (value === "\u001b") return [key("escape")];
  if (value === "\u007f" || value === "\b") return [key("backspace")];
  if (value === "\u0003") return [key("c", "", { ctrl: true })];
  if (value === "\u0011") return [key("q", "", { ctrl: true })];
  if (value === "\u0010") return [key("p", "", { ctrl: true })];
  if (value === "\u0012") return [key("r", "", { ctrl: true })];
  if (value === "\u000c") return [key("l", "", { ctrl: true })];

  if (value.startsWith("\u001b") && value.length === 2) {
    const character = value.slice(1);
    return [key(character.toLowerCase(), character, { alt: true, shift: character !== character.toLowerCase() })];
  }

  if (value.length > 0 && !value.includes("\u001b")) {
    return [key(value.length === 1 ? value.toLowerCase() : "text", value, {
      shift: value.length === 1 && value !== value.toLowerCase(),
    })];
  }
  return [];
}
