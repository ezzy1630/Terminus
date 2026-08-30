import { z } from "zod";
import type { ContentHash } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/** The permanent narrow standalone control arm (ADR-0025, ADR-0039). */
export const TERMINUS_MINIMAL_PROFILE_ID = "terminus-minimal" as const;
export const TERMINUS_MINIMAL_PROFILE_VERSION = "1" as const;
/**
 * The always-on coding surface. Every id here is declared to the provider,
 * accepted by the dispatch guard, and executable.
 *
 * It used to be `["read","patch","exec"]` while `grep`, `glob` and
 * `exec_poll` were implemented, documented in the system prompt, and named by
 * the exec tool's own description — and then rejected at dispatch. Three
 * inventories disagreeing is what this constant now prevents: it must stay
 * equal to `STANDALONE_ALWAYS_ON_TOOL_IDS` in agent-tools.ts, which
 * `minimal-profile.test.ts` asserts.
 */
export const TERMINUS_MINIMAL_TOOL_IDS = [
  "read",
  "patch",
  "write",
  "exec",
  "exec_poll",
  "grep",
  "glob",
] as const;

/** Tools a profile may declare: always-on plus the activatable ones. */
export const TERMINUS_DECLARABLE_TOOL_IDS = [
  "capability",
  ...TERMINUS_MINIMAL_TOOL_IDS,
  "web_fetch",
] as const;

export interface TerminusMinimalProfile {
  readonly profileId: typeof TERMINUS_MINIMAL_PROFILE_ID;
  readonly version: typeof TERMINUS_MINIMAL_PROFILE_VERSION;
  readonly providerId: string;
  readonly modelKey: string;
  readonly toolIds: readonly string[];
  readonly routerEnabled: false;
  readonly memoryEnabled: false;
  readonly workflowEnabled: false;
  readonly subagentsEnabled: false;
  /** Hash of the safe provider/profile configuration, never the credential. */
  readonly configurationHash: ContentHash;
  readonly profileHash: ContentHash;
}

export const terminusMinimalProfileSchema = z.object({
  profileId: z.literal(TERMINUS_MINIMAL_PROFILE_ID),
  version: z.literal(TERMINUS_MINIMAL_PROFILE_VERSION),
  providerId: z.string().min(1),
  modelKey: z.string().min(1),
  // An array over the declarable set, not a fixed 3-tuple: the tuple made
  // any profile that shipped the real tool surface fail its own validation.
  // A provider without tool calling may declare zero tools. An explicit
  // empty array is different from an omitted array, which still selects the
  // normal coding tool set.
  toolIds: z.array(z.enum(TERMINUS_DECLARABLE_TOOL_IDS)),
  routerEnabled: z.literal(false),
  memoryEnabled: z.literal(false),
  workflowEnabled: z.literal(false),
  subagentsEnabled: z.literal(false),
  configurationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  profileHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export interface TerminusMinimalProfileInput {
  readonly providerId: string;
  readonly modelKey: string;
  /** Safe configuration identity. Do not pass API keys or secret material. */
  readonly configuration?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The bounded tool lifecycle this turn may declare to the provider.
   * Defaults to the always-on set; lazy activation passes capability plus the
   * workspace set while attempt records retain the exact per-request schema.
   */
  readonly toolIds?: readonly string[] | undefined;
}

/**
 * Create the minimal profile with a fixed tool set and all optional routing,
 * memory, workflow, and delegation features disabled.
 */
export function createTerminusMinimalProfile(
  input: TerminusMinimalProfileInput,
): TerminusMinimalProfile {
  const providerId = input.providerId.trim();
  const modelKey = input.modelKey.trim();
  if (providerId.length === 0 || modelKey.length === 0) {
    throw new Error("terminus-minimal requires a provider and model");
  }
  const configuration = input.configuration ?? {};
  assertSafeConfiguration(configuration);
  const configurationHash = computeContentHash(canonicalJson(configuration));
  const declarable = new Set<string>(TERMINUS_DECLARABLE_TOOL_IDS);
  const requestedToolIds = input.toolIds === undefined
    ? [...TERMINUS_MINIMAL_TOOL_IDS]
    : [...new Set(input.toolIds)];
  const unknownToolId = requestedToolIds.find((toolId) => !declarable.has(toolId));
  if (unknownToolId !== undefined) {
    throw new Error(`terminus-minimal cannot declare unknown tool '${unknownToolId}'`);
  }
  const base = {
    profileId: TERMINUS_MINIMAL_PROFILE_ID,
    version: TERMINUS_MINIMAL_PROFILE_VERSION,
    providerId,
    modelKey,
    // Sorted so the profile hash is stable across declaration order.
    toolIds: [...requestedToolIds].sort(),
    routerEnabled: false as const,
    memoryEnabled: false as const,
    workflowEnabled: false as const,
    subagentsEnabled: false as const,
    configurationHash,
  };
  const profile = {
    ...base,
    profileHash: computeContentHash(canonicalJson(base)),
  };
  return validateTerminusMinimalProfile(profile);
}

export const EVIDENCE_BUNDLE_VERSION = "terminus.evidence-bundle.v1" as const;

export type EvidenceTerminalOutcome =
  | "COMPLETED"
  | "BLOCKED"
  | "NEEDS_USER_DECISION"
  | "BUDGET_EXHAUSTED"
  | "POLICY_DENIED"
  | "FAILED_VERIFICATION"
  | "ABORTED";

export interface EvidenceIdentityInput {
  readonly taskId: string;
  readonly turnId: string;
  readonly contractVersion: number;
  readonly baseWorkspaceRevision: string;
  readonly finalWorkspaceRevision: string;
  readonly profile: TerminusMinimalProfile;
  readonly providerAttemptIds: readonly string[];
  readonly contextManifestIds: readonly string[];
  readonly requestArtifactHashes: readonly string[];
  readonly responseArtifactHashes: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly verificationResultIds: readonly string[];
  readonly proofBundleHash?: string | null | undefined;
  readonly terminalOutcome: EvidenceTerminalOutcome;
}

export interface EvidenceIdentity {
  readonly schemaVersion: typeof EVIDENCE_BUNDLE_VERSION;
  readonly identityHash: ContentHash;
  readonly taskId: string;
  readonly turnId: string;
  readonly contractVersion: number;
  readonly baseWorkspaceRevision: string;
  readonly finalWorkspaceRevision: string;
  readonly profileHash: ContentHash;
  readonly providerAttemptIds: readonly string[];
  readonly contextManifestIds: readonly string[];
  readonly requestArtifactHashes: readonly string[];
  readonly responseArtifactHashes: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly verificationResultIds: readonly string[];
  readonly proofBundleHash: string | null;
  readonly terminalOutcome: EvidenceTerminalOutcome;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret)/i;

function assertSafeConfiguration(value: unknown, path = "configuration"): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSafeConfiguration(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(`${path}.${key} is credential-bearing and cannot enter terminus-minimal`);
    }
    assertSafeConfiguration(nested, `${path}.${key}`);
  }
}

