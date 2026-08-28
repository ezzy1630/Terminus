/**
 * Terminus Desktop — single conversation message.
 *
 * Per SPEC §9.2: "Use a document-style feed. User messages may use
 * restrained low-contrast rounded surfaces. Agent responses should
 * mostly appear as clean text directly on the canvas. Do not place
 * every assistant response in a large chat bubble."
 *
 * Per SPEC §9.2: "Support selection and copying without fighting
 * custom interactions." — messages render with `selectable` class so
 * the user can drag-select text.
 *
 * Per SPEC §9.1: prose stays in a comfortable reading column (handled
 * by the parent Conversation, which sets a max-width); the message
 * itself is just typography.
 *
 * The renderer covers the markdown an agent actually writes: headings,
 * bullet and numbered lists, blockquotes, rules, fenced code blocks, and
 * inline code / bold / italic / strikethrough / links. Tables, footnotes and
 * nested lists are still out of scope and render as their source text, which
 * is legible; the previous subset was paragraphs and code fences only, so
 * every list and heading in a response arrived as raw `#` and `-`.
 */
import { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";
import type { ConversationMessage } from "../types";
import { Button } from "../ui/Button";
import { ContextMenu } from "../ui/Menu";

interface MessageProps {
  message: ConversationMessage;
}

interface ParsedSegment {
  kind: "code" | "text";
  lang?: string;
  content: string;
}

/** Split content into fenced code blocks and prose segments. */
function parseSegments(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const re = /```([\w-]*)\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIdx) {
      segments.push({ kind: "text", content: content.slice(lastIdx, m.index) });
    }
    segments.push({ kind: "code", lang: m[1] || undefined, content: m[2] ?? "" });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < content.length) {
    segments.push({ kind: "text", content: content.slice(lastIdx) });
  }
  if (segments.length === 0) segments.push({ kind: "text", content: "" });
  return segments;
}

interface InlineToken {
  kind: "text" | "code" | "bold" | "italic" | "strike" | "link";
  content: string;
  href?: string;
}

/**
 * Inline spans: `code`, **bold**, *italic*, ~~strike~~ and [links](url).
 *
 * Code is matched first and never re-scanned, so `**not bold**` inside a code
 * span stays literal.
 */
const INLINE_PATTERN =
  /(`[^`]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w_])_[^_\n]+_(?![\w_]))/g;

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  while ((m = INLINE_PATTERN.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push({ kind: "text", content: text.slice(lastIdx, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) {
      tokens.push({ kind: "code", content: tok.slice(1, -1) });
    } else if (tok.startsWith("[")) {
      const split = tok.indexOf("](");
      tokens.push({ kind: "link", content: tok.slice(1, split), href: tok.slice(split + 2, -1) });
    } else if (tok.startsWith("**")) {
      tokens.push({ kind: "bold", content: tok.slice(2, -2) });
    } else if (tok.startsWith("~~")) {
      tokens.push({ kind: "strike", content: tok.slice(2, -2) });
    } else {
      tokens.push({ kind: "italic", content: tok.slice(1, -1) });
    }
    lastIdx = INLINE_PATTERN.lastIndex;
  }
  if (lastIdx < text.length) tokens.push({ kind: "text", content: text.slice(lastIdx) });
  return tokens;
}

/** Only schemes a desktop app should ever hand to the OS. */
function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null;
}

function renderInline(text: string, keyBase: string): JSX.Element[] {
  return tokenizeInline(text).map((t, i) => {
    const key = `${keyBase}-${i}`;
    switch (t.kind) {
      case "code":
        return (
          <code key={key} className="rounded bg-hover px-1 py-0.5 font-mono text-primary text-xs">
            {t.content}
          </code>
        );
      case "bold":
        return <strong key={key} className="font-semibold text-primary">{t.content}</strong>;
      case "italic":
        return <em key={key} className="italic">{t.content}</em>;
      case "strike":
        return <s key={key} className="text-tertiary">{t.content}</s>;
      case "link": {
        const href = safeHref(t.href ?? "");
        // A link the app cannot safely open is still readable prose, so it
        // renders as text rather than as a control that does nothing.
        if (href === null) return <span key={key}>{t.content}</span>;
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline decoration-from-font underline-offset-2"
            data-tooltip={href}
          >
            {t.content}
          </a>
        );
      }
      default:
        return <span key={key}>{t.content}</span>;
    }
  });
}

type ProseBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; lines: string[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Group prose lines into blocks.
 *
 * Headings, lists, quotes and rules used to fall through to the paragraph
 * path, so an agent response — which is nearly always a heading and a bulleted
 * list — rendered as a literal wall of `##` and `-` characters.
 */
function parseProseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const lines = text.split("\n");
  let index = 0;

  const takeWhile = (match: RegExp): string[] => {
    const captured: string[] = [];
    while (index < lines.length) {
      const found = match.exec(lines[index] ?? "");
      if (!found) break;
      captured.push(found[1] ?? "");
      index += 1;
    }
    return captured;
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) { index += 1; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (BULLET.test(line)) {
      blocks.push({ kind: "list", ordered: false, items: takeWhile(BULLET) });
      continue;
    }
    if (NUMBERED.test(line)) {
      blocks.push({ kind: "list", ordered: true, items: takeWhile(NUMBERED) });
      continue;
    }
    if (QUOTE.test(line)) {
      blocks.push({ kind: "quote", lines: takeWhile(QUOTE) });
      continue;
    }
    // A paragraph runs to the next blank line or the next block opener.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim().length === 0) break;
      if (HEADING.test(current) || BULLET.test(current) || NUMBERED.test(current)
        || QUOTE.test(current) || RULE.test(current)) break;
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "ui-display-title mb-2 mt-5 first:mt-0 text-primary",
  2: "ui-page-title mb-1.5 mt-5 first:mt-0 text-primary",
  3: "ui-section-title mb-1.5 mt-4 first:mt-0 text-primary",
};

function renderProse(text: string, keyBase: string): JSX.Element[] {
  return parseProseBlocks(text).map((block, bi) => {
    const key = `${keyBase}-b-${bi}`;
    switch (block.kind) {
      case "heading": {
        const Tag = (`h${Math.min(block.level + 1, 6)}`) as "h2";
        return (
          <Tag key={key} className={HEADING_CLASS[Math.min(block.level, 3)] ?? HEADING_CLASS[3]}>
            {renderInline(block.text, key)}
          </Tag>
        );
      }
      case "rule":
        return <hr key={key} className="my-4 border-0 border-t border-subtle" />;
      case "quote":
        return (
          <blockquote key={key} className="ui-prose mb-3 border-l-2 border-default pl-3 text-secondary last:mb-0">
            {block.lines.map((line, li) => (
              <span key={`${key}-l-${li}`}>
                {renderInline(line, `${key}-l-${li}`)}
                {li < block.lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </blockquote>
        );
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag
            key={key}
            className={cn(
              "ui-prose mb-3 flex flex-col gap-1 pl-5 text-primary last:mb-0",
              block.ordered ? "list-decimal" : "list-disc",
            )}
          >
            {block.items.map((item, ii) => (
              <li key={`${key}-i-${ii}`} className="marker:text-tertiary">
                {renderInline(item, `${key}-i-${ii}`)}
              </li>
            ))}
          </ListTag>
        );
      }
      default:
        return (
          <p key={key} className="ui-prose mb-3 text-primary last:mb-0">
            {block.lines.map((line, li) => (
              <span key={`${key}-l-${li}`}>
                {renderInline(line, `${key}-l-${li}`)}
                {li < block.lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
    }
  });
}

function MessageImpl({ message }: MessageProps): JSX.Element {
  const segments = useMemo(() => parseSegments(message.content), [message.content]);
  const [copyState, setCopyState] = useState<{ segment: number; status: "copied" | "failed" } | null>(null);

  const copyCode = async (content: string, segment: number): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content.replace(/\n$/, ""));
      setCopyState({ segment, status: "copied" });
    } catch {
      setCopyState({ segment, status: "failed" });
    }
    window.setTimeout(() => setCopyState((current) => current?.segment === segment ? null : current), 1600);
  };
  const contextItems = [{
    id: "copy-message",
    label: "Copy message",
    onSelect: () => void navigator.clipboard?.writeText(message.content),
  }] as const;

  if (message.role === "user") {
    // Restrained low-contrast rounded surface.
    return (
      <ContextMenu items={contextItems}>
      <div className="selectable my-2.5 flex justify-end">
        <div
          className="max-w-[80%] rounded-lg border border-subtle bg-card px-3.5 py-2.5 text-primary"
        >
          <div
            className="ui-prose whitespace-pre-wrap"
          >
            {message.content}
          </div>
        </div>
      </div>
      </ContextMenu>
    );
  }

  // Agent response — clean text directly on canvas.
  return (
    <ContextMenu items={contextItems}>
    <div className="selectable my-3.5">
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          return (
            <div
              key={`seg-${i}`}
              className={cn(
                "code-surface selectable group my-3 overflow-hidden rounded-md border border-subtle",
              )}
            >
              <div className="code-toolbar flex h-7 items-center justify-between border-b border-subtle px-2.5">
                <span className="font-mono text-tertiary text-xs" >
                  {seg.lang || "code"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="code-copy flex h-7 items-center gap-1.5 rounded-md px-2 text-tertiary hover:bg-hover hover:text-primary"
                  onClick={() => void copyCode(seg.content, i)}
                  aria-label={copyState?.segment === i && copyState.status === "copied" ? "Copied code" : copyState?.segment === i && copyState.status === "failed" ? "Copy failed" : "Copy code"}
                >
                  {copyState?.segment === i && copyState.status === "copied" ? <Check size={13} /> : <Copy size={13} />}
                  <span className="text-xs">{copyState?.segment === i ? (copyState.status === "copied" ? "Copied" : "Try again") : "Copy"}</span>
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-none border-0 px-3 py-2.5 text-xs leading-5">
                <code>{seg.content.replace(/\n$/, "")}</code>
              </pre>
            </div>
          );
        }
        return (
          <div key={`seg-${i}`}>
            {renderProse(seg.content, `seg-${i}`)}
          </div>
        );
      })}
      {message.streaming ? (
        <span
          className="streaming-caret ml-1 inline-block"
          aria-label="Response in progress"
        />
      ) : null}
    </div>
    </ContextMenu>
  );
}

export const Message = memo(MessageImpl);
