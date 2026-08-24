import type {
  CanonicalRenderInput,
  CostRecord,
  ProjectedResponse,
  ProviderRenderer,
  ProviderResponse,
  UsageRecord,
} from "../index.js";

export interface GoldenEpisodeExpectation {
  readonly roles: readonly string[];
  readonly hasToolCalls?: boolean | undefined;
  readonly hasToolResults?: boolean | undefined;
  readonly hasCacheControl?: boolean | undefined;
  readonly hasReasoning?: boolean | undefined;
  readonly maxTokens?: number | undefined;
}

export interface GoldenEpisode {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly input: CanonicalRenderInput;
  readonly simulatedResponse: ProviderResponse;
  readonly expectedProjection: ProjectedResponse;
  readonly expectedUsage: UsageRecord;
  readonly expectedCost?: CostRecord | undefined;
  readonly expectations: {
    readonly openai: GoldenEpisodeExpectation;
    readonly anthropic: GoldenEpisodeExpectation;
  };
}

export interface ConformanceViolation {
  readonly episodeId: string;
  readonly rendererId: string;
  readonly check: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

export interface ConformanceReport {
  readonly rendererId: string;
  readonly totalEpisodes: number;
  readonly passedEpisodes: number;
  readonly failedEpisodes: number;
  readonly passed: boolean;
  readonly violations: readonly ConformanceViolation[];
  readonly testedAt: string;
}
