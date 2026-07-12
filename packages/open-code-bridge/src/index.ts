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
 * The default bypass register shipped with the bootstrap. Real installations
 * extend this with their own inherited-path inventory.
 */
export const DEFAULT_BYPASS_REGISTER: readonly BypassEntry[] = [
  {
    id: "BYPASS-0001",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/legacy-exec.ts",
    effect: "EXECUTE_LOCAL",
    reason: "inherited OpenCode plugin exec hook",
    containment: "process-level outer sandbox; all calls logged",
    removal_milestone: "M2",
    test: "tests/security/bypass/BYPASS-0001.test.ts",
    status: "contained",
  },
  {
    id: "BYPASS-0002",
    owner: "runtime-team",
    source: "packages/open-code-bridge/src/legacy-fs.ts",
    effect: "WRITE_LOCAL",
    reason: "inherited OpenCode file writer",
    containment: "restricted to active worktree; .git and terminus-state protected",
    removal_milestone: "M3",
    test: "tests/security/bypass/BYPASS-0002.test.ts",
    status: "contained",
  },
];

/**
 * An OpenCode compatibility request shape. The bridge validates and translates
 * these into Terminus public-API calls. Unsupported fields are dropped with a
 * warning, never silently.
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
 * The OpenCode bridge. Accepts legacy OpenCode-compatible requests and routes
 * them through the Terminus public API. This preserves the subset needed by
 * inherited clients during the migration period.
 */
export interface OpenCodeBridge {
  /** Handle a legacy request, returning a Terminus-shaped response. */
  handle(req: OpenCodeLegacyRequest): Promise<OpenCodeLegacyResponse>;
  /** List the bypass entries currently in effect. */
  bypassRegister(): readonly BypassEntry[];
}

/**
 * A no-op bridge used when the OpenCode compatibility facade is disabled. It
 * rejects all legacy requests so callers know they must use the Terminus API.
 */
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
 * Reports the current divergence budget status (SPEC §6.1, §49.4 R1). The
 * bootstrap layer must remain within a measured divergence budget, with
 * generic fixes upstreamed where possible.
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
