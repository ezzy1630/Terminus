import type { TokenCount } from "@terminus/domain";

/**
 * Maximum semantic output reserved for one streamed provider turn.
 *
 * Provider SSE framing expands each token into substantially more wire bytes.
 * The effect kernel deliberately rejects a connector response once its bounded
 * 1 MiB envelope is exceeded. Asking a provider for its full 64k/128k model
 * maximum therefore creates a request that the kernel cannot represent even
 * when the provider is behaving correctly. Keep each turn below that envelope;
 * longer work continues through the normal durable multi-turn loop.
 */
export const MAX_BOUNDED_STREAM_OUTPUT_TOKENS = 8_192n as TokenCount;

/** Clamp a model maximum to the transport's proven bounded stream envelope. */
export function boundedStreamOutputReserve(modelMaximum: bigint): TokenCount {
  if (modelMaximum <= 0n) return modelMaximum as TokenCount;
  return (modelMaximum < MAX_BOUNDED_STREAM_OUTPUT_TOKENS
    ? modelMaximum
    : MAX_BOUNDED_STREAM_OUTPUT_TOKENS) as TokenCount;
}
