import type { CapabilityCard } from "@terminus/aci";
import type { ContentHash } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

const MAX_CAPABILITY_CARDS = 512;
const MAX_CARD_TEXT_CHARS = 1_024;
const MAX_CARD_LIST_ITEMS = 32;

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

export type CapabilityDiscoveryOutcome =
  | { readonly ok: true; readonly data: CapabilityDiscoveryData; readonly summary: string }
  | { readonly ok: false; readonly message: string };

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

  constructor(cards: readonly CapabilityCard[], initiallyActive: readonly string[]) {
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
  }

  execute(command: CapabilityDiscoveryCommand): CapabilityDiscoveryOutcome {
    switch (command.action) {
      case "list":
      case "search":
        return this.list(command);
      case "describe": {
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
        const card = this.cards.get(command.capability_id);
        if (card === undefined) return missingCapability(command.capability_id);
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
