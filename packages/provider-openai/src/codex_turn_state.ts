/** Response header carrying the opaque per-turn state to echo back. */
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
/** Response header carrying the models-catalogue change token. */
export const CODEX_MODELS_ETAG_HEADER = "x-models-etag";

/** Opaque continuity state returned by the ChatGPT Codex endpoint. */
export class CodexTurnState {
  private turnState: string | null = null;
  private modelsEtag: string | null = null;

  observe(headers: Readonly<Record<string, string>> | null | undefined): void {
    if (headers === null || headers === undefined) return;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string" || value === "") continue;
      const key = name.toLowerCase();
      if (key === CODEX_TURN_STATE_HEADER) this.turnState = value;
      else if (key === CODEX_MODELS_ETAG_HEADER) this.modelsEtag = value;
    }
  }

  requestHeaders(): Readonly<Record<string, string>> {
    return this.turnState === null ? {} : { [CODEX_TURN_STATE_HEADER]: this.turnState };
  }

  get turnStateToken(): string | null { return this.turnState; }
  get modelsCatalogEtag(): string | null { return this.modelsEtag; }
}

/** Honest, non-credential identity and continuity headers for Codex requests. */
export function chatGptCodexRequestHeaders(input: {
  readonly originator: string;
  readonly userAgent: string;
  readonly accountId?: string | null;
  readonly sessionId?: string | null;
  readonly threadId?: string | null;
  readonly turnState?: CodexTurnState | null;
}): Readonly<Record<string, string>> {
  const nonEmpty = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const accountId = nonEmpty(input.accountId);
  const sessionId = nonEmpty(input.sessionId);
  const threadId = nonEmpty(input.threadId);
  const result: Record<string, string> = {
    originator: input.originator,
    "user-agent": input.userAgent,
  };
  if (accountId !== null) result["chatgpt-account-id"] = accountId;
  if (sessionId !== null) result["session-id"] = sessionId;
  if (threadId !== null) {
    result["thread-id"] = threadId;
    result["x-client-request-id"] = threadId;
  }
  Object.assign(result, input.turnState?.requestHeaders() ?? {});
  return result;
}
