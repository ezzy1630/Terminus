/**
 * Live native direct executor (Cubic wiring finding).
 *
 * Bridges the vendor dispatchers — cache reconciliation, budget preflight,
 * partial settlement — into the live loop's direct path. The kernel
 * connector's streaming client is the postSse transport; credentials stay
 * connector-injected, so no Authorization header is constructed here.
 */
import type { ProviderEconomics, RenderedProviderRequest } from "@terminus/provider-core";
import type { ProviderExecutionInput } from "../services/provider-session-service.js";
import type {
  ConnectorService,
  RequestContext,
} from "../../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { Micros } from "@terminus/domain";
import {
  KernelDirectConnectorClient,
  directEndpoint,
} from "../direct-provider-transport.js";
import type { DirectProviderConfiguration } from "../direct-provider-config.js";
import { anthropicTransportDeps, dispatchAnthropic } from "./anthropic-runtime.js";
import { openaiTransportDeps, dispatchOpenAI } from "./openai-runtime.js";
import type { BudgetLimits } from "./native-provider-runtime.js";

export interface NativeDirectExecutorOptions {
  readonly configuration: DirectProviderConfiguration;
  readonly connectors: ConnectorService;
  /** Task-contract model budget in micros; bounds every request. */
  readonly requestBudgetMicros: bigint;
  readonly economics: ProviderEconomics;
  /** Per-epoch OpenAI prompt-cache routing key. */
  readonly promptCacheKey?: string | undefined;
}

export function createNativeDirectExecutor(options: NativeDirectExecutorOptions) {
  return async (
    execInput: ProviderExecutionInput & { readonly rendered: RenderedProviderRequest },
  ) => {
    const context: RequestContext = execInput.context;
    const scopedClient = new KernelDirectConnectorClient(options.connectors, context);
    const endpoint = directEndpoint(options.configuration);
    const limits: BudgetLimits = {
      requestMicros: options.requestBudgetMicros as never,
      taskMicros: options.requestBudgetMicros as never,
      sessionMicros: options.requestBudgetMicros as never,
    };
    const postSse = async (input: {
      headers: Readonly<Record<string, string>>;
      body: Readonly<Record<string, unknown>>;
      signal: AbortSignal | null;
    }): Promise<AsyncIterable<Uint8Array>> => {
      void input.signal; // cancellation rides the grant TTL + stream close
      const headers = { ...input.headers };
      delete (headers as Record<string, string>).authorization;
      return scopedClient.streamRaw({
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.path,
        headers,
        body: JSON.stringify({ ...input.body, stream: true }),
        context,
        credentialBindingId: options.configuration.secretUri,
      });
    };

    if (options.configuration.vendor === "anthropic") {
      return dispatchAnthropic({
        manifestId: `native:${context.idempotencyKey}`,
        economics: options.economics,
        budgetLimits: limits,
        rendered: execInput.rendered,
        signal: null,
        postSse,
      });
    }
    return dispatchOpenAI({
      manifestId: `native:${context.idempotencyKey}`,
      economics: options.economics,
      budgetLimits: limits,
      rendered: execInput.rendered,
      protocol: options.configuration.protocol === "chat_completions" ? "chat_completions" : "responses",
      signal: null,
      postSse,
    });
  };
}

// Re-exports keep the transport-deps helpers discoverable beside their only
// production consumer.
export { anthropicTransportDeps, openaiTransportDeps };
export type { BudgetLimits, Micros };