function profileHashInput(profile: Omit<TerminusMinimalProfile, "profileHash">): string {
  return canonicalJson(profile);
}

/** Validate both the shape and the content-derived profile identity. */
export function validateTerminusMinimalProfile(
  profile: TerminusMinimalProfile,
): TerminusMinimalProfile {
  const parsed = terminusMinimalProfileSchema.parse(profile) as unknown as TerminusMinimalProfile;
  const expected = computeContentHash(profileHashInput({
    profileId: parsed.profileId,
    version: parsed.version,
    providerId: parsed.providerId,
    modelKey: parsed.modelKey,
    toolIds: parsed.toolIds,
    routerEnabled: parsed.routerEnabled,
    memoryEnabled: parsed.memoryEnabled,
    workflowEnabled: parsed.workflowEnabled,
    subagentsEnabled: parsed.subagentsEnabled,
    configurationHash: parsed.configurationHash,
  }));
  if (parsed.profileHash !== expected) {
    throw new Error("terminus-minimal profile hash does not match its configuration");
  }
  return parsed;
}

/**
 * Derive one immutable identity for the evidence that can admit a turn. This
 * records references and hashes only. It never embeds model output or secrets.
 */
export function buildEvidenceIdentity(input: EvidenceIdentityInput): EvidenceIdentity {
  const profile = validateTerminusMinimalProfile(input.profile);
  const identity = {
    schema_version: EVIDENCE_BUNDLE_VERSION,
    task_id: input.taskId,
    turn_id: input.turnId,
    contract_version: input.contractVersion,
    base_workspace_revision: input.baseWorkspaceRevision,
    final_workspace_revision: input.finalWorkspaceRevision,
    profile_hash: profile.profileHash,
    provider_attempt_ids: sortedUnique(input.providerAttemptIds),
    context_manifest_ids: sortedUnique(input.contextManifestIds),
    request_artifact_hashes: sortedUnique(input.requestArtifactHashes),
    response_artifact_hashes: sortedUnique(input.responseArtifactHashes),
    tool_call_ids: sortedUnique(input.toolCallIds),
    verification_result_ids: sortedUnique(input.verificationResultIds),
    proof_bundle_hash: input.proofBundleHash ?? null,
    terminal_outcome: input.terminalOutcome,
  } as const;
  return {
    schemaVersion: EVIDENCE_BUNDLE_VERSION,
    identityHash: computeContentHash(canonicalJson(identity)),
    taskId: input.taskId,
    turnId: input.turnId,
    contractVersion: input.contractVersion,
    baseWorkspaceRevision: input.baseWorkspaceRevision,
    finalWorkspaceRevision: input.finalWorkspaceRevision,
    profileHash: profile.profileHash,
    providerAttemptIds: identity.provider_attempt_ids,
    contextManifestIds: identity.context_manifest_ids,
    requestArtifactHashes: identity.request_artifact_hashes,
    responseArtifactHashes: identity.response_artifact_hashes,
    toolCallIds: identity.tool_call_ids,
    verificationResultIds: identity.verification_result_ids,
    proofBundleHash: identity.proof_bundle_hash,
    terminalOutcome: input.terminalOutcome,
  };
}
