/**
 * Terminus Desktop — Connected accounts.
 *
 * The first group under "Agents and Models", above the forms that still take a
 * key by hand. It is deliberately a *report*, not a form: these accounts came
 * from credential stores the operator's own tools already keep, so there is
 * nothing here to type. Two actions exist per row — make it the default, and
 * disconnect it — and both round-trip through the control plane with the
 * revision the row was drawn from.
 *
 * Written in the same System Settings language as the rest of the pane: a
 * sentence-case heading, then a hairline-closed run of rows, label left and
 * controls right. No cards, no provider logos — Terminus ships no third-party
 * artwork, so each account is marked with two letters derived from its name.
 *
 * Honesty rules this surface keeps:
 *
 *   - An account Terminus cannot route to is *listed*, with the reason. Hiding
 *     it makes its missing models look like a Terminus bug.
 *   - Disconnect asks once, inline. It deletes a credential from the keyring,
 *     which this app cannot undo, but it is not important enough to seize the
 *     window with a modal.
 *   - "Codex CLI not installed" is stated only when discovery said so. Nothing
 *     here guesses at what is on the machine.
 */
import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "../lib/cn";
import {
  ACCOUNT_STATUS_LABELS,
  accountSourceLabel,
  discoveryHints,
  useProviderAccounts,
} from "../hooks/use-provider-accounts";
import { deriveMark } from "../hooks/use-model-inventory";
import type { ProviderAccount } from "../types";
import { Button } from "../ui/Button";

/** Colour carries meaning only: a caution is orange, a failure is red. */
function statusToneClass(status: ProviderAccount["status"]): string {
  switch (status) {
    case "connected": return "text-secondary";
    case "expired": return "text-warning";
    case "error": return "text-error";
    default: return "text-tertiary";
  }
}

/** `2026-09-07T…` → `7 Sep 2026`. Null when there is no date to state. */
function formatDate(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function AccountMark({ label, dimmed }: { label: string; dimmed: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-subtle bg-elevated text-xs font-semibold tracking-tight",
        dimmed ? "text-tertiary" : "text-secondary",
      )}
    >
      {deriveMark(label, label)}
    </span>
  );
}

function AccountRow({
  account,
  busy,
  onSetDefault,
  onDisconnect,
}: {
  account: ProviderAccount;
  busy: boolean;
  onSetDefault: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const expires = formatDate(account.expires_at);
  const connected = account.status === "connected";
  // One line of quiet meta: where the credential lives, how many models it
  // reaches, when it stops working. Each clause is dropped when unknown rather
  // than rendered as "0 models" or "expires —".
  const meta = [
    accountSourceLabel(account.source),
    `${account.model_count} model${account.model_count === 1 ? "" : "s"}`,
    expires ? `Expires ${expires}` : null,
    account.metadata.plan_type ?? null,
  ].filter((clause): clause is string => clause !== null).join(" · ");

  return (
    <div className="flex min-h-12 items-start gap-3 py-2" data-testid={`provider-account-${account.id}`}>
      <AccountMark label={account.display_name} dimmed={!connected} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="ui-body truncate text-primary">{account.display_name}</span>
          {account.is_default ? (
            <span className="ui-meta shrink-0 rounded border border-subtle px-1 text-tertiary">Default</span>
          ) : null}
          <span className={cn("ui-meta shrink-0", statusToneClass(account.status))}>
            {ACCOUNT_STATUS_LABELS[account.status]}
          </span>
        </span>
        <p className="ui-meta truncate">{meta}</p>
        {account.status_detail ? (
          <p className={cn("ui-meta", account.status === "error" ? "text-error" : undefined)}>
            {account.status_detail}
          </p>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {confirming ? (
          <>
            <span className="ui-meta">Delete this credential?</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              aria-label={`Confirm disconnect ${account.display_name}`}
              onClick={() => { setConfirming(false); onDisconnect(); }}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <>
            {/* Offered only where it would do something: an expired or
                unsupported account cannot take a turn, so making it the
                default would be a button whose only outcome is a 409. */}
            {connected && !account.is_default ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Set ${account.display_name} as the default account`}
                onClick={onSetDefault}
              >
                Set default
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`Disconnect ${account.display_name}`}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function ProviderAccountSettings(): JSX.Element {
  const accounts = useProviderAccounts();
  const { detect } = accounts;
  const hints = accounts.supported ? discoveryHints(accounts.discovery, accounts.accounts) : [];
  const onDetect = useCallback((): void => { void detect(); }, [detect]);

  return (
    <section className="mb-6" aria-label="Connected accounts">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 className="text-sm text-tertiary">Connected accounts</h2>
        {/* Not offered against a control plane with no such route: the sweep
            would answer 404 and the button would only ever produce an error. */}
        {accounts.supported ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDetect}
            disabled={accounts.detecting || accounts.status === "loading"}
            leading={<RefreshCw size={11} aria-hidden />}
          >
            {accounts.detecting ? "Detecting…" : "Detect again"}
          </Button>
        ) : null}
      </div>

      <div className="divide-y divide-[var(--border-subtle)] border-y border-subtle">
        {accounts.status === "loading" ? (
          <p className="ui-meta py-3">Reading your credential stores…</p>
        ) : accounts.accounts.length === 0 ? (
          <p className="ui-meta py-3">
            {accounts.supported
              ? "No credentials were found. Terminus reads the stores your own tools keep — it never asks for a key here."
              : "This build of the control plane does not report connected accounts."}
          </p>
        ) : (
          accounts.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              busy={accounts.busyId === account.id}
              onSetDefault={() => { void accounts.setDefault(account); }}
              onDisconnect={() => { void accounts.disconnect(account); }}
            />
          ))
        )}

        {/* Everything below is what discovery *said*, kept under the same run
            of hairlines so it reads as part of the report rather than as
            free-floating advice. */}
        {accounts.error ? (
          <p className="py-2 text-xs text-error" role="alert">{accounts.error}</p>
        ) : null}
        {/* A sweep that changed nothing has to say so, or Detect again reads
            as a button that does nothing. */}
        {accounts.lastSweep && !accounts.detecting ? (
          <p className="ui-meta py-2" role="status">
            {accounts.lastSweep.imported.length > 0
              ? `Imported ${accounts.lastSweep.imported.length} account${accounts.lastSweep.imported.length === 1 ? "" : "s"}.`
              : "No new credentials were found."}
          </p>
        ) : null}
        {accounts.discovery.warnings.map((warning) => (
          <p key={warning} className="py-2 text-xs text-warning">{warning}</p>
        ))}
        {hints.map((hint) => (
          <p key={hint} className="ui-meta py-2">{hint}</p>
        ))}
      </div>
    </section>
  );
}
