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

export function openaiNativeConfig(protocol: "responses" | "chat_completions" = "responses"): NativeRuntimeConfig {
  return {
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" },
    // The transport must match the wire protocol the renderer produced;
    // posting Chat Completions bodies to /responses fails upstream.
    endpointPath: protocol === "chat_completions" ? "/chat/completions" : "/responses",
  };
}

/** Default config kept for existing call sites that use the Responses API. */
export const OPENAI_NATIVE_CONFIG = openaiNativeConfig("responses");

export function openaiTransportDeps(transport: NativeTransportDeps["postSse"], now?: () => number): NativeTransportDeps {
  return {
    postSse: transport,
    decode: (chunks) => decodeOpenAiStream(chunks, "responses"),
    ...(now !== undefined ? { now } : {}),
  };
}

export async function dispatchOpenAI(
  input: Omit<NativeDispatchInput, "rendered"> & {
    readonly canonicalRenderInput?: Parameters<typeof renderRequest>[0];
    readonly rendered?: import("@terminus/provider-core").RenderedProviderRequest;
    readonly protocol?: "responses" | "chat_completions";
    /** Stable per-epoch cache routing key appended to Responses bodies. */
    readonly promptCacheKey?: string;
    /** Required kernel-brokered SSE transport; there is no default. */
    readonly postSse: NativeTransportDeps["postSse"];
    readonly now?: () => number;
  },
): Promise<NativeStreamResult> {
  const { postSse, now, canonicalRenderInput, rendered, protocol, promptCacheKey, ...rest } = input;
  const baseRendered =
    rendered ??
    (await renderRequest(canonicalRenderInput as Parameters<typeof renderRequest>[0]));
  const finalRendered = promptCacheKey === undefined
    ? baseRendered
    : {
        ...baseRendered,
        body: { ...baseRendered.body, prompt_cache_key: promptCacheKey },
      };
  return dispatchNativeRequest(openaiNativeConfig(protocol), openaiTransportDeps(postSse, now), {
    ...rest,
    rendered: finalRendered,
  });
}
