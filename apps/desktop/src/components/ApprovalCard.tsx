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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cn } from "../lib/cn";
import { api, TerminusApiError } from "../lib/api";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import type { ApprovalDecision } from "../types";
import { Button } from "../ui/Button";

// ────────────────────────── Risk model ──────────────────────────────────────

export type ApprovalRisk = "low" | "normal" | "high" | "critical" | "unknown";

const RISK_LABEL: Record<ApprovalRisk, string> = {
  low: "Low risk",
  normal: "Normal risk",
  high: "High risk",
  critical: "Critical risk",
  unknown: "Risk unknown",
};

const RISK_COLOR: Record<ApprovalRisk, string> = {
  low: "var(--color-success)",
  normal: "var(--color-info)",
  high: "var(--color-warning)",
  critical: "var(--color-error)",
  unknown: "var(--color-warning)",
};

// ────────────────────────── Props ───────────────────────────────────────────

export interface ApprovalCardProps {
  /** Approval id from the control plane. */
  id: string;
  /** Plain-language action, e.g. "Run database migration". */
  action: string;
  /** Exact immutable operation hash carried by the authoritative snapshot. */
  operationHash: string;
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
  /** Decisions the authoritative coordinator can actually settle. */
  supportedDecisions?: ApprovalDecision[];
  /** True only when server identity and exact event context bind to one operation hash. */
  authorizationReady?: boolean;
  /** False when the pending approval snapshot has not been reconciled. */
  decisionsEnabled?: boolean;
  /** Optional timestamp shown as muted metadata. */
  requestedAt?: string;
  /** Server-bound expiry. An elapsed approval cannot be submitted. */
  expiresAt?: string;
  /** Optional callback fired after a successful resolve. */
  onResolved?: (decision: ApprovalDecision) => void;
  /** Reconcile the parent resource when the local expiry boundary passes. */
  onExpired?: () => void;
  /** Optional className. */
  className?: string;
}

// ────────────────────────── Component ───────────────────────────────────────

type Resolution = ApprovalDecision | null;

interface DecisionConfig {
  decision: ApprovalDecision;
  label: string;
  icon: typeof Check;
  variant: "primary" | "secondary" | "danger";
  available: boolean;
  unavailableReason?: string;
}

function approvalWasAlreadyResolved(error: unknown): boolean {
  if (!(error instanceof TerminusApiError) || error.status !== 409) return false;
  if (error.envelope?.retryable !== false) return false;
  return new Set(["APPROVAL_ALREADY_RESOLVED", "APPROVAL_NOT_PENDING", "APPROVAL_NOT_FOUND"]).has(error.envelope.code);
}

