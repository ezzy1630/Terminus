/**
 * @terminus/extension-host — isolated extension control.
 *
 * Per SPEC §35.9, §35.10: stub `WasiExtensionHost` and `ProcessExtensionHost`.
 * Hook semantics (observe_only, propose_annotation, propose_policy_input,
 * propose_context_fragment, propose_tool_result_transform, veto). Deterministic
 * hook ordering.
 */
import type {
  Uuid7,
  Rfc3339Timestamp,
  ContentHash,
} from "@terminus/domain";
import { ValidationError, TimeoutError } from "@terminus/domain";

// ────────────────────────── Hooks ────────────────────────────────────────────

export type HookKind =
  | "observe_only"
  | "propose_annotation"
  | "propose_policy_input"
  | "propose_context_fragment"
  | "propose_tool_result_transform"
  | "veto";

export interface HookCapability {
  readonly kind: HookKind;
  readonly extensionId: string;
  readonly priority: number; // Lower runs first.
}

export interface HookEvent {
  readonly eventId: Uuid7;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Rfc3339Timestamp;
}

export type HookOutcome =
  | { readonly kind: "observe_only" }
  | { readonly kind: "propose_annotation"; readonly annotation: Readonly<Record<string, unknown>> }
  | { readonly kind: "propose_policy_input"; readonly policyInput: Readonly<Record<string, unknown>> }
  | { readonly kind: "propose_context_fragment"; readonly fragment: Readonly<Record<string, unknown>> }
  | { readonly kind: "propose_tool_result_transform"; readonly transform: Readonly<Record<string, unknown>> }
  | { readonly kind: "veto"; readonly reason: string };

export interface HookInvocation {
  readonly capability: HookCapability;
  readonly event: HookEvent;
  readonly timeoutMs: number;
}

// ────────────────────────── Extension host ───────────────────────────────────

export interface ExtensionHost {
  readonly kind: "wasi" | "process" | "in_process";
  invoke(invocation: HookInvocation): Promise<HookOutcome>;
  /** Hard resource limits per invocation. */
  readonly limits: ExtensionLimits;
}

export interface ExtensionLimits {
  readonly wallClockMs: number;
  readonly memoryBytes: number;
  readonly cpuMs: number;
  readonly outputBytes: number;
}

export const DEFAULT_EXTENSION_LIMITS: ExtensionLimits = {
  wallClockMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  cpuMs: 3_000,
  outputBytes: 1 * 1024 * 1024,
};

/**
 * Stub WASI extension host. Real implementation delegates to the kernel's
 * `ExtensionRuntimeService` via the kernel RPC client.
 */
export class WasiExtensionHost implements ExtensionHost {
  readonly kind = "wasi" as const;
  readonly limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS;
  private readonly invocations: HookInvocation[] = [];

  async invoke(invocation: HookInvocation): Promise<HookOutcome> {
    this.invocations.push(invocation);
    // Stub: return observe_only for any event.
    return { kind: "observe_only" };
  }

  get recordedInvocations(): readonly HookInvocation[] {
    return this.invocations;
  }
}

/**
 * Stub process extension host. Real implementation spawns an isolated process
 * via the kernel.
 */
export class ProcessExtensionHost implements ExtensionHost {
  readonly kind = "process" as const;
  readonly limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS;
  private readonly invocations: HookInvocation[] = [];

  async invoke(invocation: HookInvocation): Promise<HookOutcome> {
    this.invocations.push(invocation);
    return { kind: "observe_only" };
  }

  get recordedInvocations(): readonly HookInvocation[] {
    return this.invocations;
  }
}

// ────────────────────────── Hook runner ──────────────────────────────────────

export interface HookRunnerDeps {
  readonly hostFor: (extensionId: string) => ExtensionHost;
  readonly clock: () => number;
}

/**
 * Runs hooks in deterministic order (by priority, then by extension ID).
 * Security policy uses the strictest applicable result. Non-security transform
 * conflicts fail rather than depend on nondeterministic load order.
 */
