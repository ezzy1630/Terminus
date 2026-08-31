import type { CapabilityCard } from "@terminus/aci";
import type { ContentHash } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

const MAX_CAPABILITY_CARDS = 512;
const MAX_CARD_TEXT_CHARS = 1_024;
const MAX_CARD_LIST_ITEMS = 32;
const MAX_CATALOG_COST_TOKENS = 100_000_000;
const MAX_ACTIVATION_LATENCY_MS = 86_400_000;

export type CapabilityDiscoveryCommand =
  | {
      readonly action: "list";
      readonly query?: string | undefined;
      readonly kind?: CapabilityCard["kind"] | undefined;
      readonly cursor: number;
      readonly limit: number;
    }
  | {
      readonly action: "search";
      readonly query: string;
      readonly kind?: CapabilityCard["kind"] | undefined;
      readonly cursor: number;
      readonly limit: number;
    }
  | { readonly action: "describe"; readonly capability_id: string }
  | { readonly action: "activate"; readonly capability_id: string }
  | { readonly action: "deactivate"; readonly capability_id: string }
  | { readonly action: "status" };

export interface CapabilityDiscoveryData {
  readonly action: CapabilityDiscoveryCommand["action"];
  readonly active_tool_set_hash: ContentHash;
  readonly active_capabilities: readonly string[];
  readonly cards?: readonly CapabilityCard[] | undefined;
  readonly target_card?: CapabilityCard | undefined;
  readonly schema_cost_tokens?: number | undefined;
  readonly total_matches?: number | undefined;
  readonly omitted_count?: number | undefined;
  readonly next_cursor?: number | null | undefined;
}

export interface CapabilityDiscoveryExecutionOptions {
  /** Measured by the caller; this module never reads a clock. */
  readonly activationLatencyMs?: number | undefined;
}

/**
 * Opt-in, in-memory counters for one discovery session. This is intentionally
 * not part of CapabilityDiscoveryOutcome, so it cannot add prompt tokens or
 * become a model-visible protocol field.
 */
export interface CapabilityDiscoveryObservationSnapshot {
  readonly admitted_card_count: number;
  readonly admitted_catalog_cost_tokens: number;
  readonly admitted_full_schema_cost_tokens: number;
  readonly initial_active_schema_cost_tokens: number;
  readonly initial_deferred_schema_cost_tokens: number;
  readonly list_attempts: number;
  readonly search_attempts: number;
  readonly describe_attempts: number;
  readonly activate_attempts: number;
  readonly deactivate_attempts: number;
  readonly successful_selections: number;
  readonly failed_selections: number;
  readonly activation_latency_ms_total: number;
  readonly activation_latency_samples: number;
  readonly active_tool_set_hash: ContentHash;
  readonly final_active_schema_cost_tokens: number;
}

export type CapabilityDiscoverySessionOptions =
  | { readonly observe?: false | undefined }
  | {
      /** Allocate the observation counters only when explicitly requested. */
      readonly observe: true;
      /** Tokenizer-derived cost of the compact admitted-card catalog. */
      readonly admittedCatalogCostTokens: number;
    };

interface CapabilityDiscoveryObservationState {
  readonly admitted_card_count: number;
  readonly admitted_catalog_cost_tokens: number;
  readonly admitted_full_schema_cost_tokens: number;
  readonly initial_active_schema_cost_tokens: number;
  readonly initial_deferred_schema_cost_tokens: number;
  list_attempts: number;
  search_attempts: number;
  describe_attempts: number;
  activate_attempts: number;
  deactivate_attempts: number;
  successful_selections: number;
  failed_selections: number;
  activation_latency_ms_total: number;
  activation_latency_samples: number;
}

export type CapabilityDiscoveryOutcome =
  | { readonly ok: true; readonly data: CapabilityDiscoveryData; readonly summary: string }
  | { readonly ok: false; readonly message: string };

export interface CapabilityTransitionEvent {
  readonly eventType: "capability.activated" | "capability.deactivated";
  readonly aggregateType: "turn";
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly payload: {
    readonly capability_id: string;
    readonly provider_call_id: string;
    readonly active_capabilities: readonly string[];
    readonly active_tool_set_hash: ContentHash;
    readonly next_tool_ids: readonly string[];
  };
}

