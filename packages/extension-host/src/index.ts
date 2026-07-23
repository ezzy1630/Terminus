/**
 * @terminus/extension-host — isolated extension control (SPEC §35.8–35.10).
 *
 * Third-party code runs only via KernelExtensionPort / process host.
 * Hooks: immutable events, deterministic order, hard timeouts, conflict fail.
 * Install: explicit, lifecycle scripts denied for untrusted, SBOM + provenance.
 */
import type { Uuid7, Rfc3339Timestamp, ContentHash } from "@terminus/domain";
import { ValidationError, TimeoutError, PermissionError } from "@terminus/domain";
import { contentHashOf, stableStringify } from "@terminus/capability-registry";

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
  readonly priority: number;
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
  | {
      readonly kind: "propose_tool_result_transform";
      readonly transform: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "veto"; readonly reason: string };

export interface HookInvocation {
  readonly capability: HookCapability;
  readonly event: HookEvent;
  readonly timeoutMs: number;
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

export interface KernelExtensionInvokeRequest {
  readonly extensionId: string;
  readonly kind: "wasi" | "process";
  readonly entrypoint: string;
  readonly contentHash: ContentHash;
  readonly capabilityGrantId: string;
  readonly event: HookEvent;
  readonly hookKind: HookKind;
  readonly limits: ExtensionLimits;
  readonly grantedCapabilities: readonly string[];
}

export interface KernelExtensionPort {
  invoke(request: KernelExtensionInvokeRequest): Promise<HookOutcome>;
}

export interface ExtensionHost {
  readonly kind: "wasi" | "process" | "in_process";
  invoke(invocation: HookInvocation): Promise<HookOutcome>;
  readonly limits: ExtensionLimits;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface BoundExtension {
  readonly extensionId: string;
  readonly entrypoint: string;
  readonly contentHash: ContentHash;
  readonly capabilityGrantId: string;
  readonly grantedCapabilities: readonly string[];
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
}

/**
 * WASI extension host — delegates to kernel ExtensionRuntimeService.
 * Never executes WASM in-process in the control plane.
 */
export class WasiExtensionHost implements ExtensionHost {
  readonly kind = "wasi" as const;
  readonly limits: ExtensionLimits;
  private readonly invocations: HookInvocation[] = [];

  constructor(
    private readonly binding: BoundExtension,
    private readonly kernel: KernelExtensionPort,
    limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS,
  ) {
    this.limits = limits;
  }

  async invoke(invocation: HookInvocation): Promise<HookOutcome> {
    this.invocations.push(invocation);
    if (invocation.capability.extensionId !== this.binding.extensionId) {
      throw new PermissionError("extension id mismatch", {
        expected: this.binding.extensionId,
        actual: invocation.capability.extensionId,
      });
    }
    return withTimeout(
      this.kernel.invoke({
        extensionId: this.binding.extensionId,
        kind: "wasi",
        entrypoint: this.binding.entrypoint,
        contentHash: this.binding.contentHash,
        capabilityGrantId: this.binding.capabilityGrantId,
        event: invocation.event,
        hookKind: invocation.capability.kind,
        limits: this.limits,
        grantedCapabilities: this.binding.grantedCapabilities,
      }),
      Math.min(invocation.timeoutMs, this.limits.wallClockMs),
      `wasi hook ${this.binding.extensionId}:${invocation.capability.kind}`,
    );
  }

  get recordedInvocations(): readonly HookInvocation[] {
    return this.invocations;
  }
}

/**
 * Isolated process extension host — kernel-spawned subprocess, no ambient env.
 */
export class ProcessExtensionHost implements ExtensionHost {
  readonly kind = "process" as const;
  readonly limits: ExtensionLimits;
  private readonly invocations: HookInvocation[] = [];

  constructor(
    private readonly binding: BoundExtension,
    private readonly kernel: KernelExtensionPort,
    limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS,
  ) {
    this.limits = limits;
  }

  async invoke(invocation: HookInvocation): Promise<HookOutcome> {
    this.invocations.push(invocation);
    return withTimeout(
      this.kernel.invoke({
        extensionId: this.binding.extensionId,
        kind: "process",
        entrypoint: this.binding.entrypoint,
        contentHash: this.binding.contentHash,
        capabilityGrantId: this.binding.capabilityGrantId,
        event: invocation.event,
        hookKind: invocation.capability.kind,
        limits: this.limits,
        grantedCapabilities: this.binding.grantedCapabilities,
      }),
      Math.min(invocation.timeoutMs, this.limits.wallClockMs),
      `process hook ${this.binding.extensionId}:${invocation.capability.kind}`,
    );
  }

