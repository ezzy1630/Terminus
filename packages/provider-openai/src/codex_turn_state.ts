/** Response header carrying the opaque per-turn state to echo back. */
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
/** Response header carrying the models-catalogue change token. */
export const CODEX_MODELS_ETAG_HEADER = "x-models-etag";

/**
 * Per-turn continuity returned by the ChatGPT Codex endpoint.
 *
 * This lives outside the renderer module so package consumers can construct
 * it without traversing the renderer's intentional import of `index.ts`.
 */
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

  get turnStateToken(): string | null {
    return this.turnState;
  }

  get modelsCatalogEtag(): string | null {
    return this.modelsEtag;
  }
}
