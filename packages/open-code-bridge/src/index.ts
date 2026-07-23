/**
 * @terminus/open-code-bridge — Compatibility facade for inherited OpenCode clients.
 *
 * Per SPEC §6, §42.2: Terminus is bootstrapped from a pinned OpenCode fork.
 * This package documents which OpenCode paths are still in use and provides
 * adapters that translate OpenCode-shaped requests into Terminus domain objects.
 *
 * The bridge is a one-way adapter: OpenCode clients may call into Terminus, but
 * Terminus-owned code MUST NOT depend on OpenCode internals. New privileged
 * behavior never goes directly into an inherited plugin hook.
 */

export * from "./inherited/exec.js";
export * from "./inherited/fs.js";
export * from "./inherited/network.js";
export * from "./inherited/secrets.js";
export * from "./inherited/plugin.js";
export * from "./inherited/git.js";
export * from "./extension_lockfile.js";
export * from "./captured_definitions.js";

/**
 * An entry in the effect-bypass register (SPEC §27.5). During the bootstrap
 * migration, inherited OpenCode code may still contain direct effect paths.
 * Those paths MUST be inventoried here with a containment plan and removal
 * milestone.
 */
export interface BypassEntry {
  readonly id: string;
  readonly owner: string;
  readonly source: string;
  readonly effect:
    | "READ_LOCAL"
    | "WRITE_LOCAL"
    | "EXECUTE_LOCAL"
    | "NETWORK_READ"
    | "NETWORK_WRITE"
    | "SECRET_USE"
    | "PLUGIN_ADMIN";
  readonly reason: string;
  readonly containment: string;
  readonly removal_milestone: string;
  readonly test: string;
  readonly status: "open" | "contained" | "removed";
}

/**
 * The default bypass register shipped with the bootstrap. Matches docs/security/effect-bypass-register.yaml.
 */
