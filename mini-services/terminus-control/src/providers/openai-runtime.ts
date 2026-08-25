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
 * protocol by default) and streams via the kernel-brokered transport.
 * Continuation ids from `response.completed` are surfaced to the caller so
 * they can be persisted as a durable turn primitive.
 */

export const OPENAI_NATIVE_CONFIG: NativeRuntimeConfig = {
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  endpointPath: "/responses",
};

export function openaiTransportDeps(
  overrides: Partial<Pick<NativeTransportDeps, "postSse" | "now">> = {},
): NativeTransportDeps {
  return {
    postSse:
      overrides.postSse ??
      (async () => {
        throw new Error(
          "no kernel-brokered egress transport is wired for native OpenAI dispatch; refusing to open a direct socket",
        );
      }),
    decode: (chunks) => decodeOpenAiStream(chunks, "responses"),
    now: overrides.now,
  };
}

export async function dispatchOpenAI(
  input: Omit<NativeDispatchInput, "rendered"> & {
    readonly canonicalRenderInput: Parameters<typeof renderRequest>[0];
  },
): Promise<NativeStreamResult> {
  const rendered = await renderRequest(input.canonicalRenderInput);
  return dispatchNativeRequest(OPENAI_NATIVE_CONFIG, openaiTransportDeps(), {
    ...input,
    rendered,
  });
}
