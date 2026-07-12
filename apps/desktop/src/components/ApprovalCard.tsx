/**
 * Terminus Desktop — ApprovalCard.
 *
 * Per SPEC §17: "Render approvals inline at the point where they occur."
 * Not a modal. The card shows:
 *
 *   - Plain-language action          (e.g. "Run database migration")
 *   - Exact command or operation     (e.g. "npm run migrate:production")
 *   - Why approval is required       (e.g. "This may modify the production database.")
 *   - Risk                            (low / normal / high / critical)
 *   - Scope                           (workspace / external_systems / network)
 *   - Affected environment            (e.g. "production")
 *   - Whether permission persists     (allow once vs allow for this task)
 *   - Available choices: Allow once · Allow for this task · Deny
 *
 * The card surfaces as a subtle inline block in the conversation feed
 * (not a chat bubble, not a modal). A muted left border carries the
 * warning color when risk is elevated; otherwise the card uses the
 * standard elevated surface.
 *
 * Per SPEC §17: "Avoid modal dialogs unless macOS itself requires one
 * or the action is impossible to contextualize inline."
 *
 * Per SPEC §17: "The same approval may produce a subtle sidebar task
 * status, a dynamic inspector section, and a native notification when
 * the app is unfocused." — that orchestration lives in the host app;
 * this component only renders the inline card and resolves the request
 * via `POST /v1/approvals/:id/resolve` (lib/api.ts).
 *
 * Per design constraints: subtle warning color, restrained motion,
 * accessible (keyboard nav, focus states, screen-reader labels).
 */
import { memo, useCallback, useEffect, useState } from "react";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cn } from "../lib/cn";
import { api, ForgeApiError } from "../lib/api";
import type { ApprovalDecision } from "../types";

// ────────────────────────── Risk model ──────────────────────────────────────

export type ApprovalRisk = "low" | "normal" | "high" | "critical";

const RISK_LABEL: Record<ApprovalRisk, string> = {
  low: "Low risk",
  normal: "Normal risk",
  high: "High risk",
  critical: "Critical risk",
};

const RISK_COLOR: Record<ApprovalRisk, string> = {
  low: "var(--color-success)",
  normal: "var(--color-info)",
  high: "var(--color-warning)",
  critical: "var(--color-error)",
};

// ────────────────────────── Props ───────────────────────────────────────────

export interface ApprovalCardProps {
  /** Approval id from the control plane. */
  id: string;
  /** Plain-language action, e.g. "Run database migration". */
  action: string;
  /** Exact command / operation, e.g. "npm run migrate:production". */
  operation?: string;
  /** Why approval is required. */
  reason?: string;
  /** Risk class. Drives the accent color. */
  risk: ApprovalRisk;
  /** Scope: workspace paths, external systems, or "network". */
  scope?: string[];
  /** Affected environment label, e.g. "production" or "local". */
  affectedEnvironment?: string;
  /** Whether the choice can persist for the rest of the task. */
  canPersist: boolean;
  /** Optional timestamp shown as muted metadata. */
  requestedAt?: string;
  /** Optional callback fired after a successful resolve. */
  onResolved?: (decision: ApprovalDecision) => void;
  /** Optional className. */
  className?: string;
}

// ────────────────────────── Component ───────────────────────────────────────

type Resolution = "allow_once" | "allow_for_task" | "deny" | null;

interface DecisionConfig {
  decision: ApprovalDecision;
  label: string;
  icon: typeof Check;
  variant: "primary" | "secondary" | "danger";
}

