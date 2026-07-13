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
          className="rounded bg-hover px-1 py-0.5 font-mono text-primary"
          style={{ fontSize: "0.92em" }}
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
        className="text-primary"
        style={{
          fontSize: "var(--font-size-md)",
          lineHeight: "var(--line-height-relaxed)" as unknown as string,
          marginBottom: 12,
        }}
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
  const [copiedSegment, setCopiedSegment] = useState<number | null>(null);

  const copyCode = async (content: string, segment: number): Promise<void> => {
    await navigator.clipboard.writeText(content.replace(/\n$/, ""));
    setCopiedSegment(segment);
    window.setTimeout(() => setCopiedSegment((current) => current === segment ? null : current), 1400);
  };

  if (message.role === "user") {
    // Restrained low-contrast rounded surface.
    return (
      <div className="selectable my-3">
        <div
          className="rounded-md border border-subtle px-4 py-3 text-primary"
          style={{ background: "var(--bg-elevated)" }}
        >
          <div
            className="mb-1 text-xs uppercase tracking-wide text-tertiary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            You
          </div>
          <div
            className="whitespace-pre-wrap"
            style={{ fontSize: "var(--font-size-md)", lineHeight: "var(--line-height-relaxed)" as unknown as string }}
          >
            {message.content}
          </div>
        </div>
        <div
          className="mt-1 px-1 text-xs text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    );
  }

  // Agent response — clean text directly on canvas.
  return (
    <div className="selectable my-4">
      <div
        className="mb-2 text-xs uppercase tracking-wide text-tertiary"
        style={{ fontSize: "var(--font-size-xs)" }}
      >
        Terminus
      </div>
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          return (
            <div
              key={`seg-${i}`}
              className={cn(
                "code-surface selectable group my-3 overflow-hidden rounded-md border border-subtle",
              )}
            >
              <div className="code-toolbar flex h-8 items-center justify-between border-b border-subtle px-3">
                <span className="font-mono text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
                  {seg.lang || "code"}
                </span>
                <button
                  type="button"
                  className="code-copy flex h-6 items-center gap-1 rounded px-1.5 text-tertiary hover:bg-hover hover:text-primary"
                  onClick={() => void copyCode(seg.content, i)}
                  aria-label={copiedSegment === i ? "Copied code" : "Copy code"}
                >
                  {copiedSegment === i ? <Check size={12} /> : <Copy size={12} />}
                  <span style={{ fontSize: "var(--font-size-xs)" }}>{copiedSegment === i ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre className="overflow-x-auto rounded-none border-0 px-4 py-3" style={{ fontSize: "var(--font-size-sm)", lineHeight: 1.55 }}>
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
          className="ml-1 inline-block animate-pulse text-secondary"
          aria-label="streaming"
          style={{ width: 6, height: 14, background: "var(--text-secondary)" }}
        />
      ) : null}
    </div>
  );
}

export const Message = memo(MessageImpl);
