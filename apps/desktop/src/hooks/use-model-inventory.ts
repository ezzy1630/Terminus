/**
 * Terminus Desktop — Provider model discovery.
 *
 * Terminus does not know what models exist. Providers do, and the set changes
 * without Terminus shipping anything, so the composer asks at runtime and
 * renders whatever comes back — including nothing.
 *
 * The renderer deliberately does not speak any provider's own protocol. Per
 * AGENTS.md, first-party code stays independent of specific harnesses and
 * reaches them through the control plane's provider-neutral surface. That
 * keeps one decoder here rather than one per vendor.
 *
 * Until the control plane serves an inventory route this resolves to
 * `unavailable`, which is the honest state: the picker then says no provider
 * has reported models and points at Settings, instead of showing a list
 * Terminus invented.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ModelInventory, ModelOption, Provider } from "../lib/models";

/** Provider-neutral shape the control plane is expected to serve. */
interface WireInventory {
  providers?: unknown;
  models?: unknown;
  /** Why the list is empty or stale, reported by the control plane. */
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function decodeProvider(value: unknown): Provider | null {
  const record = asRecord(value);
  const id = record && asString(record.id);
  if (!record || !id) return null;
  const label = asString(record.label) ?? id;
  return {
    id,
    label,
    // Two letters, derived rather than bundled: Terminus ships no third-party
    // artwork, and a provider discovered at runtime has none to ship anyway.
    mark: (asString(record.mark) ?? (label.replace(/[^a-z]/gi, "").slice(0, 2) || id.slice(0, 2))).toUpperCase(),
    available: record.available !== false,
    ...(asString(record.unavailable_reason) ? { unavailableReason: asString(record.unavailable_reason)! } : {}),
  };
}

function decodeModel(value: unknown): ModelOption | null {
  const record = asRecord(value);
  const id = record && asString(record.id);
  const provider = record && asString(record.provider);
  if (!record || !id || !provider) return null;
  const slug = asString(record.slug) ?? id;
  return {
    id,
    provider,
    label: asString(record.label) ?? slug,
    slug,
    ...(asString(record.note) ? { note: asString(record.note)! } : {}),
    ...(record.free === true ? { free: true } : {}),
    reasoning: record.reasoning === true,
    // Absent or unparseable means the provider did not report a window; the
    // UI then shows none rather than a number nobody stated.
    contextTokens: typeof record.context_tokens === "number" && Number.isFinite(record.context_tokens)
      ? record.context_tokens
      : 0,
    ...(record.tool_calling === true ? { toolCalling: true } : {}),
  };
}

/** Set by the dev mock so design review has something to render. */
declare global {
  interface Window {
    __terminusModelInventory?: WireInventory;
  }
}

export function useModelInventory(): ModelInventory {
  const [state, setState] = useState<{ providers: Provider[]; models: ModelOption[]; status: ModelInventory["status"]; error: string | null }>(
    { providers: [], models: [], status: "loading", error: null },
  );
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const wire: WireInventory = window.__terminusModelInventory
          ?? await api.listProviderModels();
        if (cancelled) return;
        const providers = (Array.isArray(wire.providers) ? wire.providers : [])
          .map(decodeProvider)
          .filter((provider): provider is Provider => provider !== null);
        const models = (Array.isArray(wire.models) ? wire.models : [])
          .map(decodeModel)
          .filter((model): model is ModelOption => model !== null)
          // A model naming a provider that was not reported cannot be shown
          // with a source, and picking it would route somewhere unnamed.
          .filter((model) => providers.some((provider) => provider.id === model.provider));
        const reported = asString((wire as Record<string, unknown>).error);
        setState({
          providers,
          models,
          status: models.length > 0 ? "ready" : "unavailable",
          error: models.length > 0
            ? null
            : reported ?? "No provider has reported any models.",
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          providers: [],
          models: [],
          status: "unavailable",
          error: error instanceof Error ? error.message : "Model inventory is unavailable.",
        });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  return useMemo(() => ({ ...state, refresh }), [refresh, state]);
}
