/**
 * @terminus/lsp — Server Registry & Root Discovery (ADR-0051).
 */
import { z } from "zod";

export const lspServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  languages: z.array(z.string().min(1)),
  binary: z.string().min(1),
  args: z.array(z.string()),
  rootMarkers: z.array(z.string().min(1)),
  initializationOptions: z.record(z.string(), z.unknown()).optional(),
});

export type LspServerConfig = z.infer<typeof lspServerConfigSchema>;

export const DEFAULT_LSP_SERVERS: readonly LspServerConfig[] = [
  {
    id: "typescript",
    name: "TypeScript / JavaScript Language Server",
    languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    binary: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  {
    id: "python-pyright",
    name: "Pyright Language Server",
    languages: ["python"],
    binary: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
  },
  {
    id: "rust-analyzer",
    name: "Rust Analyzer",
    languages: ["rust"],
    binary: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml", "Cargo.lock"],
  },
  {
    id: "gopls",
    name: "Go Language Server (gopls)",
    languages: ["go"],
    binary: "gopls",
    args: [],
    rootMarkers: ["go.mod", "go.work"],
  },
  {
    id: "clangd",
    name: "Clangd C/C++ Language Server",
    languages: ["c", "cpp", "cuda"],
    binary: "clangd",
    args: ["--background-index"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".git"],
  },
];

export class LspServerRegistry {
  private readonly servers = new Map<string, LspServerConfig>();

  constructor(defaults: readonly LspServerConfig[] = DEFAULT_LSP_SERVERS) {
    for (const server of defaults) {
      this.register(server);
    }
  }

  register(server: LspServerConfig): void {
    this.servers.set(server.id, server);
  }

  get(id: string): LspServerConfig | null {
    return this.servers.get(id) ?? null;
  }

  findForLanguage(languageId: string): LspServerConfig | null {
    for (const server of this.servers.values()) {
      if (server.languages.includes(languageId)) {
        return server;
      }
    }
    return null;
  }

  list(): readonly LspServerConfig[] {
    return Array.from(this.servers.values());
  }
}

/**
 * Finds the nearest workspace root by scanning directory ancestors for root markers.
 */
export function findWorkspaceRoot(
  startDir: string,
  rootMarkers: readonly string[],
  existsFn: (path: string) => boolean,
): string | null {
  let current = startDir.replace(/\/+$/, "");
  while (current.length > 0) {
    for (const marker of rootMarkers) {
      const candidate = `${current}/${marker}`;
      if (existsFn(candidate)) {
        return current;
      }
    }
    const lastSlash = current.lastIndexOf("/");
    if (lastSlash <= 0) break;
    current = current.slice(0, lastSlash);
  }
  return null;
}