function ApprovalCardImpl({
  id,
  action,
  operation,
  reason,
  risk,
  scope,
  affectedEnvironment,
  canPersist = true,
  requestedAt,
  onResolved,
  className,
}: ApprovalCardProps): JSX.Element {
  const [resolution, setResolution] = useState<Resolution>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (cfg: DecisionConfig): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.resolveApproval(id, cfg.decision);
        setResolution(cfg.decision === "deny_once" ? "deny" : cfg.decision === "allow_for_task" ? "allow_for_task" : "allow_once");
        onResolved?.(cfg.decision);
      } catch (err) {
        const msg =
          err instanceof ForgeApiError
            ? err.envelope?.message ?? err.message
            : err instanceof Error
              ? err.message
              : "Failed to resolve approval";
        setError(msg);
      } finally {
        setSubmitting(false);
      }
    },
    [id, submitting, onResolved],
  );

  // Esc cancels submission but doesn't auto-deny (per SPEC §17 — Deny is explicit).
  useEffect(() => {
    if (resolution) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && submitting) {
        // Ignore — the request is in-flight.
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolution, submitting]);

  if (resolution) {
    return <ResolvedApprovalCard resolution={resolution} action={action} operation={operation} className={className} />;
  }

  const accent = RISK_COLOR[risk];
  const decisions: DecisionConfig[] = [
    {
      decision: "allow_once",
      label: "Allow once",
      icon: Check,
      variant: "primary",
    },
    ...(canPersist
      ? [
          {
            decision: "allow_for_task" as const,
            label: "Allow for this task",
            icon: ShieldCheck,
            variant: "secondary" as const,
          },
        ]
      : []),
    {
      decision: "deny_once",
      label: "Deny",
      icon: X,
      variant: "danger" as const,
    },
  ];

  return (
    <section
      role="group"
      aria-label={`Approval required: ${action}`}
      className={cn(
        "selectable rounded-md border bg-elevated",
        className,
      )}
      style={{
        borderColor: risk === "low" ? "var(--border-default)" : "color-mix(in srgb, " + accent + " 35%, var(--border-default))",
        borderLeftWidth: 3,
        borderLeftColor: accent,
      }}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div
          aria-hidden
          className="flex flex-shrink-0 items-center justify-center"
          style={{
            width: 24,
            height: 24,
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, " + accent + " 14%, transparent)",
            color: accent,
            marginTop: 2,
          }}
        >
          <ShieldAlert size={14} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 6 }}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col" style={{ gap: 2 }}>
              <span
                className="text-tertiary"
                style={{ fontSize: "var(--font-size-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
              >
                Permission required
              </span>
              <h3
                className="truncate text-primary"
                style={{ fontSize: "var(--font-size-md)", fontWeight: 600 }}
                title={action}
              >
                {action}
              </h3>
            </div>
            <span
              className="font-mono"
              style={{
                fontSize: "var(--font-size-xs)",
                color: accent,
                flexShrink: 0,
                marginTop: 2,
              }}
            >
              {RISK_LABEL[risk]}
            </span>
          </div>

          {operation ? (
            <pre
              className="selectable overflow-x-auto rounded-sm bg-terminal px-2 py-1.5 font-mono text-primary"
              style={{ fontSize: "var(--font-size-sm)", margin: 0 }}
            >
              <code>{operation}</code>
            </pre>
          ) : null}

          {reason ? (
            <p
              className="text-secondary"
              style={{ fontSize: "var(--font-size-sm)", lineHeight: "var(--line-height-relaxed)" }}
            >
              {reason}
            </p>
          ) : null}

          {/* Metadata grid — scope, affected environment, persistence. */}
          {(scope && scope.length > 0) || affectedEnvironment ? (
            <dl
              className="grid"
              style={{
                gridTemplateColumns: "auto 1fr",
                gap: "2px 12px",
                fontSize: "var(--font-size-xs)",
                marginTop: 2,
              }}
            >
              {scope && scope.length > 0 ? (
                <>
                  <dt className="text-tertiary">Scope</dt>
                  <dd className="truncate font-mono text-secondary" title={scope.join(", ")}>
                    {scope.join(", ")}
                  </dd>
                </>
              ) : null}
              {affectedEnvironment ? (
                <>
                  <dt className="text-tertiary">Environment</dt>
                  <dd className="font-mono text-secondary">{affectedEnvironment}</dd>
                </>
              ) : null}
              <dt className="text-tertiary">Persistence</dt>
              <dd className="text-secondary">
                {canPersist ? "Allow for this task persists until the task ends." : "Only allow-once is supported for this operation."}
              </dd>
            </dl>
          ) : null}

          {error ? (
            <p
              className="text-error"
              role="alert"
              style={{ fontSize: "var(--font-size-xs)", marginTop: 2 }}
            >
              {error}
            </p>
          ) : null}

          {/* Action row. */}
          <div
            className="flex flex-wrap items-center"
            style={{ gap: 8, marginTop: 4 }}
          >
            {decisions.map((cfg) => {
              const Icon = cfg.icon;
              const isPrimary = cfg.variant === "primary";
              const isDanger = cfg.variant === "danger";
              return (
                <button
                  key={cfg.decision}
                  type="button"
                  onClick={() => void submit(cfg)}
                  disabled={submitting}
                  aria-label={`${cfg.label} — ${action}`}
                  className="inline-flex items-center gap-1.5 rounded-md disabled:opacity-50"
                  style={{
                    height: 28,
                    padding: "0 10px",
                    fontSize: "var(--font-size-sm)",
                    fontWeight: 500,
                    background: isPrimary
                      ? "var(--color-primary)"
                      : isDanger
                        ? "color-mix(in srgb, var(--color-error) 14%, transparent)"
                        : "var(--bg-hover)",
                    color: isPrimary
                      ? "var(--text-inverse)"
                      : isDanger
                        ? "var(--color-error)"
                        : "var(--text-primary)",
                    border: isPrimary || isDanger ? "none" : "1px solid var(--border-default)",
                    transition: "background var(--duration-fast) var(--easing-default)",
                  }}
                >
                  <Icon size={12} />
                  <span>{cfg.label}</span>
                </button>
              );
            })}
            {requestedAt ? (
              <span
                className="ml-auto font-mono text-tertiary"
                style={{ fontSize: "var(--font-size-xs)" }}
              >
                {requestedAt}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export const ApprovalCard = memo(ApprovalCardImpl);

// ────────────────────────── Resolved view ───────────────────────────────────

function ResolvedApprovalCard({
  resolution,
  action,
  operation,
  className,
}: {
  resolution: Exclude<Resolution, null>;
  action: string;
  operation?: string;
  className?: string;
}): JSX.Element {
  const isAllow = resolution !== "deny";
  const accent = isAllow ? "var(--color-success)" : "var(--color-error)";
  const label =
    resolution === "allow_once"
      ? "Allowed once"
      : resolution === "allow_for_task"
        ? "Allowed for this task"
        : "Denied";
  const Icon = isAllow ? Check : X;

  return (
    <section
      aria-label={`Approval ${label.toLowerCase()}: ${action}`}
      className={cn("rounded-md border bg-elevated", className)}
      style={{
        borderColor: "var(--border-subtle)",
        borderLeftWidth: 3,
        borderLeftColor: accent,
        opacity: 0.9,
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div
          aria-hidden
          className="flex flex-shrink-0 items-center justify-center"
          style={{ width: 20, height: 20, color: accent }}
        >
          <Icon size={13} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="font-mono"
            style={{
              fontSize: "var(--font-size-xs)",
              color: accent,
              fontWeight: 600,
            }}
          >
            {label}
          </span>
          <span
            className="truncate text-secondary"
            style={{ fontSize: "var(--font-size-sm)" }}
            title={action}
          >
            {action}
          </span>
          {operation ? (
            <code
              className="truncate font-mono text-tertiary"
              style={{ fontSize: "var(--font-size-xs)" }}
              title={operation}
            >
              {operation}
            </code>
          ) : null}
        </div>
      </div>
    </section>
  );
}
