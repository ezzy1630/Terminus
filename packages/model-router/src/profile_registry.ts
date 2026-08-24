/**
 * @terminus/model-router — Profile Registry.
 *
 * Per SPEC §26: The Profile Registry manages pinned, versioned model profiles.
 * Every model attempt pins exact profile ID and version.
 */
import type { ModelProfile } from "@terminus/domain";
import { modelProfileSchema } from "@terminus/domain";

export class ModelProfileConflictError extends Error {
  readonly code = "MODEL_PROFILE_CONFLICT";

  constructor(readonly profileId: string) {
    super(
      `model profile '${profileId}' is already registered with different content`,
    );
    this.name = "ModelProfileConflictError";
  }
}

export class ProfileRegistry {
  private readonly profiles = new Map<
    string,
    { readonly profile: ModelProfile; readonly descriptor: string }
  >();

  constructor(initialProfiles: readonly ModelProfile[]) {
    for (const profile of initialProfiles) {
      this.register(profile);
    }
  }

  /**
   * Register a new model profile. Validates schema before storing.
   */
  register(profile: ModelProfile): void {
    const validated = freezeModelProfile(
      modelProfileSchema.parse(profile) as ModelProfile,
    );
    const descriptor = canonicalProfileDescriptor(validated);
    const existing = this.profiles.get(validated.id);
    if (existing) {
      if (existing.descriptor !== descriptor) {
        throw new ModelProfileConflictError(validated.id);
      }
      return;
    }
    this.profiles.set(validated.id, { profile: validated, descriptor });
  }

  /**
   * Get a profile by its exact immutable ID.
   */
  getById(profileId: string): ModelProfile | null {
    return this.profiles.get(profileId)?.profile ?? null;
  }

  /**
   * Resolve a pinned profile by opaque adapter reference, model key, and version.
   */
  resolvePinned(
    adapterRef: string,
    modelKey: string,
    version: string,
  ): ModelProfile | null {
    for (const { profile } of this.profiles.values()) {
      if (
        profile.adapterRef === adapterRef &&
        profile.modelKey === modelKey &&
        profile.version === version
      ) {
        return profile;
      }
    }
    return null;
  }

  /**
   * List all registered profiles.
   */
  listAll(): readonly ModelProfile[] {
    return Array.from(this.profiles.values(), ({ profile }) => profile);
  }

  /**
   * List profiles filtered by opaque adapter reference.
   */
  listByAdapter(adapterRef: string): readonly ModelProfile[] {
    return this.listAll().filter(
      (profile) => profile.adapterRef === adapterRef,
    );
  }

  /**
   * List profiles whose measured capabilities support offline execution.
   */
  listOfflineProfiles(): readonly ModelProfile[] {
    return this.listAll().filter(
      (profile) => profile.capabilities.offlineExecution,
    );
  }

  /**
   * List profiles compatible with a confidentiality classification.
   */
  listForConfidentiality(
    confidentiality: "public" | "workspace" | "secret_adjacent" | "secret",
  ): readonly ModelProfile[] {
    return this.listAll().filter((p) =>
      p.allowedConfidentiality.includes(confidentiality),
    );
  }
}

function canonicalProfileDescriptor(profile: ModelProfile): string {
  return JSON.stringify({
    id: profile.id,
    adapterRef: profile.adapterRef,
    renderingProfileRef: profile.renderingProfileRef,
    modelKey: profile.modelKey,
    version: profile.version,
    modelFamilyRef: profile.modelFamilyRef,
    economics: {
      inputMicrosPerMillion: profile.economics.inputMicrosPerMillion.toString(),
      cachedInputMicrosPerMillion:
        profile.economics.cachedInputMicrosPerMillion.toString(),
      outputMicrosPerMillion:
        profile.economics.outputMicrosPerMillion.toString(),
      reasoningAccounting: profile.economics.reasoningAccounting,
    },
    latencyModel: profile.latencyModel,
    allowedConfidentiality: profile.allowedConfidentiality,
    capabilities: profile.capabilities,
  });
}

function freezeModelProfile(profile: ModelProfile): ModelProfile {
  Object.freeze(profile.economics);
  Object.freeze(profile.latencyModel);
  Object.freeze(profile.allowedConfidentiality);
  Object.freeze(profile.capabilities);
  return Object.freeze(profile);
}
