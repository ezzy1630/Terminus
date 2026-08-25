import { decodeAnthropicStream, renderRequest } from "@terminus/provider-anthropic";
import {
  dispatchNativeRequest,
  type NativeDispatchInput,
  type NativeRuntimeConfig,
  type NativeStreamResult,
  type NativeTransportDeps,
} from "./native-provider-runtime.js";

/**
 * Native Anthropic runtime (deep-audit Rank 4 / PR7).
 *
 * Renders through the Messages renderer with explicit cache_control
 * breakpoints and streams via the kernel-brokered transport. Cache reads and
 * writes reported in `message_start.usage` are reconciled against the
 * renderer's predicted breakpoints.
 */

export const ANTHROPIC_NATIVE_CONFIG: NativeRuntimeConfig = {
  providerId: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  endpointPath: "/messages",
};

export function anthropicTransportDeps(
  overrides: Partial<Pick<NativeTransportDeps, "postSse" | "now">> = {},
): NativeTransportDeps {
  return {
    postSse:
      overrides.postSse ??
      (async () => {
        throw new Error(
          "no kernel-brokered egress transport is wired for native Anthropic dispatch; refusing to open a direct socket",
        );
      }),
    decode: (chunks) => decodeAnthropicStream(chunks),
    now: overrides.now,
  };
}

export async function dispatchAnthropic(
  input: Omit<NativeDispatchInput, "rendered"> & {
    readonly canonicalRenderInput: Parameters<typeof renderRequest>[0];
  },
): Promise<NativeStreamResult> {
  const rendered = await renderRequest(input.canonicalRenderInput);
  return dispatchNativeRequest(ANTHROPIC_NATIVE_CONFIG, anthropicTransportDeps(), {
    ...input,
    rendered,
  });
}
