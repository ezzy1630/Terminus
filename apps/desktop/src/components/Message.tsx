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
 * The renderer intentionally supports only a tiny markdown subset
 * (paragraphs, line breaks, fenced code blocks, inline code). Full
 * markdown rendering is a Phase-5 concern and would be lazy-loaded.
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

/** Render inline code (`...`) and **bold** within a line of prose. */
function renderInline(text: string, keyBase: string): JSX.Element[] {
  // Tokenize on `code` and **bold** spans.
  const tokens: Array<{ kind: "text" | "code" | "bold"; content: string }> = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ kind: "text", content: text.slice(lastIdx, m.index) });
    }
    const tok = m[0];
    if (tok.startsWith("`")) tokens.push({ kind: "code", content: tok.slice(1, -1) });
    else tokens.push({ kind: "bold", content: tok.slice(2, -2) });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) tokens.push({ kind: "text", content: text.slice(lastIdx) });

  return tokens.map((t, i) => {
    if (t.kind === "code") {
      return (
        <code
          key={`${keyBase}-${i}`}
          className="rounded bg-hover px-1 py-0.5 font-mono text-primary text-xs"

        >
          {t.content}
        </code>
      );
    }
    if (t.kind === "bold") {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold text-primary">
          {t.content}
        </strong>
      );
    }
    return <span key={`${keyBase}-${i}`}>{t.content}</span>;
  });
}

function renderProse(text: string, keyBase: string): JSX.Element[] {
  // Split on blank lines → paragraphs. Single newlines become <br/>.
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, pi) => {
    const lines = para.split("\n");
    return (
      <p
        key={`${keyBase}-p-${pi}`}
        className="ui-prose mb-3 text-primary last:mb-0"
      >
        {lines.map((line, li) => (
          <span key={`${keyBase}-p-${pi}-l-${li}`}>
            {renderInline(line, `${keyBase}-p-${pi}-l-${li}`)}
            {li < lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
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