/** Build the durable post-action snapshot paired with a successful result. */
export function capabilityTransitionEvent(input: {
  readonly action: CapabilityDiscoveryCommand["action"] | "activate_workspace";
  readonly capabilityId?: string | undefined;
  readonly turnId: string;
  readonly taskId: string;
  readonly providerCallId: string;
  readonly activeCapabilities: readonly string[];
  readonly activeToolSetHash: ContentHash;
  readonly nextToolIds: readonly string[];
}): CapabilityTransitionEvent | null {
  if (
    input.action !== "activate_workspace"
    && input.action !== "activate"
    && input.action !== "deactivate"
  ) return null;
  const capabilityId = input.action === "activate_workspace" ? "workspace" : input.capabilityId;
  if (capabilityId === undefined || capabilityId.length === 0) {
    throw new Error(`${input.action} capability transition requires an exact capability id`);
  }
  return {
    eventType: input.action === "deactivate" ? "capability.deactivated" : "capability.activated",
    aggregateType: "turn",
    aggregateId: input.turnId,
    correlationId: input.taskId,
    payload: {
      capability_id: capabilityId,
      provider_call_id: input.providerCallId,
      active_capabilities: [...input.activeCapabilities],
      active_tool_set_hash: input.activeToolSetHash,
      next_tool_ids: [...input.nextToolIds],
    },
  };
}

/**
 * Restore the latest exact active-set snapshot emitted after activation or
 * deactivation. Unknown historical capabilities are dropped rather than
 * being granted by a newer binary; malformed events cannot change state.
 */
export function recoverCommittedActiveCapabilityIds(
  initiallyActive: readonly string[],
  payloads: readonly string[],
  admittedCapabilityIds: readonly string[],
): readonly string[] {
  const admitted = new Set(admittedCapabilityIds);
  let active = [...new Set(initiallyActive)];
  for (const payloadJson of payloads) {
    try {
      const payload: unknown = JSON.parse(payloadJson);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      const snapshot = (payload as Readonly<Record<string, unknown>>).active_capabilities;
      if (!Array.isArray(snapshot) || !snapshot.every((value): value is string => typeof value === "string")) {
        continue;
      }
      active = [...new Set(snapshot.filter((capabilityId) => admitted.has(capabilityId)))];
    } catch {
      // Malformed historical events cannot grant capabilities.
    }
  }
  return active.sort();
}

/**
 * Per-turn progressive-disclosure state.
 *
 * Cards are admitted by the caller; this object never discovers ambient
 * files, grants effects, or executes extension code. Activation changes only
 * which already-admitted schemas the next provider request may declare.
 */
export class CapabilityDiscoverySession {
  private readonly cards: ReadonlyMap<string, CapabilityCard>;
  private readonly active = new Set<string>();
  private readonly observation: CapabilityDiscoveryObservationState | null;

  constructor(
    cards: readonly CapabilityCard[],
    initiallyActive: readonly string[],
    options: CapabilityDiscoverySessionOptions = {},
  ) {
    if (cards.length > MAX_CAPABILITY_CARDS) {
      throw new Error(`capability card count exceeds ${MAX_CAPABILITY_CARDS}`);
    }
    const admitted = new Map<string, CapabilityCard>();
    for (const card of cards) {
      validateCard(card);
      if (admitted.has(card.id)) throw new Error(`duplicate capability card '${card.id}'`);
      admitted.set(card.id, card);
    }
    this.cards = admitted;
    for (const capabilityId of initiallyActive) {
      if (!this.cards.has(capabilityId)) {
        throw new Error(`initial capability '${capabilityId}' is not admitted`);
      }
      this.active.add(capabilityId);
    }
    this.observation = options.observe === true
      ? initialObservation(
          [...this.cards.values()],
          this.activeCards(),
          options.admittedCatalogCostTokens,
        )
      : null;
  }