export class HookRunner {
  constructor(private readonly deps: HookRunnerDeps) {}

  async run(
    capabilities: readonly HookCapability[],
    event: HookEvent,
  ): Promise<{
    readonly outcomes: readonly { readonly capability: HookCapability; readonly outcome: HookOutcome }[];
    readonly veto: string | null;
    readonly conflict: string | null;
  }> {
    const sorted = [...capabilities].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.extensionId.localeCompare(b.extensionId);
    });
    const outcomes: { capability: HookCapability; outcome: HookOutcome }[] = [];
    let veto: string | null = null;
    const transformSources: string[] = [];
    for (const cap of sorted) {
      const host = this.deps.hostFor(cap.extensionId);
      const start = this.deps.clock();
      let outcome: HookOutcome;
      try {
        outcome = await host.invoke({
          capability: cap,
          event,
          timeoutMs: host.limits.wallClockMs,
        });
      } catch (err) {
        // Crash isolation: convert plugin crash into fail-closed veto outcome (SPEC §35.9)
        const errMsg = err instanceof Error ? err.message : String(err);
        outcome = { kind: "veto", reason: `extension crashed during hook execution: ${errMsg}` };
      }
      const elapsed = this.deps.clock() - start;
      if (elapsed > host.limits.wallClockMs) {
        throw new TimeoutError(`hook ${cap.extensionId}:${cap.kind}`, host.limits.wallClockMs);
      }
      outcomes.push({ capability: cap, outcome });
      if (outcome.kind === "veto") {
        veto = outcome.reason;
        break;
      }
      if (
        cap.kind === "propose_context_fragment" ||
        cap.kind === "propose_tool_result_transform"
      ) {
        transformSources.push(cap.extensionId);
      }
    }
    // Non-security transform conflicts: more than one extension proposed a
    // fragment or transform.
    const uniqueTransformSources = new Set(transformSources);
    const conflict = uniqueTransformSources.size > 1
      ? `multiple extensions proposed transforms: ${[...uniqueTransformSources].join(", ")}`
      : null;
    return { outcomes, veto, conflict };
  }
}

// ────────────────────────── Extension installation (interface) ───────────────

export interface ExtensionInstallationInput {
  readonly packageUri: string;
  readonly pinnedDigest: ContentHash;
  readonly signature: string | null;
  readonly publisher: string;
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
  readonly lifecycleScripts?: { readonly preinstall?: string; readonly postinstall?: string; readonly prepare?: string };
}

export interface ExtensionInstallationResult {
  readonly installed: boolean;
  readonly entry: LockfileEntry;
  readonly sbomHash: ContentHash;
  readonly warnings: readonly string[];
}

export interface LockfileEntry {
  readonly id: string;
  readonly version: string;
  readonly contentHash: ContentHash;
  readonly signature: string | null;
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
}

/**
 * Validates an installation request. Does NOT perform the install — that's
 * the kernel's job. Returns the lockfile entry to record.
 */
export function validateInstallation(
  input: ExtensionInstallationInput,
): LockfileEntry {
  if (input.trustLevel === "verified_third_party" && input.signature === null) {
    throw new ValidationError("verified_third_party extensions require a signature");
  }
  // Lifecycle scripts are denied by default for untrusted packages (SPEC §35.10).
  if (input.trustLevel === "untrusted" && input.lifecycleScripts) {
    const scripts = Object.keys(input.lifecycleScripts);
    if (scripts.length > 0) {
      throw new ValidationError(`untrusted package lifecycle scripts disabled by default: ${scripts.join(", ")}`);
    }
  }
  return {
    id: input.packageUri,
    version: "1.0.0",
    contentHash: input.pinnedDigest,
    signature: input.signature,
    trustLevel: input.trustLevel,
  };
}

export type { Uuid7, Rfc3339Timestamp, ContentHash };