  get recordedInvocations(): readonly HookInvocation[] {
    return this.invocations;
  }
}

/**
 * In-process host is permitted ONLY for builtin / first_party reviewed code.
 * Third-party must use WASI or process hosts.
 */
export class InProcessExtensionHost implements ExtensionHost {
  readonly kind = "in_process" as const;
  readonly limits: ExtensionLimits;

  constructor(
    private readonly binding: BoundExtension,
    private readonly handler: (invocation: HookInvocation) => Promise<HookOutcome>,
    limits: ExtensionLimits = DEFAULT_EXTENSION_LIMITS,
  ) {
    if (
      binding.trustLevel !== "builtin" &&
      binding.trustLevel !== "first_party"
    ) {
      throw new PermissionError(
        "in-process extension host denied for non first-party trust levels",
        { trustLevel: binding.trustLevel, extensionId: binding.extensionId },
      );
    }
    this.limits = limits;
  }

  async invoke(invocation: HookInvocation): Promise<HookOutcome> {
    return withTimeout(
      this.handler(invocation),
      Math.min(invocation.timeoutMs, this.limits.wallClockMs),
      `in_process hook ${this.binding.extensionId}`,
    );
  }
}

// ────────────────────────── Hook runner ──────────────────────────────────────

export interface HookRunnerDeps {
  readonly hostFor: (extensionId: string) => ExtensionHost;
  readonly clock: () => number;
}

export class HookRunner {
  constructor(private readonly deps: HookRunnerDeps) {}

