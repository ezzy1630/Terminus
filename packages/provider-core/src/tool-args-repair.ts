/**
 * Deterministic repair for tool-call arguments JSON.
 *
 * Models occasionally emit tool arguments that are almost-JSON: a truncated
 * final string, a trailing comma before a closer, or an unterminated object
 * because the output limit cut the call short. The strict decode layer
 * currently turns such calls into `INVALID_TOOL_ARGUMENTS` error chunks,
 * which fails the whole request even though the intended object is obvious.
 *
 * `repairToolArgumentsJson` applies a deliberately narrow set of fixes —
 * no speculative reformatting, no regexes over string contents — and
 * returns the parsed object, or null when the text cannot be interpreted
 * as a JSON object with confidence. Callers must keep their strict
 * fallback for null results.
 */

/**
 * Re-scan the text and, for commas that appear outside string literals
 * immediately before an object/array closer, drop them. Then append the
 * closers for any openers still open, honoring string state.
 */
function repairUnbalancedJson(text: string): string | null {
  // Pass 1: drop commas directly followed by a closer, outside strings.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let look = index + 1;
      while (look < text.length && /\s/.test(text[look]!)) look += 1;
      const next = text[look];
      if (next === "}" || next === "]") continue; // drop the comma
    }
    out += char;
  }

  // Pass 2: close openers that are still open, tracking string state.
  const stack: string[] = [];
  inString = false;
  escaped = false;
  for (const char of out) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  // An unterminated string at the top level of an argument list is almost
  // always a truncated value; close it before closing the structural openers.
  let repaired = out;
  if (inString) repaired += '"';
  while (stack.length > 0) {
    const opener = stack.pop()!;
    repaired += opener === "{" ? "}" : "]";
  }
  return repaired;
}

export function repairToolArgumentsJson(json: string): Readonly<Record<string, unknown>> | null {
  try {
    const direct: unknown = JSON.parse(json);
    return isRecord(direct) ? direct : null;
  } catch {
    // Fall through to repair.
  }
  if (json.trim().length === 0) return null;
  const repaired = repairUnbalancedJson(json);
  if (repaired === null) return null;
  try {
    const parsed: unknown = JSON.parse(repaired);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
