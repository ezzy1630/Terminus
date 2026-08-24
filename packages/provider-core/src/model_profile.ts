/**
 * Provider-owned rendering profile contract.
 *
 * The canonical domain keeps only opaque references to this configuration.
 * Each concrete provider package owns its wire values and model catalog.
 */
import type { ModelProfile } from "@terminus/domain";
import { modelProfileSchema } from "@terminus/domain";

export interface ProviderRenderingProfile {
  readonly id: string;
  readonly adapterRef: string;
  readonly modelKey: string;
  readonly version: string;
  readonly systemPromptPlacement: string;
  readonly toolDialect: string;
  readonly editDialect: string;
  readonly reasoningEffort: string;
  readonly continuationStrategy: string;
  readonly compactionStrategy: string;
  readonly caching: {
    readonly mode: string;
    readonly minimumTokens: number;
    readonly exactPrefixRequired: boolean;
  };
  readonly structuredOutputRepair: {
    readonly dialect: string;
    readonly autoRepair: boolean;
    readonly retryPromptTemplate: string;
  };
  readonly knownFailureMitigations: readonly string[];
}

export interface ProviderProfileBundle<
  TRenderingProfile extends ProviderRenderingProfile = ProviderRenderingProfile,
> {
  readonly model: ModelProfile;
  readonly rendering: TRenderingProfile;
}

/**
 * Bind a neutral routing profile to provider-owned rendering configuration.
 * The composition root injects `model` into the router and keeps `rendering`
 * inside the selected adapter.
 */
export function defineProviderProfileBundle<
  TRenderingProfile extends ProviderRenderingProfile,
>(
  model: ModelProfile,
  rendering: TRenderingProfile,
): ProviderProfileBundle<TRenderingProfile> {
  const validatedModel = modelProfileSchema.parse(model) as ModelProfile;

  if (validatedModel.adapterRef !== rendering.adapterRef) {
    throw new TypeError(
      `model profile '${validatedModel.id}' adapterRef does not match rendering profile '${rendering.id}'`,
    );
  }
  if (validatedModel.renderingProfileRef !== rendering.id) {
    throw new TypeError(
      `model profile '${validatedModel.id}' renderingProfileRef does not match '${rendering.id}'`,
    );
  }
  if (validatedModel.modelKey !== rendering.modelKey) {
    throw new TypeError(
      `model profile '${validatedModel.id}' modelKey does not match rendering profile '${rendering.id}'`,
    );
  }
  if (validatedModel.version !== rendering.version) {
    throw new TypeError(
      `model profile '${validatedModel.id}' version does not match rendering profile '${rendering.id}'`,
    );
  }

  return { model: validatedModel, rendering };
}
