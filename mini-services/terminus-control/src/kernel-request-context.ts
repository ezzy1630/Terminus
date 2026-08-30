import type { RequestContext } from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

/**
 * A fixed context is useful for short bootstrap operations. Long-lived turn
 * services use a provider so capability minting runs again at each kernel
 * operation boundary instead of retaining a token past its expiry.
 */
export type KernelRequestContextSource =
  | RequestContext
  | (() => Promise<RequestContext>);

export async function resolveKernelRequestContext(
  source: KernelRequestContextSource,
): Promise<RequestContext> {
  return typeof source === "function" ? source() : source;
}
