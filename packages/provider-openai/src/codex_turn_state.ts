/**
 * Opaque continuity state for an external Codex adapter.
 *
 * Terminus does not use this state for its provider transport. It remains a
 * small neutral container so a future App Server adapter can keep external
 * protocol state out of the core provider renderer.
 */
export class CodexTurnState {
  private turnState: string | null = null;
  private modelsEtag: string | null = null;

  observe(headers: Readonly<Record<string, string>> | null | undefined): void {
    if (headers === null || headers === undefined) return;
    const turnState = headers["x-codex-turn-state"];
    if (typeof turnState === "string" && turnState !== "") this.turnState = turnState;
    const modelsEtag = headers["x-models-etag"];
    if (typeof modelsEtag === "string" && modelsEtag !== "") this.modelsEtag = modelsEtag;
  }

  requestHeaders(): Readonly<Record<string, string>> {
    return this.turnState === null ? {} : { "x-codex-turn-state": this.turnState };
  }

  get turnStateToken(): string | null { return this.turnState; }
  get modelsCatalogEtag(): string | null { return this.modelsEtag; }
}

/** Header projection reserved for a future external Codex adapter. */
export function chatGptCodexRequestHeaders(input: {
  readonly originator: string;
  readonly userAgent: string;
  readonly accountId?: string | null;
  readonly sessionId?: string | null;
  readonly threadId?: string | null;
  readonly turnState?: CodexTurnState | null;
}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    originator: input.originator,
    "user-agent": input.userAgent,
  };
  if (input.accountId) result["chatgpt-account-id"] = input.accountId;
  if (input.sessionId) result["session-id"] = input.sessionId;
  if (input.threadId) {
    result["thread-id"] = input.threadId;
    result["x-client-request-id"] = input.threadId;
  }
  Object.assign(result, input.turnState?.requestHeaders() ?? {});
  return result;
}
