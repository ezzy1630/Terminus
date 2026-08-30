/**
 * Terminus Desktop — "we found your credentials" notice.
 *
 * The control plane imports every usable credential from the operator's own
 * stores at startup, silently and without a prompt. Silence is right for the
 * import; it is wrong for the *fact* of it. An app that quietly acquires seven
 * provider accounts on first launch owes the operator one sentence saying so
 * and a way to see what it took.
 *
 * So: one hairline strip under the title bar, in the same calm register as the
 * connection banner. Not a modal, not a toast queue, not a card. It states the
 * count and where the credentials came from, offers Settings, and is
 * dismissable.
 *
 * Dismissal is keyed on the *set* of account ids, not on a boolean. A flag
 * would silence the notice for every future import too, so signing in to Codex
 * next week would add an account with no announcement at all. A new set is a
 * new fact and says itself once.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useProviderAccounts } from "../hooks/use-provider-accounts";
import type { ProviderAccount } from "../types";
import { Button } from "../ui/Button";

const NOTICE_KEY = "terminus-desktop.provider-accounts.notice.v1";
/**
 * Bounded so a control plane reporting an implausible number of accounts
 * cannot grow the stored value without limit. Beyond this the notice simply
 * stops tracking the set, which shows it once more rather than never.
 */
const MAX_TRACKED_ACCOUNTS = 64;

/** A stable identity for one set of accounts, order-independent. */
export function noticeKeyFor(accounts: readonly ProviderAccount[]): string {
  const ids = accounts.map((account) => account.id).sort();
  return ids.length > MAX_TRACKED_ACCOUNTS ? "" : ids.join(",");
}

/** "a", "a and b", "a, b and c". */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]!}`;
}

/**
 * "Connected 8 providers: 6 from OpenCode, your ChatGPT login and OpenCode Zen."
 *
 * The total leads and each source carries its own count. Writing it as
 * "Connected 8 providers from OpenCode, your ChatGPT login and …" attached the
 * total to the first source named, so eight accounts across three stores read
 * as eight from one of them.
 *
 * A source contributing nothing is not mentioned, and the count is of accounts
 * that can currently take a turn — an expired or unsupported credential is not
 * something that was "connected", whatever its row says.
 */
export function describeImport(accounts: readonly ProviderAccount[]): string | null {
  const connected = accounts.filter((account) => account.status === "connected");
  if (connected.length === 0) return null;
  const total = connected.length;
  const noun = total === 1 ? "provider" : "providers";
  const countFor = (predicate: (account: ProviderAccount) => boolean): number =>
    connected.filter(predicate).length;

  // `label` is the phrasing after "from"; `counted` is the phrasing in a list
  // that already stated the total. Only the vendor-key store can hold more
  // than one account, so it is the only clause that carries a figure.
  const clauses: Array<{ label: string; counted: string; count: number }> = [];
  const vendorKeys = countFor((account) => account.source.startsWith("opencode:"));
  if (vendorKeys > 0) {
    clauses.push({ label: "OpenCode", counted: `${vendorKeys} from OpenCode`, count: vendorKeys });
  }
  const chatgpt = countFor((account) => account.source === "codex-chatgpt");
  if (chatgpt > 0) {
    clauses.push({ label: "your ChatGPT login", counted: "your ChatGPT login", count: chatgpt });
  }
  const zen = countFor((account) => account.source === "zen");
  if (zen > 0) {
    clauses.push({ label: "OpenCode Zen", counted: "OpenCode Zen", count: zen });
  }

  if (clauses.length === 0) return `Connected ${total} ${noun}.`;
  // One source that accounts for everything needs no breakdown — repeating the
  // figure ("6 providers — 6 from OpenCode") says it twice.
  const only = clauses[0]!;
  if (clauses.length === 1 && only.count === total) {
    return `Connected ${total} ${noun} from ${only.label}.`;
  }
  return `Connected ${total} ${noun}: ${joinClauses(clauses.map((clause) => clause.counted))}.`;
}

function readAnnounced(): string | null {
  try { return window.localStorage.getItem(NOTICE_KEY); } catch { return null; }
}

function writeAnnounced(key: string): void {
  try { window.localStorage.setItem(NOTICE_KEY, key); } catch {}
}

function ProviderAccountsNoticeImpl(): JSX.Element | null {
  const { accounts, status, supported } = useProviderAccounts();
  // Read once per mount: the value only ever changes through this component,
  // and re-reading storage on every render would make the strip flicker while
  // the list loads.
  const [announced, setAnnounced] = useState<string | null>(() => readAnnounced());

  const key = useMemo(() => noticeKeyFor(accounts), [accounts]);
  const sentence = useMemo(() => describeImport(accounts), [accounts]);

  const dismiss = useCallback((): void => {
    if (key.length > 0) writeAnnounced(key);
    setAnnounced(key);
  }, [key]);

  const openSettings = useCallback((): void => {
    dismiss();
    window.dispatchEvent(new CustomEvent("terminus:open-settings", { detail: { category: "agents" } }));
  }, [dismiss]);

  if (status !== "ready" || !supported || sentence === null) return null;
  if (key.length > 0 && announced === key) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Connected provider accounts"
      data-testid="provider-accounts-notice"
      className="flex h-7 flex-shrink-0 items-center gap-2 border-b border-subtle bg-canvas px-4 text-xs"
    >
      <span className="min-w-0 flex-1 truncate text-secondary">{sentence}</span>
      <Button size="sm" variant="ghost" onClick={openSettings} className="flex-none">
        Open settings
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex-none px-1"
      >
        <X size={11} aria-hidden />
      </Button>
    </div>
  );
}

export const ProviderAccountsNotice = memo(ProviderAccountsNoticeImpl);
