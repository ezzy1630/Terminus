/**
 * @terminus/model-router — Profile Registry.
 *
 * Per SPEC §26: The Profile Registry manages pinned, versioned model profiles.
 * Every model attempt pins exact profile ID and version.
 */
import type { ModelProfile } from "@terminus/domain";
import { modelProfileSchema } from "@terminus/domain";
import { STANDARD_MODEL_PROFILES } from "./profiles.js";

export class ProfileRegistry {
  private readonly profiles = new Map<string, ModelProfile>();

  constructor(initialProfiles: readonly ModelProfile[] = STANDARD_MODEL_PROFILES) {
    for (const profile of initialProfiles) {
      this.register(profile);
    }
  }

  /**
   * Register a new model profile. Validates schema before storing.
   */
  register(profile: ModelProfile): void {
    const validated = modelProfileSchema.parse(profile);
    this.profiles.set(validated.id, validated);
  }

  /**
   * Get a profile by its exact immutable ID.
   */
  getById(profileId: string): ModelProfile | null {
    return this.profiles.get(profileId) ?? null;
  }

  /**
   * Resolve a pinned profile by provider, modelKey, and version.
   */
  resolvePinned(providerId: string, modelKey: string, version: string): ModelProfile | null {
    for (const profile of this.profiles.values()) {
      if (
        profile.providerId === providerId &&
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
    return Array.from(this.profiles.values());
  }

  /**
   * List profiles filtered by provider.
   */
  listByProvider(providerId: string): readonly ModelProfile[] {
    return Array.from(this.profiles.values()).filter((p) => p.providerId === providerId);
  }

  /**
   * List local/offline profiles safe for airgapped or secret workloads.
   */
  listLocalProfiles(): readonly ModelProfile[] {
    return Array.from(this.profiles.values()).filter((p) => p.providerId === "local");
  }

  /**
   * List profiles compatible with a confidentiality classification.
   */
  listForConfidentiality(
    confidentiality: "public" | "workspace" | "secret_adjacent" | "secret",
  ): readonly ModelProfile[] {
    return Array.from(this.profiles.values()).filter((p) =>
      p.confidentialityPolicy.includes(confidentiality),
    );
  }
}

export const defaultProfileRegistry = new ProfileRegistry();