function approvalHasExpired(expiresAt: string | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

function ApprovalCardImpl({
  id,
  action,
  operationHash,
  operation,
  reason,
  risk,
  scope,
  affectedEnvironment,
  canPersist = false,
  supportedDecisions = ["deny_once"],
  authorizationReady = false,
  decisionsEnabled = true,
  requestedAt,
  expiresAt,
  onResolved,
  onExpired,
  className,
}: ApprovalCardProps): JSX.Element {
  const [resolution, setResolution] = useState<Resolution>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(() => approvalHasExpired(expiresAt));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const expiryNotificationRef = useRef<string | null>(null);
  const approvalMutation = useLogicalMutation(`approval.${id}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let notified = false;
    const updateExpiry = (): void => {
      const nextExpired = approvalHasExpired(expiresAt);
      setExpired(nextExpired);
      if (nextExpired) {
        const expiryIdentity = expiresAt ?? "invalid-expiry";
        if (!notified && expiryNotificationRef.current !== expiryIdentity) {
          expiryNotificationRef.current = expiryIdentity;
          onExpired?.();
        }
        notified = true;
        return;
      }
      if (!expiresAt) return;
      const remaining = Math.max(1, Date.parse(expiresAt) - Date.now() + 1);
      timer = setTimeout(updateExpiry, Math.min(remaining, 2_147_483_647));
    };
    updateExpiry();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [expiresAt, onExpired]);

  const submit = useCallback(
    async (cfg: DecisionConfig): Promise<void> => {
      if (submitting || !decisionsEnabled) return;
      if (approvalHasExpired(expiresAt)) {
        setExpired(true);
        setError("This approval expired. Refresh pending approvals before making a decision.");
        onExpired?.();
        return;
      }
      setSubmitting(true);
      setError(null);
      let operationKey: string | null = null;
      try {
        operationKey = approvalMutation.keyFor(JSON.stringify({ id, decision: cfg.decision }));
        await api.resolveApproval(id, operationHash, cfg.decision, { idempotencyKey: operationKey });
        approvalMutation.settle(operationKey);
        setResolution(cfg.decision);
        onResolved?.(cfg.decision);
      } catch (err) {
        if (operationKey && isDefinitiveMutationFailure(err)) {
          approvalMutation.abandon(operationKey);
          // A non-retryable conflict means another actor already changed the
          // approval. Let the parent reconcile its pending list immediately.
          if (approvalWasAlreadyResolved(err)) onResolved?.(cfg.decision);
        }
        const msg =
          err instanceof TerminusApiError
            ? err.envelope?.message ?? err.message
            : err instanceof Error
              ? err.message
              : "Failed to resolve approval";
        setError(msg);
      } finally {
        setSubmitting(false);
      }
    },
    [approvalMutation, decisionsEnabled, expiresAt, id, onExpired, operationHash, submitting, onResolved],
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
  const effectiveDecisionsEnabled = decisionsEnabled && !expired;
  const allowAuthorizationReady = authorizationReady && !expired;
  const supported = new Set(supportedDecisions);
  const decisions: DecisionConfig[] = [
    {
      decision: "allow_once",
      label: "Allow once",
      icon: Check,
      variant: "primary",
      available: allowAuthorizationReady && supported.has("allow_once"),
      unavailableReason: expired ? "This approval expired." : authorizationReady ? "The coordinator does not support this decision." : "The exact operation binding is not ready.",
    },
    {
      decision: "allow_for_action",
      label: "Allow exact action",
      icon: ShieldCheck,
      variant: "secondary",
      available: allowAuthorizationReady && supported.has("allow_for_action"),
      unavailableReason: expired ? "This approval expired." : authorizationReady ? "The coordinator does not support this decision." : "The exact operation binding is not ready.",
    },
    {
      decision: "allow_for_task",
      label: "Allow for this task",
      icon: ShieldCheck,
      variant: "secondary",
      available: allowAuthorizationReady && canPersist && supported.has("allow_for_task"),
      unavailableReason: !canPersist
        ? "This approval is bounded to one use."
        : expired ? "This approval expired." : authorizationReady ? "The coordinator does not support this decision." : "The exact operation binding is not ready.",
    },
    {
      decision: "deny_once",
      label: "Deny once",
      icon: X,
      variant: "danger",
      available: supported.has("deny_once"),
    },
    {
      decision: "deny_and_add_task_rule",
      label: "Deny and add task rule",
      icon: ShieldAlert,
      variant: "danger",
      available: supported.has("deny_and_add_task_rule"),
      unavailableReason: "The task policy-rule coordinator is unavailable.",
    },
    {
      decision: "stop_task",
      label: "Stop task",
      icon: X,
      variant: "danger",
      available: supported.has("stop_task"),
      unavailableReason: "The kernel-backed task cancellation coordinator is unavailable.",
    },
  ];
  const visibleDecisions = decisions.filter((decision) => supported.has(decision.decision));
  const recommendedDecision = visibleDecisions.find((decision) => decision.decision === "allow_once")
    ?? visibleDecisions.find((decision) => decision.variant !== "danger")
    ?? visibleDecisions[0];
  const denyDecision = visibleDecisions.find((decision) => decision.decision === "deny_once" && decision !== recommendedDecision);
  const secondaryDecisions = visibleDecisions.filter((decision) => decision !== recommendedDecision && decision !== denyDecision);
  const renderDecision = (cfg: DecisionConfig): JSX.Element => {
    const Icon = cfg.icon;
    const isPrimary = cfg === recommendedDecision && cfg.variant !== "danger";
    const isDanger = cfg.variant === "danger";
    return (
      <Button
        key={cfg.decision}
        type="button"
        onClick={() => void submit(cfg)}
        disabled={submitting || !effectiveDecisionsEnabled || !cfg.available}
        aria-label={`${cfg.label}${cfg.available ? "" : " (unavailable)"} — ${action}`}
        data-tooltip={cfg.available ? cfg.label : cfg.unavailableReason}
        variant={isPrimary ? "primary" : "secondary"}
        size="md"
        leading={<Icon size={12} aria-hidden />}
        className={cn(isDanger && "text-error")}
      >
        {cfg.label}
      </Button>
    );
  };

  return (
    <section
      role="group"
      aria-label={`Approval required: ${action}`}
      className={cn("selectable border-y border-subtle bg-transparent", className)}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: accent,
      }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <ShieldAlert size={14} aria-hidden className="mt-0.5 flex-none" style={{ color: accent }} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="ui-meta">
                Permission required
              </span>
              <h3 className="ui-label truncate text-primary" data-tooltip={action}>
                {action}
              </h3>
            </div>
            <span
              className="ui-meta flex-none"
              style={{ color: accent, flexShrink: 0, marginTop: 2 }}
            >
              {RISK_LABEL[risk]}
            </span>
          </div>

          {operation ? (
            <pre
              className="selectable overflow-x-auto border-l border-subtle bg-terminal px-2 py-1.5 font-mono text-xs leading-5 text-primary"
              style={{ margin: 0 }}
            >
              <code>{operation}</code>
            </pre>
          ) : null}

          {reason ? (
            <p className="ui-body text-secondary">
              {reason}
            </p>
          ) : null}

          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
              trailing={<ChevronDown size={12} className={cn("transition-transform", detailsOpen && "rotate-180")} aria-hidden />}
              className="-ml-2 text-tertiary"
            >
              Details
            </Button>
            {detailsOpen ? (
              <dl className="surface-enter mt-1 grid border-t border-subtle pt-1.5 text-xs" style={{ gridTemplateColumns: "auto 1fr", gap: "3px 12px" }}>
                {scope && scope.length > 0 ? (
                  <>
                    <dt className="text-tertiary">Scope</dt>
                    <dd className="truncate font-mono text-secondary" data-tooltip={scope.join(", ")}>{scope.join(", ")}</dd>
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
                  {canPersist ? "Task-scoped decisions may be available." : "This decision applies once."}
                </dd>
              </dl>
            ) : null}
          </div>

          {!authorizationReady ? (
            <p
              role="status"
              className="border-l-2 border-default px-2 py-1 text-secondary text-xs"
            >
              Allow actions are disabled until the exact operation, scope, and recognized risk are bound to the server approval hash. Deny remains available.
            </p>
          ) : null}

          {!decisionsEnabled ? (
            <p role="status" className="border-l-2 border-warning px-2 py-1 text-warning text-xs">
              Decisions are disabled until pending state is reconciled with the control plane.
            </p>
          ) : null}

          {expired ? (
            <p role="alert" className="border-l-2 border-warning px-2 py-1 text-warning text-xs">
              This approval expired. Decisions are disabled while Terminus reconciles pending state.
            </p>
          ) : null}

          {detailsOpen && visibleDecisions.length < decisions.length ? (
            <p role="note" className="text-tertiary text-xs" >
              Unsupported choices are hidden. Coordinator-backed choices: {visibleDecisions.map((decision) => decision.label).join(", ") || "none"}.
            </p>
          ) : null}

          {error ? (
            <p
              className="text-error text-xs"
              role="alert"
              style={{ marginTop: 2 }}
            >
              {error}
            </p>
          ) : null}

          {/* Action row. */}
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-subtle pt-2">
            {recommendedDecision ? renderDecision(recommendedDecision) : null}
            {denyDecision ? renderDecision(denyDecision) : null}
            {secondaryDecisions.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                trailing={<ChevronDown size={12} className={cn("transition-transform", moreOpen && "rotate-180")} aria-hidden />}
              >
                More
              </Button>
            ) : null}
            {requestedAt ? (
              <span
                className="ml-auto font-mono text-tertiary text-xs"

              >
                {requestedAt}
              </span>
            ) : null}
          </div>
          {moreOpen && secondaryDecisions.length > 0 ? (
            <div className="surface-enter flex flex-wrap gap-2 border-t border-subtle pt-2">
              {secondaryDecisions.map(renderDecision)}
            </div>
          ) : null}
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
  const isAllow = resolution.startsWith("allow_");
  const accent = isAllow ? "var(--color-success)" : "var(--color-error)";
  const labels: Record<Exclude<Resolution, null>, string> = {
    allow_once: "Allowed once",
    allow_for_action: "Allowed exact action",
    allow_for_task: "Allowed for this task",
    deny_once: "Denied once",
    deny_and_add_task_rule: "Denied and added task rule",
    stop_task: "Stopped task",
  };
  const label = labels[resolution];
  const Icon = isAllow ? Check : X;

  return (
    <section
      aria-label={`Approval ${label.toLowerCase()}: ${action}`}
      className={cn("border-b border-subtle bg-transparent", className)}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: accent,
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
            className="ui-meta"
            style={{ color: accent }}
          >
            {label}
          </span>
          <span
            className="ui-label truncate text-secondary"

            data-tooltip={action}
          >
            {action}
          </span>
          {operation ? (
            <code
              className="truncate font-mono text-tertiary text-xs"

              data-tooltip={operation}
            >
              {operation}
            </code>
          ) : null}
        </div>
      </div>
    </section>
  );
}
