/**
 * @terminus/lsp — JSON-RPC 2.0 Language Server Protocol client (ADR-0051).
 */
import { z } from "zod";

export interface LspTransport {
  send(payload: string): Promise<void>;
  onMessage(callback: (payload: string) => void): void;
  close(): Promise<void>;
}

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface Hover {
  readonly contents: string | { language: string; value: string };
  readonly range?: Range;
}

export interface DocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: DocumentSymbol[];
}

export interface LspDiagnostic {
  readonly range: Range;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export class LspClient {
  private nextId = 1;
  private readonly pendingRequests = new Map<
    number | string,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly diagnosticListeners = new Set<
    (uri: string, diagnostics: readonly LspDiagnostic[]) => void
  >();
  private isInitialized = false;

  constructor(private readonly transport: LspTransport) {
    this.transport.onMessage((raw) => this.handleMessage(raw));
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;

    // Response to a request
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number | string);
      if (pending) {
        this.pendingRequests.delete(msg.id as number | string);
        if ("error" in msg && msg.error) {
          const err = msg.error as { code?: number; message?: string };
          pending.reject(new Error(err.message ?? "LSP request failed"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server notification
    if ("method" in msg && typeof msg.method === "string") {
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
        if (params?.uri && Array.isArray(params.diagnostics)) {
          for (const listener of this.diagnosticListeners) {
            listener(params.uri, params.diagnostics);
          }
        }
      }
    }
  }

  async sendRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.transport.send(payload).catch((err) => {
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async sendNotification(method: string, params: unknown): Promise<void> {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    await this.transport.send(payload);
  }

  async initialize(rootUri: string, clientName = "terminus-lsp"): Promise<Record<string, unknown>> {
    const result = await this.sendRequest<Record<string, unknown>>("initialize", {
      processId: null,
      rootUri,
      clientInfo: { name: clientName, version: "0.1.0" },
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        },
      },
    });
    await this.sendNotification("initialized", {});
    this.isInitialized = true;
    return result;
  }

  async didOpen(uri: string, languageId: string, text: string, version = 1): Promise<void> {
    await this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  async didChange(uri: string, text: string, version: number): Promise<void> {
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async didClose(uri: string): Promise<void> {
    await this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async definition(uri: string, position: Position): Promise<Location | Location[] | null> {
    return this.sendRequest<Location | Location[] | null>("textDocument/definition", {
      textDocument: { uri },
      position,
    });
  }

  async references(uri: string, position: Position, includeDeclaration = true): Promise<Location[] | null> {
    return this.sendRequest<Location[] | null>("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    return this.sendRequest<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
  }

  async documentSymbol(uri: string): Promise<DocumentSymbol[] | null> {
    return this.sendRequest<DocumentSymbol[] | null>("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  async shutdown(): Promise<void> {
    await this.sendRequest("shutdown", null);
    await this.sendNotification("exit", null);
    await this.transport.close();
    this.isInitialized = false;
  }

  onDiagnostics(listener: (uri: string, diagnostics: readonly LspDiagnostic[]) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  get ready(): boolean {
    return this.isInitialized;
  }
}