  execute(command: CapabilityDiscoveryCommand): CapabilityDiscoveryOutcome;
  execute(
    command: Extract<CapabilityDiscoveryCommand, { action: "activate" }>,
    options: CapabilityDiscoveryExecutionOptions,
  ): CapabilityDiscoveryOutcome;
  execute(
    command: CapabilityDiscoveryCommand,
    options: CapabilityDiscoveryExecutionOptions = {},
  ): CapabilityDiscoveryOutcome {
    switch (command.action) {
      case "list":
      case "search":
        if (this.observation !== null) {
          if (command.action === "list") {
            this.observation.list_attempts = incrementCounter(
              this.observation.list_attempts,
              "list attempts",
            );
          } else {
            this.observation.search_attempts = incrementCounter(
              this.observation.search_attempts,
              "search attempts",
            );
          }
        }
        return this.list(command);
      case "describe": {
        if (this.observation !== null) {
          this.observation.describe_attempts = incrementCounter(
            this.observation.describe_attempts,
            "describe attempts",
          );
        }
        const card = this.cards.get(command.capability_id);
        if (card === undefined) return missingCapability(command.capability_id);
        return {
          ok: true,
          data: {
            ...this.baseData("describe"),
            target_card: card,
            schema_cost_tokens: card.schemaCostTokens,
          },
          summary: `Capability '${card.id}' is admitted and costs about ${card.schemaCostTokens} schema tokens when active`,
        };
      }
      case "activate": {
        if (this.observation !== null) {
          const latencyMs = options.activationLatencyMs;
          if (
            latencyMs !== undefined
            && (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > MAX_ACTIVATION_LATENCY_MS)
          ) {
            throw new Error(
              `activation latency must be an integer between 0 and ${MAX_ACTIVATION_LATENCY_MS} milliseconds`,
            );
          }
          this.observation.activate_attempts = incrementCounter(
            this.observation.activate_attempts,
            "activate attempts",
          );
          // Selection counts exact-ID activation outcomes. Re-activating an
          // admitted ID is successful even though the active set is unchanged.
          if (latencyMs !== undefined) {
            this.observation.activation_latency_ms_total = checkedAdd(
              this.observation.activation_latency_ms_total,
              latencyMs,
              "activation latency total",
            );
            this.observation.activation_latency_samples = incrementCounter(
              this.observation.activation_latency_samples,
              "activation latency samples",
            );
          }
        }
        const card = this.cards.get(command.capability_id);
        if (card === undefined) {
          if (this.observation !== null) {
            this.observation.failed_selections = incrementCounter(
              this.observation.failed_selections,
              "failed selections",
            );
          }
          return missingCapability(command.capability_id);
        }
        if (this.observation !== null) {
          this.observation.successful_selections = incrementCounter(
            this.observation.successful_selections,
            "successful selections",
          );
        }
        this.active.add(card.id);
        return {
          ok: true,
          data: {
            ...this.baseData("activate"),
            target_card: card,
            schema_cost_tokens: card.schemaCostTokens,
          },
          summary: `Activated capability '${card.id}' for this turn`,
        };
      }
      case "deactivate": {
        if (this.observation !== null) {
          this.observation.deactivate_attempts = incrementCounter(
            this.observation.deactivate_attempts,
            "deactivate attempts",
          );
        }
        const card = this.cards.get(command.capability_id);
        if (card === undefined) return missingCapability(command.capability_id);
        this.active.delete(card.id);
        return {
          ok: true,
          data: {
            ...this.baseData("deactivate"),
            target_card: card,
          },
          summary: `Deactivated capability '${card.id}' for this turn`,
        };
      }
      case "status": {
        const activeCards = this.activeCards();
        return {
          ok: true,
          data: {
            ...this.baseData("status"),
            schema_cost_tokens: activeCards.reduce((total, card) => total + card.schemaCostTokens, 0),
          },
          summary: activeCards.length === 0
            ? "No optional capabilities are active"
            : `Active capabilities: ${activeCards.map((card) => card.id).join(", ")}`,
        };
      }
    }
  }

  activeCapabilityIds(): readonly string[] {
    return [...this.active].sort();
  }

  observationSnapshot(): CapabilityDiscoveryObservationSnapshot | null {
    if (this.observation === null) return null;
    return {
      ...this.observation,
      active_tool_set_hash: this.activeToolSetHash(),
      final_active_schema_cost_tokens: sumSchemaCostTokens(this.activeCards()),
    };
  }

  private list(command: Extract<CapabilityDiscoveryCommand, { action: "list" | "search" }>): CapabilityDiscoveryOutcome {
    const query = command.action === "search" ? command.query : command.query ?? "";
    const matches = [...this.cards.values()]
      .filter((card) => command.kind === undefined || card.kind === command.kind)
      .map((card) => ({ card, score: scoreCard(card, query) }))
      .filter((entry) => query.trim().length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id));
    const page = matches.slice(command.cursor, command.cursor + command.limit).map((entry) => entry.card);
    const nextCursor = command.cursor + page.length < matches.length
      ? command.cursor + page.length
      : null;
    return {
      ok: true,
      data: {
        ...this.baseData(command.action),
        cards: page,
        schema_cost_tokens: page.reduce((total, card) => total + card.schemaCostTokens, 0),
        total_matches: matches.length,
        omitted_count: Math.max(0, matches.length - command.cursor - page.length),
        next_cursor: nextCursor,
      },
      summary: nextCursor === null
        ? `Found ${matches.length} matching capability card${matches.length === 1 ? "" : "s"}`
        : `Returned ${page.length} of ${matches.length} matching capability cards; continue at cursor ${nextCursor}`,
    };
  }

  private baseData(action: CapabilityDiscoveryData["action"]): Pick<
    CapabilityDiscoveryData,
    "action" | "active_tool_set_hash" | "active_capabilities"
  > {
    return {
      action,
      active_tool_set_hash: this.activeToolSetHash(),
      active_capabilities: this.activeCapabilityIds(),
    };
  }

  private activeCards(): readonly CapabilityCard[] {
    return this.activeCapabilityIds().map((capabilityId) => {
      const card = this.cards.get(capabilityId);
      if (card === undefined) throw new Error(`active capability '${capabilityId}' lost its admitted card`);
      return card;
    });
  }

  activeToolSetHash(): ContentHash {
    return computeContentHash(canonicalJson(this.activeCards().map((card) => ({
      id: card.id,
      version: card.version,
      definition_hash: card.definitionHash,
    }))));
  }
}

