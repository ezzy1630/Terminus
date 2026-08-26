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
 * breakpoints and streams via a caller-wired kernel-brokered transport.
 * Cache reads and writes reported in `message_start.usage` are reconciled
 * against the renderer's predicted breakpoints.
 *
 * The transport is a required argument: this module never opens sockets and
 * refuses to guess an egress path. The production wiring passes
 * `kernelConnectorPostSse` from `direct-provider-transport.ts`.
 */

export const ANTHROPIC_NATIVE_CONFIG: NativeRuntimeConfig = {
  providerId: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  // The kernel connector resolves the secret and injects `x-api-key`
  // inside its trusted boundary; adding an Authorization header here would
  // be rejected, and the Messages API requires a version header.
  auth: { kind: "connector-injected" },
  endpointPath: "/messages",
  extraHeaders: { "anthropic-version": "2023-06-01" },
};

export function anthropicTransportDeps(transport: NativeTransportDeps["postSse"], now?: () => number): NativeTransportDeps {
  return {
    postSse: transport,
    decode: (chunks) => decodeAnthropicStream(chunks),
    ...(now !== undefined ? { now } : {}),
  };
}

export async function dispatchAnthropic(
  input: Omit<NativeDispatchInput, "rendered"> & {
    readonly canonicalRenderInput: Parameters<typeof renderRequest>[0];
    /** Required kernel-brokered SSE transport; there is no default. */
    readonly postSse: NativeTransportDeps["postSse"];
    readonly now?: () => number;
  },
): Promise<NativeStreamResult> {
  const { postSse, now, ...rest } = input;
  const rendered = await renderRequest(rest.canonicalRenderInput);
  return dispatchNativeRequest(ANTHROPIC_NATIVE_CONFIG, anthropicTransportDeps(postSse, now), {
    ...rest,
    rendered,
  });
}
