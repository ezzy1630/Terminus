/**
 * Terminus Desktop — Lightweight, high-performance syntax highlighter.
 *
 * Fast tokenization for diff lines and code snippets without heavyweight
 * external runtime parser dependencies. Tokenizes keywords, types, strings,
 * comments, numbers, functions, and punctuation across TypeScript/JavaScript,
 * Rust, Python, Go, JSON, SQL, and YAML.
 */
import React from "react";

export type TokenType =
  | "keyword"
  | "type"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "operator"
  | "punctuation"
  | "text";

interface Token {
  type: TokenType;
  value: string;
}

const KEYWORDS = new Set([
  // TS / JS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "default", "import", "export", "from",
  "as", "class", "extends", "implements", "interface", "type", "enum", "async",
  "await", "yield", "try", "catch", "finally", "throw", "new", "typeof", "instanceof",
  "in", "of", "null", "undefined", "true", "false", "this", "super",
  // Rust
  "fn", "pub", "mut", "let", "struct", "enum", "trait", "impl", "use", "mod",
  "match", "loop", "where", "unsafe", "ref", "self", "Self", "crate", "super",
  // Python
  "def", "class", "import", "from", "return", "if", "elif", "else", "for", "while",
  "try", "except", "finally", "raise", "with", "as", "pass", "lambda", "None", "True", "False",
  // Go
  "func", "package", "import", "type", "struct", "interface", "return", "var", "const",
  "defer", "go", "select", "chan", "map", "range", "nil",
]);

const TYPES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "void", "never", "unknown", "any",
  "object", "Array", "Record", "Promise", "Map", "Set", "JSX", "Element", "ReactNode",
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Box", "Arc", "Rc",
  "int", "float", "str", "bool", "list", "dict", "tuple", "set", "bytes",
]);

export function tokenizeCodeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    // 1. Comments
    if (
      (line[i] === "/" && line[i + 1] === "/") ||
      (line[i] === "#" && !line.slice(i).startsWith("#include"))
    ) {
      tokens.push({ type: "comment", value: line.slice(i) });
      break;
    }

    // 2. Strings
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const quote = line[i];
      let j = i + 1;
      while (j < len && line[j] !== quote) {
        if (line[j] === "\\" && j + 1 < len) j += 2;
        else j++;
      }
      if (j < len) j++; // include closing quote
      tokens.push({ type: "string", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // 3. Numbers
    if (/\d/.test(line[i] ?? "") && (i === 0 || /[\s,([{:+\-*/%<>=!&|^~]/.test(line[i - 1] ?? ""))) {
      let j = i;
      while (j < len && /[\d.xXa-fA-F_]/.test(line[j] ?? "")) j++;
      tokens.push({ type: "number", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // 4. Identifiers (Keywords, Types, Functions)
    if (/[a-zA-Z_$]/.test(line[i] ?? "")) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_$]/.test(line[j] ?? "")) j++;
      const word = line.slice(i, j);

      if (KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (TYPES.has(word) || /^[A-Z][a-zA-Z0-9]*$/.test(word)) {
        tokens.push({ type: "type", value: word });
      } else if (j < len && line[j] === "(") {
        tokens.push({ type: "function", value: word });
      } else {
        tokens.push({ type: "text", value: word });
      }
      i = j;
      continue;
    }

    // 5. Operators & Punctuation
    if (/[:;,(){}[\]]/.test(line[i] ?? "")) {
      tokens.push({ type: "punctuation", value: line[i] ?? "" });
      i++;
      continue;
    }

    if (/[+\-*/%<>=!&|^~?]/.test(line[i] ?? "")) {
      let j = i;
      while (j < len && /[+\-*/%<>=!&|^~?]/.test(line[j] ?? "")) j++;
      tokens.push({ type: "operator", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // 6. Whitespace and other characters
    let j = i;
    while (j < len && !/[a-zA-Z0-9_$"'/`#+\-*/%<>=!&|^~?:;,(){}[\]]/.test(line[j] ?? "")) {
      j++;
    }
    tokens.push({ type: "text", value: line.slice(i, j) });
    i = j;
  }

  return tokens;
}

export function renderHighlightedLine(line: string, keyPrefix = "syn"): React.ReactNode {
  if (!line || line.trim().length === 0) {
    return line || " ";
  }

  const tokens = tokenizeCodeLine(line);

  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (token.type) {
      case "keyword":
        return (
          <span key={key} className="syn-keyword">
            {token.value}
          </span>
        );
      case "type":
        return (
          <span key={key} className="syn-type">
            {token.value}
          </span>
        );
      case "string":
        return (
          <span key={key} className="syn-string">
            {token.value}
          </span>
        );
      case "comment":
        return (
          <span key={key} className="syn-comment">
            {token.value}
          </span>
        );
      case "number":
        return (
          <span key={key} className="syn-number">
            {token.value}
          </span>
        );
      case "function":
        return (
          <span key={key} className="syn-function">
            {token.value}
          </span>
        );
      case "operator":
        return (
          <span key={key} className="syn-operator">
            {token.value}
          </span>
        );
      case "punctuation":
        return (
          <span key={key} className="syn-punctuation">
            {token.value}
          </span>
        );
      case "text":
      default:
        return <span key={key}>{token.value}</span>;
    }
  });
}
