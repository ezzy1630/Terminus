/**
 * Terminus Desktop — single conversation message.
 *
 * The transcript speaks Codex's language: an assistant reply is plain prose on
 * the canvas — no bubble, no avatar, no card, no name label — and a user turn
 * is a small right-aligned pill. The only thing separating one turn from the
 * next is vertical rhythm, which is what makes a long conversation read as a
 * document instead of a chat log.
 *
 * Per SPEC §9.2: "Support selection and copying without fighting custom
 * interactions." — messages render with `selectable` so the reader can
 * drag-select text, and every reply carries a real clipboard action.
 *
 * Per SPEC §9.1: prose stays in a comfortable reading column (owned by the
 * parent Conversation, which sets the max-width); the message itself is just
 * typography.
 *
 * The renderer covers the markdown an agent actually writes: headings,
 * bullet and numbered lists, blockquotes, rules, fenced code blocks, and
 * inline code / bold / italic / strikethrough / links. Tables, footnotes and
 * nested lists are still out of scope and render as their source text, which
 * is legible; the previous subset was paragraphs and code fences only, so
 * every list and heading in a response arrived as raw `#` and `-`.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";
import { clockTimestamp } from "../lib/time";
import type { ConversationMessage } from "../types";
import { Button } from "../ui/Button";
import { ContextMenu } from "../ui/Menu";

interface MessageProps {
  message: ConversationMessage;
  /**
   * True for the newest turn in the feed.
   *
   * Its action row stays visible; every earlier reply reveals its own on
   * hover. A transcript with a row of controls under every turn is a web
   * dashboard — the affordance has to be there without being drawn.
   */
  isLast?: boolean;
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
        // Sized relative to the prose around it. A fixed 11–12px inline span
        // inside 14px text sits visibly below the baseline of its own line.
        return (
          <code
            key={key}
            className="rounded-[4px] bg-elevated px-1 py-px font-mono text-[0.92em] text-primary"
          >
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

/**
 * Headings inside a reply are small.
 *
 * They were the display and page-title scales — 20px and 15px semibold — which
 * made an agent's `##` louder than the app's own screen titles and turned a
 * routine answer into a landing page. A heading in a transcript only has to
 * separate two paragraphs, so it steps down from the 14px prose rather than up.
 */
const HEADING_CLASS: Record<number, string> = {
  1: "ui-page-title mb-1.5 mt-5 text-primary",
  2: "ui-prose mb-1.5 mt-4 font-semibold text-primary",
  3: "ui-body mb-1 mt-3.5 font-semibold text-secondary",
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

/** How long a "Copied" acknowledgement stays on screen. */
const COPY_ACKNOWLEDGEMENT_MS = 1600;

type CopyStatus = "copied" | "failed";

function MessageImpl({ message, isLast = false }: MessageProps): JSX.Element {
  const segments = useMemo(() => parseSegments(message.content), [message.content]);
  const [copyState, setCopyState] = useState<{ segment: number; status: CopyStatus } | null>(null);
  const [replyCopyState, setReplyCopyState] = useState<CopyStatus | null>(null);

  const copyCode = async (content: string, segment: number): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content.replace(/\n$/, ""));
      setCopyState({ segment, status: "copied" });
    } catch {
      setCopyState({ segment, status: "failed" });
    }
    window.setTimeout(
      () => setCopyState((current) => current?.segment === segment ? null : current),
      COPY_ACKNOWLEDGEMENT_MS,
    );
  };

  /** Put the reply on the clipboard as its own source text, not as rendered DOM. */
  const copyReply = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.content);
      setReplyCopyState("copied");
    } catch {
      setReplyCopyState("failed");
    }
    window.setTimeout(() => setReplyCopyState(null), COPY_ACKNOWLEDGEMENT_MS);
  }, [message.content]);

  // Rebuilt only when the text changes. A fresh array on every render handed
  // the menu a new `items` identity for every streamed delta.
  const contextItems = useMemo(() => [{
    id: "copy-message",
    label: "Copy message",
    onSelect: () => void navigator.clipboard?.writeText(message.content),
  }] as const, [message.content]);

  if (message.role === "user") {
    // A small right-aligned pill, like Codex's. The time it was sent is real
    // information but not worth a line of its own, so it lives in the tooltip.
    return (
      <ContextMenu items={contextItems}>
      <div className="selectable mt-6 mb-0 flex justify-end">
        <div
          className="max-w-[70%] rounded-2xl bg-elevated px-3.5 py-2 text-primary"
          data-tooltip={clockTimestamp(message.createdAt)}
        >
          <div className="ui-prose whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      </div>
      </ContextMenu>
    );
  }

  // A reply that has settled and actually said something can be copied. A
  // streaming reply has no final text yet, so it offers nothing.
  const showActions = message.streaming !== true && message.content.length > 0;

  // Agent response — plain prose directly on the canvas.
  return (
    <ContextMenu items={contextItems}>
    <div className="selectable group/turn mt-3">
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          const state = copyState?.segment === i ? copyState.status : null;
          return (
            <div
              key={`seg-${i}`}
              className="code-surface selectable group/code my-3 overflow-hidden rounded-lg border border-subtle"
            >
              {/* A hairline header, not a filled toolbar. The language is the
                  only thing worth stating at rest; the copy control appears
                  when the reader's pointer is actually on the block. */}
              <div className="flex h-7 items-center justify-between border-b border-subtle px-2.5">
                <span className="ui-code text-tertiary">{seg.lang || "code"}</span>
                <Button
                  variant="bare"
                  onClick={() => void copyCode(seg.content, i)}
                  aria-label={state === "copied" ? "Copied code" : state === "failed" ? "Copy failed" : "Copy code"}
                  data-tooltip={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code"}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md text-tertiary transition-opacity",
                    "hover:bg-hover hover:text-secondary focus-visible:opacity-100",
                    state === null ? "opacity-0 group-hover/code:opacity-100" : "opacity-100",
                  )}
                >
                  {state === "copied" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
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

      {/* Action row.

          Copy is the only control here because it is the only one with
          something behind it. Feedback (👍/👎) and branch-from-here are part of
          Codex's row, but Terminus's control plane exposes neither a feedback
          nor a fork endpoint — rendering them would be two buttons that
          silently do nothing. */}
      {showActions ? (
        <div className="mt-1.5 flex h-6 items-center gap-2">
          <Button
            variant="bare"
            onClick={() => void copyReply()}
            aria-label={replyCopyState === "copied"
              ? "Reply copied"
              : replyCopyState === "failed" ? "Copy reply failed" : "Copy reply"}
            data-tooltip={replyCopyState === "copied"
              ? "Copied"
              : replyCopyState === "failed" ? "Copy failed" : "Copy"}
            className={cn(
              "-ml-1 flex size-6 items-center justify-center rounded-md text-tertiary transition-opacity",
              "hover:bg-hover hover:text-secondary focus-visible:opacity-100",
              isLast || replyCopyState !== null
                ? "opacity-100"
                : "opacity-0 group-hover/turn:opacity-100",
            )}
          >
            {replyCopyState === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </Button>
        </div>
      ) : null}
    </div>
    </ContextMenu>
  );
}

export const Message = memo(MessageImpl);
