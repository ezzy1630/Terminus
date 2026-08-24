/**
 * Terminus Desktop — apply a model choice to the runtime.
 *
 * Turns are routed by the gateway provider configuration, which the control
 * plane reads on every turn (`configuredGatewayModel`). There is no per-turn
 * model field, so choosing a model in the composer means updating that single
 * durable record — the same one Settings edits by hand.
 *
 * Two things travel with the model and must not be left stale: `free_model`
 * and `tools_enabled` describe the model, not the operator's preference, and a
 * mismatch there feeds wrong cost accounting and wrong tool admission. They are
 * taken from the discovered model rather than carried over.
 *
 * Writes are optimistic-concurrency guarded by `expected_revision`. On a
 * conflict the configuration is re-read once and retried, because the common
 * cause is Settings and the composer touching the same row.
 */
import { useCallback, useRef, useState } from "react";
import { api, createIdempotencyKey, TerminusApiError } from "../lib/api";
import type { ModelOption } from "../lib/models";
import type { GatewayProviderConfigurationResponse } from "../types";

export type RoutingStatus = "idle" | "applying" | "error";

export interface ModelRouting {
  status: RoutingStatus;
  error: string | null;
  apply: (model: ModelOption) => Promise<void>;
}

/**
 * The configuration is read on first use rather than on mount. The composer
 * mounts on every surface, but a model is only ever applied by an explicit
 * choice, so fetching eagerly spent a request per mount to prepare for
 * something that usually never happens.
 */
export function useModelRouting(): ModelRouting {
  const [status, setStatus] = useState<RoutingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const configuration = useRef<GatewayProviderConfigurationResponse | null>(null);

  const write = useCallback(async (model: ModelOption, revision: number): Promise<GatewayProviderConfigurationResponse> => {
    const current = configuration.current?.configuration;
    if (!current) throw new Error("No OpenCode gateway is configured.");
    return api.putGatewayProviderConfiguration({
      deployment: current.deployment,
      protocol: current.protocol,
      model: model.slug,
      tools_enabled: model.toolCalling ?? current.tools_enabled,
      free_model: model.free ?? false,
      workspace_access: current.workspace_access,
      expected_revision: revision,
    }, { idempotencyKey: createIdempotencyKey(`gateway-model:${model.id}:${revision}`) });
  }, []);

  const apply = useCallback(async (model: ModelOption): Promise<void> => {
    setStatus("applying");
    setError(null);
    try {
      let response = configuration.current;
      if (response === null || !response.configured || response.configuration === null) {
        response = await api.getGatewayProviderConfiguration();
        configuration.current = response;
      }
      if (response.configuration === null) throw new Error("No OpenCode gateway is configured.");

      try {
        configuration.current = await write(model, response.configuration.revision);
      } catch (conflict) {
        // Someone else moved the row. Re-read and apply once against the
        // current revision; a second conflict is a real contention problem
        // and is surfaced rather than retried in a loop.
        if (!(conflict instanceof TerminusApiError) || conflict.status !== 409) throw conflict;
        const fresh = await api.getGatewayProviderConfiguration();
        configuration.current = fresh;
        if (fresh.configuration === null) throw conflict;
        configuration.current = await write(model, fresh.configuration.revision);
      }
      setStatus("idle");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't apply the model.");
      setStatus("error");
    }
  }, [write]);

  return { status, error, apply };
}
