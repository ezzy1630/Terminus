import { describe, expect, test } from "bun:test";
import {
  LspClient,
  LspServerRegistry,
  findWorkspaceRoot,
  type LspTransport,
} from "./index.js";

class InMemoryLspTransport implements LspTransport {
  private listener: ((msg: string) => void) | null = null;
  public sent: string[] = [];

  async send(payload: string): Promise<void> {
    this.sent.push(payload);
    const req = JSON.parse(payload) as { id?: number; method: string; params: any };
    if (req.id !== undefined) {
      // Mock immediate response
      if (req.method === "initialize") {
        this.receive({
          jsonrpc: "2.0",
          id: req.id,
          result: { capabilities: { hoverProvider: true, definitionProvider: true } },
        });
      } else if (req.method === "textDocument/hover") {
        this.receive({
          jsonrpc: "2.0",
          id: req.id,
          result: { contents: "function hello(): void" },
        });
      } else if (req.method === "shutdown") {
        this.receive({ jsonrpc: "2.0", id: req.id, result: null });
      }
    }
  }

  onMessage(callback: (msg: string) => void): void {
    this.listener = callback;
  }

  receive(msg: object): void {
    if (this.listener) {
      this.listener(JSON.stringify(msg));
    }
  }

  async close(): Promise<void> {
    this.listener = null;
  }
}

describe("LspClient", () => {
  test("initializes and performs hover request", async () => {
    const transport = new InMemoryLspTransport();
    const client = new LspClient(transport);

    const initResult = await client.initialize("file:///workspace");
    expect(client.ready).toBe(true);
    expect(initResult.capabilities).toBeDefined();

    const hover = await client.hover("file:///workspace/src/index.ts", { line: 10, character: 5 });
    expect(hover?.contents).toBe("function hello(): void");

    await client.shutdown();
    expect(client.ready).toBe(false);
  });

  test("receives published diagnostics", async () => {
    const transport = new InMemoryLspTransport();
    const client = new LspClient(transport);

    let receivedUri = "";
    let receivedCount = 0;
    client.onDiagnostics((uri, diagnostics) => {
      receivedUri = uri;
      receivedCount = diagnostics.length;
    });

    transport.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///workspace/src/app.ts",
        diagnostics: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            message: "Unused variable",
          },
        ],
      },
    });

    expect(receivedUri).toBe("file:///workspace/src/app.ts");
    expect(receivedCount).toBe(1);
  });
});

describe("LspServerRegistry & findWorkspaceRoot", () => {
  test("finds server for language", () => {
    const registry = new LspServerRegistry();
    const tsServer = registry.findForLanguage("typescript");
    expect(tsServer?.binary).toBe("typescript-language-server");

    const rustServer = registry.findForLanguage("rust");
    expect(rustServer?.binary).toBe("rust-analyzer");
  });

  test("findWorkspaceRoot identifies ancestor marker", () => {
    const existing = new Set(["/workspace/Cargo.toml", "/workspace/src/main.rs"]);
    const root = findWorkspaceRoot(
      "/workspace/src/sub/deep",
      ["Cargo.toml", "package.json"],
      (p) => existing.has(p),
    );
    expect(root).toBe("/workspace");
  });
});