  async run(
    capabilities: readonly HookCapability[],
    event: HookEvent,
  ): Promise<{
    readonly outcomes: readonly {
      readonly capability: HookCapability;
      readonly outcome: HookOutcome;
    }[];
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
    const fragmentSources: string[] = [];

    for (const cap of sorted) {
      const host = this.deps.hostFor(cap.extensionId);
      const start = this.deps.clock();
      let outcome: HookOutcome;
      try {
        outcome = await withTimeout(
          host.invoke({
            capability: cap,
            event,
            timeoutMs: host.limits.wallClockMs,
          }),
          host.limits.wallClockMs,
          `hook ${cap.extensionId}:${cap.kind}`,
        );
      } catch (err) {
        if (err instanceof TimeoutError) {
          outcome = {
            kind: "veto",
            reason: `extension timed out during hook execution: ${err.message}`,
          };
        } else {
          const errMsg = err instanceof Error ? err.message : String(err);
          outcome = {
            kind: "veto",
            reason: `extension crashed during hook execution: ${errMsg}`,
          };
        }
      }
      const elapsed = this.deps.clock() - start;
      if (elapsed > host.limits.wallClockMs && outcome.kind !== "veto") {
        outcome = {
          kind: "veto",
          reason: `extension timed out during hook execution: wall clock ${host.limits.wallClockMs}ms`,
        };
      }
      outcomes.push({ capability: cap, outcome });
      if (outcome.kind === "veto") {
        veto = outcome.reason;
        break;
      }
      if (cap.kind === "propose_tool_result_transform" && outcome.kind === "propose_tool_result_transform") {
        transformSources.push(cap.extensionId);
      }
      if (cap.kind === "propose_context_fragment" && outcome.kind === "propose_context_fragment") {
        fragmentSources.push(cap.extensionId);
      }
    }

    let conflict: string | null = null;
    if (new Set(transformSources).size > 1) {
      conflict = `multiple extensions proposed transforms: ${[...new Set(transformSources)].join(", ")}`;
    } else if (new Set(fragmentSources).size > 1) {
      conflict = `multiple extensions proposed context fragments: ${[...new Set(fragmentSources)].join(", ")}`;
    }
    return { outcomes, veto, conflict };
  }
}

// ────────────────────────── Extension installation ───────────────────────────

export interface ExtensionInstallationInput {
  readonly packageUri: string;
  readonly packageId?: string;
  readonly version?: string;
  readonly pinnedDigest: ContentHash;
  readonly signature: string | null;
  readonly publisher: string;
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
  readonly lifecycleScripts?: {
    readonly preinstall?: string;
    readonly postinstall?: string;
    readonly prepare?: string;
  };
  readonly files?: readonly { readonly path: string; readonly digest: ContentHash; readonly bytes: number }[];
  readonly entrypoint?: string;
}

export interface ExtensionSbom {
  readonly packageId: string;
  readonly version: string;
  readonly pinnedDigest: ContentHash;
  readonly files: readonly { readonly path: string; readonly digest: ContentHash; readonly bytes: number }[];
  readonly sbomHash: ContentHash;
  readonly generatedAt: Rfc3339Timestamp;
  readonly provenance: {
    readonly publisher: string;
    readonly signature: string | null;
    readonly sourceUri: string;
  };
}

export interface LockfileEntry {
  readonly id: string;
  readonly version: string;
  readonly contentHash: ContentHash;
  readonly signature: string | null;
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
}

export interface ExtensionInstallationResult {
  readonly installed: boolean;
  readonly entry: LockfileEntry;
  readonly sbom: ExtensionSbom;
  readonly warnings: readonly string[];
}

export interface ExtensionStorePort {
  stage(packageId: string, version: string, files: ExtensionInstallationInput["files"]): Promise<string>;
  activate(packageId: string, version: string): Promise<void>;
  remove(packageId: string, version: string): Promise<void>;
}

function resolvePackageId(input: ExtensionInstallationInput): string {
  return input.packageId ?? input.packageUri;
}

function resolveVersion(input: ExtensionInstallationInput): string {
  return input.version ?? "1.0.0";
}

export function validateInstallation(input: ExtensionInstallationInput): LockfileEntry {
  if (input.trustLevel === "verified_third_party" && input.signature === null) {
    throw new ValidationError("verified_third_party extensions require a signature");
  }
  if (input.trustLevel === "untrusted" && input.lifecycleScripts) {
    const scripts = Object.keys(input.lifecycleScripts).filter(
      (k) => (input.lifecycleScripts as Record<string, string | undefined>)[k],
    );
    if (scripts.length > 0) {
      throw new ValidationError(
        `untrusted package lifecycle scripts disabled by default: ${scripts.join(", ")}`,
      );
    }
  }
  return {
    id: resolvePackageId(input),
    version: resolveVersion(input),
    contentHash: input.pinnedDigest,
    signature: input.signature,
    trustLevel: input.trustLevel,
  };
}

export function generateExtensionSbom(
  input: ExtensionInstallationInput,
  generatedAt: Rfc3339Timestamp,
): ExtensionSbom {
  const packageId = resolvePackageId(input);
  const version = resolveVersion(input);
  const files = [...(input.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const sbomHash = contentHashOf(
    stableStringify({
      packageId,
      version,
      pinnedDigest: input.pinnedDigest,
      files,
      publisher: input.publisher,
      signature: input.signature,
      sourceUri: input.packageUri,
    }),
  );
  return {
    packageId,
    version,
    pinnedDigest: input.pinnedDigest,
    files,
    sbomHash,
    generatedAt,
    provenance: {
      publisher: input.publisher,
      signature: input.signature,
      sourceUri: input.packageUri,
    },
  };
}

/**
 * Explicit install — never auto-run at startup. Lifecycle scripts denied for
 * untrusted; optional build steps require a separate sandboxed grant.
 */
export async function installExtension(
  input: ExtensionInstallationInput,
  store: ExtensionStorePort,
  clock: () => Rfc3339Timestamp,
): Promise<ExtensionInstallationResult> {
  const entry = validateInstallation(input);
  const warnings: string[] = [];
  if (input.lifecycleScripts && Object.keys(input.lifecycleScripts).length > 0) {
    if (input.trustLevel === "untrusted") {
      throw new ValidationError("untrusted lifecycle scripts are disabled");
    }
    warnings.push(
      "lifecycle scripts present — require explicit build-sandbox grant; not executed during install",
    );
  }
  const sbom = generateExtensionSbom(input, clock());
  await store.stage(sbom.packageId, sbom.version, input.files ?? []);
  await store.activate(sbom.packageId, sbom.version);
  return { installed: true, entry, sbom, warnings };
}

export async function uninstallExtension(
  packageId: string,
  version: string,
  store: ExtensionStorePort,
): Promise<void> {
  await store.remove(packageId, version);
}

export type { Uuid7, Rfc3339Timestamp, ContentHash };
