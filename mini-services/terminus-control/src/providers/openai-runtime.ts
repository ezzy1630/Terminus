import { decodeOpenAiStream, renderRequest } from "@terminus/provider-openai";
import {
  dispatchNativeRequest,
  type NativeDispatchInput,
  type NativeRuntimeConfig,
  type NativeStreamResult,
  type NativeTransportDeps,
} from "./native-provider-runtime.js";

/**
 * Native OpenAI runtime (deep-audit Rank 4 / PR6).
 *
 * Renders the canonical context through the OpenAI renderer (Responses
 * protocol by default) and streams via a caller-wired kernel-brokered
 * transport. Continuation ids from `response.completed` are surfaced to the
 * caller so they can be persisted as a durable turn primitive.
 *
 * The transport is a required argument: this module never opens sockets and
 * refuses to guess an egress path.
 */

export const OPENAI_NATIVE_CONFIG: NativeRuntimeConfig = {
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  endpointPath: "/responses",
};

export function openaiTransportDeps(transport: NativeTransportDeps["postSse"], now?: () => number): NativeTransportDeps {
  return {
    postSse: transport,
    decode: (chunks) => decodeOpenAiStream(chunks, "responses"),
    ...(now !== undefined ? { now } : {}),
  };
}

export async function dispatchOpenAI(
  input: Omit<NativeDispatchInput, "rendered"> & {
    readonly canonicalRenderInput: Parameters<typeof renderRequest>[0];
    /** Required kernel-brokered SSE transport; there is no default. */
    readonly postSse: NativeTransportDeps["postSse"];
    readonly now?: () => number;
  },
): Promise<NativeStreamResult> {
  const { postSse, now, ...rest } = input;
  const rendered = await renderRequest(rest.canonicalRenderInput);
  return dispatchNativeRequest(OPENAI_NATIVE_CONFIG, openaiTransportDeps(postSse, now), {
    ...rest,
    rendered,
  });
}
