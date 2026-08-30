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
import { EFFORTS, normalizeEffort } from "../lib/models";
import type { Effort, ModelInventory, ModelOption, Provider, ProviderBilling } from "../lib/models";

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

const BILLINGS: readonly ProviderBilling[] = ["subscription", "free", "paid", "unknown"];

function asBilling(value: unknown): ProviderBilling | null {
  return typeof value === "string" && (BILLINGS as readonly string[]).includes(value)
    ? value as ProviderBilling
    : null;
}

/**
 * The two-letter mark, derived from the label.
 *
 * Terminus ships no third-party artwork, and a provider discovered at runtime
 * has none to ship anyway. Initials of the first two words beat the first two
 * letters for the names these accounts actually have ("OpenCode Zen" → OZ, not
 * OP), and a single-word name falls back to its own first two letters.
 */
export function deriveMark(label: string, fallback: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const initials = words.length >= 2 ? `${words[0]![0]!}${words[1]![0]!}` : (words[0] ?? fallback).slice(0, 2);
  return (initials || fallback.slice(0, 2)).toUpperCase();
}

function decodeProvider(value: unknown): Provider | null {
  const record = asRecord(value);
  const id = record && asString(record.id);
  if (!record || !id) return null;
  const label = asString(record.label) ?? id;
  const billing = asBilling(record.billing);
  return {
    id,
    label,
    mark: (asString(record.mark) ?? deriveMark(label, id)).toUpperCase(),
    available: record.available !== false,
    ...(asString(record.unavailable_reason) ? { unavailableReason: asString(record.unavailable_reason)! } : {}),
    // Account facts, absent on a control plane that predates connected
    // accounts. The picker degrades to an ungrouped-by-billing list rather
    // than labelling a group it was told nothing about.
    ...(asString(record.source) ? { source: asString(record.source)! } : {}),
    ...(billing ? { billing } : {}),
    ...(record.is_default === true ? { isDefault: true } : {}),
  };
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The depths a model accepts, folded into Terminus's four.
 *
 * Providers spell these differently — `minimal`, `xhigh`, `ultra` — and a
 * level nothing here recognises is dropped rather than shown raw: an operator
 * cannot choose sensibly between "xhigh" and "Max" when they are the same
 * thing, and a level Terminus cannot send is a dead row.
 */
function decodeEfforts(value: unknown): readonly Effort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<Effort>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const level = normalizeEffort(entry);
    if (level) seen.add(level);
  }
  return EFFORTS.filter((level) => seen.has(level));
}

function decodeModel(value: unknown): ModelOption | null {
  const record = asRecord(value);
  const id = record && asString(record.id);
  const provider = record && asString(record.provider);
  if (!record || !id || !provider) return null;
  const slug = asString(record.slug) ?? id;
  const efforts = decodeEfforts(record.reasoning_efforts);
  const defaultEffort = typeof record.default_reasoning_effort === "string"
    ? normalizeEffort(record.default_reasoning_effort)
    : null;
  const inputCost = asPositiveNumber(record.input_cost_micros);
  const outputCost = asPositiveNumber(record.output_cost_micros);
  const cachedInputCost = asPositiveNumber(record.cached_input_micros_per_million);
  return {
    id,
    provider,
    label: asString(record.label) ?? slug,
    slug,
    ...(asString(record.note) ? { note: asString(record.note)! } : {}),
    ...(record.free === true ? { free: true } : {}),
    // A model that names reasoning levels reasons, whatever the flag says: the
    // two disagreeing would otherwise hide a depth control the provider has
    // just told us it accepts.
    reasoning: record.reasoning === true || efforts.length > 0,
    // Absent or unparseable means the provider did not report a window; the
    // UI then shows none rather than a number nobody stated.
    contextTokens: typeof record.context_tokens === "number" && Number.isFinite(record.context_tokens)
      ? record.context_tokens
      : 0,
    ...(record.tool_calling === true ? { toolCalling: true } : {}),
    ...(asPositiveNumber(record.output_tokens) === null ? {} : { outputTokens: asPositiveNumber(record.output_tokens)! }),
    ...(record.structured_output === true ? { structuredOutput: true } : {}),
    ...(record.image_input === true ? { imageInput: true } : {}),
    ...(record.parallel_tool_calls === true ? { parallelToolCalls: true } : {}),
    ...(record.reasoning_summaries === true ? { reasoningSummaries: true } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    // A default outside the reported set would put the picker on a row it does
    // not draw, so it is only honoured when the model offers it.
    ...(defaultEffort && (efforts.length === 0 || efforts.includes(defaultEffort))
      ? { defaultEffort }
      : {}),
    ...(inputCost === null ? {} : { inputCostMicros: inputCost }),
    ...(outputCost === null ? {} : { outputCostMicros: outputCost }),
    ...(cachedInputCost === null ? {} : { cachedInputCostMicros: cachedInputCost }),
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