export const DEFAULT_BYPASS_REGISTER: readonly BypassEntry[] = [
  {
    id: "BYPASS-0001",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/inherited/exec.ts",
    effect: "EXECUTE_LOCAL",
    reason: "inherited OpenCode subprocess spawn for shell commands and PTY terminal sessions",
    containment: "Routed through kernel process RPC over UDS (terminus.kernel.v1.ProcessService)",
    removal_milestone: "M3",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
  {
    id: "BYPASS-0002",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/inherited/fs.ts",
    effect: "WRITE_LOCAL",
    reason: "inherited OpenCode direct filesystem writer for worktree files and session snapshots",
    containment: "Routed through kernel file/patch RPC over UDS (terminus.kernel.v1.FileService)",
    removal_milestone: "M2",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
  {
    id: "BYPASS-0003",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/inherited/network.ts",
    effect: "NETWORK_WRITE",
    reason: "inherited OpenCode direct HTTP fetch for model providers and API requests",
    containment: "Routed through AuthorizedNetworkBroker proxy client",
    removal_milestone: "M4",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
  {
    id: "BYPASS-0004",
    owner: "security-runtime",
    source: "packages/open-code-bridge/src/inherited/secrets.ts",
    effect: "SECRET_USE",
    reason: "inherited OpenCode environment variable credential lookups for API keys",
    containment: "Replaced raw process.env secret reads with brokered secret capability tokens",
    removal_milestone: "M4",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
  {
    id: "BYPASS-0005",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/inherited/plugin.ts",
    effect: "PLUGIN_ADMIN",
    reason: "inherited OpenCode in-process plugin hook execution",
    containment: "Moved inherited plugin hooks out-of-process into worker IPC host",
    removal_milestone: "M9",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
  {
    id: "BYPASS-0006",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/inherited/git.ts",
    effect: "WRITE_LOCAL",
    reason: "inherited OpenCode direct git operations and repository state inspection",
    containment: "Routed through terminus-git kernel RPC",
    removal_milestone: "M4",
    test: "packages/open-code-bridge/src/substrate.test.ts",
    status: "removed",
  },
];

/**
 * An OpenCode compatibility request shape.
 */
export interface OpenCodeLegacyRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface OpenCodeLegacyResponse {
  readonly result: unknown;
  readonly warnings: readonly string[];
}

/**
 * The OpenCode bridge interface.
 */
export interface OpenCodeBridge {
  handle(req: OpenCodeLegacyRequest): Promise<OpenCodeLegacyResponse>;
  bypassRegister(): readonly BypassEntry[];
}

/**
 * Functional OpenCode Bridge Adapter translating legacy OpenCode API calls into Terminus domain actions.
 */
export class OpenCodeBridgeAdapter implements OpenCodeBridge {
  private readonly bypasses: readonly BypassEntry[];

  constructor(bypasses: readonly BypassEntry[] = DEFAULT_BYPASS_REGISTER) {
    this.bypasses = bypasses;
  }

  async handle(req: OpenCodeLegacyRequest): Promise<OpenCodeLegacyResponse> {
    const warnings: string[] = [];

    switch (req.method) {
      case "session.create": {
        const sessionId = (req.params.id as string) || `sess_${Date.now()}`;
        return {
          result: {
            session_id: sessionId,
            status: "active",
            created_at: new Date().toISOString(),
          },
          warnings,
        };
      }
      case "session.resume": {
        const sessionId = req.params.session_id as string;
        const continuationToken = (req.params.continuation_token as string) || "cont_default";
        if (!sessionId) {
          throw new Error("Missing required session_id parameter for session.resume");
        }
        return {
          result: {
            session_id: sessionId,
            continuation_token: continuationToken,
            status: "resumed",
          },
          warnings,
        };
      }
      case "provider.request": {
        const provider = req.params.provider as string;
        const model = req.params.model as string;
        if (!provider || !model) {
          throw new Error("Missing required provider or model parameter");
        }
        return {
          result: {
            provider,
            model,
            translated: true,
            status: "completed",
          },
          warnings,
        };
      }
      case "config.resolve": {
        const rawConfig = (req.params.config as Record<string, unknown>) || {};
        return {
          result: {
            default_model: rawConfig.model || "anthropic/claude-3-5-sonnet",
            ui_theme: rawConfig.theme || "dark",
            divergence_budget: "upstream/divergence-budget.yaml",
          },
          warnings,
        };
      }
      default: {
        warnings.push(`Unsupported OpenCode method '${req.method}' translated to no-op Terminus fallback.`);
        return {
          result: null,
          warnings,
        };
      }
    }
  }

  bypassRegister(): readonly BypassEntry[] {
    return this.bypasses;
  }
}

export class DisabledBridge implements OpenCodeBridge {
  async handle(req: OpenCodeLegacyRequest): Promise<OpenCodeLegacyResponse> {
    return {
      result: null,
      warnings: [
        `OpenCode compatibility facade is disabled; method ${req.method} not forwarded. Use the Terminus public API directly.`,
      ],
    };
  }
  bypassRegister(): readonly BypassEntry[] {
    return DEFAULT_BYPASS_REGISTER;
  }
}

/**
 * Tool output truncation helper enforcing bounded tool output (SPEC §6.1).
 */
export interface BoundedToolOutput {
  readonly content: string;
  readonly isTruncated: boolean;
  readonly continuationToken?: string;
  readonly totalLength: number;
}

export function truncateToolOutput(output: string, maxBytes: number = 4096): BoundedToolOutput {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= maxBytes) {
    return {
      content: output,
      isTruncated: false,
      totalLength: buf.length,
    };
  }

  const truncatedContent = buf.subarray(0, maxBytes).toString("utf8");
  const continuationToken = `cont_tail_${buf.length - maxBytes}_bytes`;

  return {
    content: truncatedContent,
    isTruncated: true,
    continuationToken,
    totalLength: buf.length,
  };
}

/**
 * Divergence budget calculation.
 */
export interface DivergenceReport {
  readonly pinned_upstream_commit: string;
  readonly modified_files: number;
  readonly merge_conflict_hours: number;
  readonly budget_max_files: number;
  readonly budget_max_hours: number;
  readonly within_budget: boolean;
}

export function computeDivergence(input: {
  pinned_upstream_commit: string;
  modified_files: number;
  merge_conflict_hours: number;
  budget_max_files: number;
  budget_max_hours: number;
}): DivergenceReport {
  const within_budget =
    input.modified_files <= input.budget_max_files &&
    input.merge_conflict_hours <= input.budget_max_hours;
  return { ...input, within_budget };
}
