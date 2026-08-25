/**
 * Deterministic semantic compaction for context candidates.
 *
 * Compaction is deliberately conservative: authority, task contracts,
 * checkpoints, and caller-declared invariants are never summarized. Every
 * compacted claim carries the exact source artifact references, so replay can
 * recover the uncompressed evidence.
 */
import type {
  ArtifactRef,
  ContextFragment,
  ModelKey,
  Rfc3339Timestamp,
  SelectionFeatures,
} from "@terminus/context-ir";
import { computeContentHash } from "@terminus/context-ir";
import type { ModelTokenizer } from "./tokenizer.js";
import { resolveTokenizer } from "./tokenizer.js";

export interface CompactionInvariant {
  readonly id: string;
  readonly statement: string;
  readonly evidenceFragmentIds: readonly string[];
}

export interface CompactionTransform {
  readonly outputFragmentId: string;
  readonly inputFragmentIds: readonly string[];
  readonly lossPolicy: "recoverable_by_reference";
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

export interface SemanticCompactionInput {
  readonly fragments: readonly ContextFragment[];
  readonly modelKey: ModelKey;
  readonly targetTokens: number;
  readonly invariants?: readonly CompactionInvariant[] | undefined;
  readonly observedAt: Rfc3339Timestamp;
  readonly tokenizer?: ModelTokenizer | undefined;
}

export interface SemanticCompactionResult {
  readonly fragments: readonly ContextFragment[];
  readonly transforms: readonly CompactionTransform[];
  readonly preservedInvariantIds: readonly string[];
}

export function compactContext(
  input: SemanticCompactionInput,
): SemanticCompactionResult {
  const invariants = input.invariants ?? [];
  const invariantEvidenceIds = new Set(
    invariants.flatMap((invariant) => invariant.evidenceFragmentIds),
  );
  const protectedFragments = input.fragments.filter((fragment) =>
    fragment.authority >= 80
    || fragment.kind === "authority"
    || fragment.kind === "project_rule"
    || fragment.kind === "task_contract"
    || fragment.kind === "checkpoint"
    || invariantEvidenceIds.has(fragment.id)
    || isToolEpisodeFragment(fragment),
  );
  const inputFragmentIds = new Set(input.fragments.map((fragment) => fragment.id));
  const preservedInvariantIds = invariants
    .filter((invariant) => invariant.evidenceFragmentIds.every((id) => inputFragmentIds.has(id)))
    .map((invariant) => invariant.id);
  const optionalFragments = input.fragments.filter((fragment) => !protectedFragments.includes(fragment));
  const tokenizer = input.tokenizer ?? resolveTokenizer("unknown", input.modelKey);
  const optionalTokens = optionalFragments.reduce(
    (sum, fragment) => sum + (
      fragment.estimatedTokens[input.modelKey]
      ?? tokenizer.estimateFragmentTokens(fragment).totalTokens
    ),
    0,
  );
  if (optionalFragments.length < 2 || optionalTokens <= input.targetTokens) {
    return {
      fragments: input.fragments,
      transforms: [],
      preservedInvariantIds,
    };
  }

  const grouped = new Map<ContextFragment["kind"], ContextFragment[]>();
  for (const fragment of optionalFragments) {
    const group = grouped.get(fragment.kind) ?? [];
    group.push(fragment);
    grouped.set(fragment.kind, group);
  }

  const outputIdByInputId = new Map<string, string>();
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const outputId = `compacted:${group[0]!.kind}:${computeContentHash(group.map((fragment) => fragment.id).join("\n")).slice(-16)}`;
    for (const fragment of group) outputIdByInputId.set(fragment.id, outputId);
  }

