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

const MOUSE_BUTTONS: readonly ("left" | "middle" | "right" | "none")[] = ["left", "middle", "right", "none"];
const SCROLL_ACTIONS: Record<number, MouseInput["action"]> = {
  64: "scroll_up",
  65: "scroll_down",
};

// skipcq: JS-0067
export function decodeMouse(sequence: string): MouseInput | null {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/.exec(sequence);
  if (!match) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const scroll = SCROLL_ACTIONS[code];
  if (scroll) return { kind: "mouse", action: scroll, button: "none", x, y };
  const button = MOUSE_BUTTONS[code & 3] ?? "none";
  const action = (code & 32) !== 0 ? "move" : (match[4] === "M" ? "down" : "up");
  return { kind: "mouse", action, button, x, y };
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