function initialObservation(
  cards: readonly CapabilityCard[],
  initiallyActiveCards: readonly CapabilityCard[],
  admittedCatalogCostTokens: number,
): CapabilityDiscoveryObservationState {
  if (
    !Number.isSafeInteger(admittedCatalogCostTokens)
    || admittedCatalogCostTokens < 0
    || admittedCatalogCostTokens > MAX_CATALOG_COST_TOKENS
  ) {
    throw new Error(
      `admitted catalog cost must be an integer between 0 and ${MAX_CATALOG_COST_TOKENS} tokens`,
    );
  }
  const admittedSchemaCostTokens = sumSchemaCostTokens(cards);
  const initialActiveSchemaCostTokens = sumSchemaCostTokens(initiallyActiveCards);
  return {
    admitted_card_count: cards.length,
    admitted_catalog_cost_tokens: admittedCatalogCostTokens,
    admitted_full_schema_cost_tokens: admittedSchemaCostTokens,
    initial_active_schema_cost_tokens: initialActiveSchemaCostTokens,
    initial_deferred_schema_cost_tokens: admittedSchemaCostTokens - initialActiveSchemaCostTokens,
    list_attempts: 0,
    search_attempts: 0,
    describe_attempts: 0,
    activate_attempts: 0,
    deactivate_attempts: 0,
    successful_selections: 0,
    failed_selections: 0,
    activation_latency_ms_total: 0,
    activation_latency_samples: 0,
  };
}

function sumSchemaCostTokens(cards: readonly CapabilityCard[]): number {
  return cards.reduce(
    (total, card) => checkedAdd(total, card.schemaCostTokens, "schema token total"),
    0,
  );
}

function incrementCounter(value: number, label: string): number {
  return checkedAdd(value, 1, label);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return result;
}

function missingCapability(capabilityId: string): CapabilityDiscoveryOutcome {
  return {
    ok: false,
    message: `Capability '${capabilityId}' is not admitted. Search capability cards and activate an exact id.`,
  };
}

function validateCard(card: CapabilityCard): void {
  if (card.id.length === 0 || card.id.length > 255 || /[\0\r\n]/.test(card.id)) {
    throw new Error("capability card id is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(card.definitionHash)) {
    throw new Error(`capability card '${card.id}' has an invalid definition hash`);
  }
  for (const [field, value] of [
    ["version", card.version],
    ["name", card.name],
    ["purpose", card.purpose],
  ] as const) {
    if (value.length === 0 || value.length > MAX_CARD_TEXT_CHARS || /[\0\r]/.test(value)) {
      throw new Error(`capability card '${card.id}' has an invalid ${field}`);
    }
  }
  for (const [field, values] of [
    ["effects", card.effects],
    ["useWhen", card.useWhen],
    ["doNotUseWhen", card.doNotUseWhen],
  ] as const) {
    if (values.length > MAX_CARD_LIST_ITEMS || values.some((value) => value.length > MAX_CARD_TEXT_CHARS)) {
      throw new Error(`capability card '${card.id}' has an invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(card.schemaCostTokens) || card.schemaCostTokens < 0) {
    throw new Error(`capability card '${card.id}' has an invalid schema token cost`);
  }
}

function scoreCard(card: CapabilityCard, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 0;
  const terms = [...new Set(normalized.split(/\s+/).filter((term) => term.length > 0))];
  const id = card.id.toLowerCase();
  const name = card.name.toLowerCase();
  const purpose = card.purpose.toLowerCase();
  const secondary = [...card.effects, ...card.useWhen].join(" ").toLowerCase();
  let score = id === normalized || name === normalized ? 100 : 0;
  if (id.includes(normalized) || name.includes(normalized)) score += 30;
  if (purpose.includes(normalized)) score += 20;
  for (const term of terms) {
    if (id.includes(term) || name.includes(term)) score += 8;
    if (purpose.includes(term)) score += 4;
    if (secondary.includes(term)) score += 1;
  }
  return score;
}