  const compacted: ContextFragment[] = [...protectedFragments];
  const transforms: CompactionTransform[] = [];
  for (const [kind, group] of grouped) {
    if (group.length === 1) {
      compacted.push(group[0]!);
      continue;
    }
    const outputFragmentId = outputIdByInputId.get(group[0]!.id)!;
    const summary = buildSummary(kind, group);
    const first = group[0]!;
    const evidenceRefs = uniqueArtifactRefs(group.flatMap((fragment) => [
      fragment.contentRef,
      ...fragment.source.evidenceRefs,
    ]));
    const compactedFragment: ContextFragment = {
      id: outputFragmentId,
      kind,
      contentRef: textArtifactRef(summary),
      textContent: summary,
      source: {
        uri: `context://compaction/${kind}`,
        producer: "semantic-compactor",
        producerVersion: "v1",
        observedAt: input.observedAt,
        observedBy: "control",
        evidenceRefs,
      },
      sourceVersion: computeContentHash(group.map((fragment) => fragment.sourceVersion ?? "").join("\n")),
      authority: Math.max(...group.map((fragment) => fragment.authority)),
      priority: Math.max(...group.map((fragment) => fragment.priority)),
      trust: group.some((fragment) => fragment.trust === "untrusted") ? "untrusted" : "derived",
      confidentiality: highestConfidentiality(group),
      injectionRisk: highestInjectionRisk(group),
      exactness: "recoverable_by_reference",
      scope: first.scope,
      freshness: {
        observedAt: input.observedAt,
        sourceVersion: null,
        stale: false,
        staleReason: null,
      },
      dependencies: [...new Set(
        group
          .flatMap((fragment) => fragment.dependencies)
          .map((dependencyId) => outputIdByInputId.get(dependencyId) ?? dependencyId)
          .filter((dependencyId) => dependencyId !== outputFragmentId),
      )],
      invalidation: [...new Map(group.flatMap((fragment) => fragment.invalidation.map((rule) => [
        `${rule.kind}:${rule.selector}`,
        rule,
      ]))).values()],
      estimatedTokens: { [input.modelKey]: tokenizer.estimateTextTokens(summary) },
      selectionFeatures: mergeFeatures(group),
    };
    compacted.push(compactedFragment);
    transforms.push({
      outputFragmentId,
      inputFragmentIds: group.map((fragment) => fragment.id),
      lossPolicy: "recoverable_by_reference",
      evidenceRefs: evidenceRefs.map((ref) => ref.hash),
      reason: `compacted ${group.length} ${kind} fragments into a recoverable summary`,
    });
  }

  return {
    fragments: compacted,
    transforms,
    preservedInvariantIds,
  };
}

function isToolEpisodeFragment(fragment: ContextFragment): boolean {
  return fragment.kind === "tool_result"
    || fragment.id.includes(":tool_call")
    || fragment.id.includes(":tool_result");
}

function buildSummary(kind: ContextFragment["kind"], fragments: readonly ContextFragment[]): string {
  const lines = [`# Compacted ${kind} context`];
  for (const fragment of fragments) {
    const source = fragment.textContent ?? fragment.contentRef.uri;
    const firstLine = source.split("\n").find((line) => line.trim().length > 0) ?? source;
    lines.push(`- ${fragment.id}: ${firstLine.trim()} [evidence: ${fragment.contentRef.hash}]`);
  }
  return lines.join("\n");
}

function textArtifactRef(text: string): ArtifactRef {
  const hash = computeContentHash(text);
  return {
    hash,
    uri: `artifact://sha256/${hash.slice("sha256:".length)}` as ContextFragment["contentRef"]["uri"],
    mediaType: "text/plain",
    bytes: BigInt(new TextEncoder().encode(text).byteLength) as ContextFragment["contentRef"]["bytes"],
  };
}

function uniqueArtifactRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const byHash = new Map<string, ArtifactRef>();
  for (const ref of refs) byHash.set(ref.hash, ref);
  return [...byHash.values()];
}

function mergeFeatures(fragments: readonly ContextFragment[]): SelectionFeatures {
  const average = (selector: (features: SelectionFeatures) => number): number =>
    fragments.reduce((sum, fragment) => sum + selector(fragment.selectionFeatures), 0) / fragments.length;
  return {
    relevance: average((features) => features.relevance),
    novelty: average((features) => features.novelty),
    coverage: average((features) => features.coverage),
    uncertaintyReduction: average((features) => features.uncertaintyReduction),
    riskReduction: average((features) => features.riskReduction),
    modelCompatibility: average((features) => features.modelCompatibility),
    redundancyPenalty: average((features) => features.redundancyPenalty),
    injectionPenalty: average((features) => features.injectionPenalty),
  };
}

function highestConfidentiality(fragments: readonly ContextFragment[]): ContextFragment["confidentiality"] {
  const order = ["public", "workspace", "secret_adjacent", "secret"] as const;
  return fragments.reduce((highest, fragment) =>
    order.indexOf(fragment.confidentiality) > order.indexOf(highest) ? fragment.confidentiality : highest,
    "public" as ContextFragment["confidentiality"],
  );
}

function highestInjectionRisk(fragments: readonly ContextFragment[]): ContextFragment["injectionRisk"] {
  const order = ["none", "low", "medium", "high"] as const;
  return fragments.reduce((highest, fragment) =>
    order.indexOf(fragment.injectionRisk) > order.indexOf(highest) ? fragment.injectionRisk : highest,
    "none" as ContextFragment["injectionRisk"],
  );
}
