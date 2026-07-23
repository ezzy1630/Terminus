/**
 * @terminus/context-compiler — Context Explanation API (SPEC §33.16).
 *
 * Generates human- and machine-readable explanations of what was sent to
 * a provider, what was omitted and why, selection reasoning, and
 * transformation decisions.
 *
 * The explanation is derived from a ContextManifest — the immutable record
 * of what was selected, omitted, ordered, and rendered.
 */

import type { Uuid7, ContentHash, Rfc3339Timestamp } from "@terminus/domain";
import type {
  ContextFragment,
  ContextManifest,
} from "@terminus/context-ir";

// ──────────────────────── Fragment explanation ───────────────────────────────

export interface FragmentExplanation {
  readonly fragmentId: string;
  readonly kind: string;
  readonly authority: number;
  readonly priority: number;
  readonly exactness: string;
  readonly trust: string;
  readonly confidentiality: string;
  readonly injectionRisk: string;
  readonly sourceUri: string;
  readonly sourceVersion: string | null;
  readonly estimatedTokens: number;
  readonly stale: boolean;
  readonly selected: boolean;
  readonly omissionReason: string | null;
  readonly dependencies: readonly string[];
  readonly scope: {
    readonly workspaceId: string | null;
    readonly taskId: string | null;
    readonly pathPatterns: readonly string[];
  };
}

// ──────────────────────── Manifest explanation ───────────────────────────────

export interface ManifestExplanation {
  readonly manifestId: Uuid7;
  readonly compilerVersion: string;
  readonly model: string;
  readonly epochId: Uuid7;
  readonly createdAt: Rfc3339Timestamp;
  readonly selectedCount: number;
  readonly omittedCount: number;
  readonly totalEstimatedTokens: number;
  readonly outputReserveTokens: number;
  readonly reasoningReserveTokens: number;
  readonly toolResultReserveTokens: number;
  readonly recoveryMarginTokens: number;
  readonly predictedCachedTokens: number;
  readonly cachePlanHash: string;
  readonly selected: readonly FragmentExplanation[];
  readonly omitted: readonly FragmentExplanation[];
  readonly summary: readonly string[];
}

/** Safely extract the first token estimate from a fragment's estimatedTokens map. */
function resolveFirstTokenEstimate(fragment: ContextFragment): number {
  const keys = Object.keys(fragment.estimatedTokens);
  if (keys.length === 0) return 0;
  const firstKey = keys[0];
  if (firstKey === undefined) return 0;
  const record = fragment.estimatedTokens as Readonly<Record<string, number>>;
  return record[firstKey] ?? 0;
}

// ──────────────────────── Explanation generators ─────────────────────────────

/**
 * Explain a single fragment. Returns a FragmentExplanation with all
 * relevant fields laid out for inspection.
 */
export function explainFragment(
  fragment: ContextFragment,
  selected: boolean,
  omissionReason: string | null,
): FragmentExplanation {
  return {
    fragmentId: fragment.id,
    kind: fragment.kind,
    authority: fragment.authority,
    priority: fragment.priority,
    exactness: fragment.exactness,
    trust: fragment.trust,
    confidentiality: fragment.confidentiality,
    injectionRisk: fragment.injectionRisk,
    sourceUri: fragment.source.uri,
    sourceVersion: fragment.sourceVersion,
    estimatedTokens: resolveFirstTokenEstimate(fragment),
    stale: fragment.freshness.stale,
    selected,
    omissionReason,
    dependencies: fragment.dependencies,
    scope: {
      workspaceId: fragment.scope.workspaceId,
      taskId: fragment.scope.taskId,
      pathPatterns: fragment.scope.pathPatterns,
    },
  };
}

/**
 * Explain a full manifest. The caller supplies the selected fragments
 * (which were in the manifest) and any omitted fragments (from the
 * compiler's omits list).
 *
 * Returns a structured explanation with counts, totals, and per-fragment
 * explanations for both selected and omitted fragments.
 */
export function explainManifest(
  manifest: ContextManifest,
  selectedFragments: readonly ContextFragment[],
  omittedFragments: readonly (ContextFragment & { readonly omissionReason: string })[],
): ManifestExplanation {
  const selectedExplanations = selectedFragments.map((frag) =>
    explainFragment(frag, true, null),
  );
  const omittedExplanations = omittedFragments.map((frag) =>
    explainFragment(frag, false, frag.omissionReason),
  );

  const totalEstimatedTokens = selectedFragments.reduce(
    (sum, frag) => {
      const keys = Object.keys(frag.estimatedTokens);
      if (keys.length === 0) return sum;
      return sum + (frag.estimatedTokens as Readonly<Record<string, number>>)[keys[0]!]!;
    },
    0,
  );

  const summary = buildExplanationSummary(
    selectedExplanations,
    omittedExplanations,
    totalEstimatedTokens,
    manifest,
  );

  return {
    manifestId: manifest.id,
    compilerVersion: manifest.compilerVersion,
    model: manifest.model as string,
    epochId: manifest.epochId,
    createdAt: manifest.createdAt,
    selectedCount: selectedFragments.length,
    omittedCount: omittedFragments.length,
    totalEstimatedTokens,
    outputReserveTokens: Number(manifest.outputReserveTokens),
    reasoningReserveTokens: Number(manifest.reasoningReserveTokens),
    toolResultReserveTokens: Number(manifest.toolResultReserveTokens),
    recoveryMarginTokens: Number(manifest.recoveryMarginTokens),
    predictedCachedTokens: Number(manifest.predictedCachedTokens),
    cachePlanHash: manifest.cachePlan.stablePrefixHash as string,
    selected: selectedExplanations,
    omitted: omittedExplanations,
    summary,
  };
}

function buildExplanationSummary(
  selected: readonly FragmentExplanation[],
  omitted: readonly FragmentExplanation[],
  totalTokens: number,
  manifest: ContextManifest,
): readonly string[] {
  const lines: string[] = [];
  lines.push(`# Context Manifest ${manifest.id}`);
  lines.push("");
  lines.push(`## Overview`);
  lines.push(`- Compiler: ${manifest.compilerVersion}`);
  lines.push(`- Model: ${manifest.model as string}`);
  lines.push(`- Epoch: ${manifest.epochId}`);
  lines.push(`- Created: ${manifest.createdAt}`);
  lines.push(`- Selected fragments: ${selected.length}`);
  lines.push(`- Omitted fragments: ${omitted.length}`);
  lines.push(`- Estimated tokens: ${totalTokens}`);
  lines.push(`- Output reserve: ${manifest.outputReserveTokens}`);
  lines.push(`- Reasoning reserve: ${manifest.reasoningReserveTokens}`);
  lines.push("");

  // Breakdown by kind for selected.
  const byKind = new Map<string, number>();
  for (const f of selected) {
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  }
  lines.push("## Selected by kind");
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${kind}: ${count}`);
  }
  lines.push("");

  // Omission reasons summary.
  const byReason = new Map<string, number>();
  for (const f of omitted) {
    const reason = f.omissionReason ?? "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  if (byReason.size > 0) {
    lines.push("## Omission reasons");
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }

  // Confidentiality breakdown.
  const byConf = new Map<string, number>();
  for (const f of selected) {
    byConf.set(f.confidentiality, (byConf.get(f.confidentiality) ?? 0) + 1);
  }
  lines.push("## Confidentiality");
  for (const [conf, count] of [...byConf].sort()) {
    lines.push(`- ${conf}: ${count}`);
  }
  lines.push("");

  // Hard-required fragments.
  const hardRequired = selected.filter((f) => f.authority >= 80);
  if (hardRequired.length > 0) {
    lines.push("## Hard-required fragments");
    for (const f of hardRequired) {
      lines.push(`- ${f.fragmentId} (${f.kind}, authority=${f.authority})`);
    }
  }

  return lines;
}

// ──────────────────────── Explanation as JSON ────────────────────────────────

/**
 * Serialize an explanation to a plain object suitable for JSON output.
 * Useful for CLI tools and API responses.
 */
export function manifestExplanationToRecord(
  explanation: ManifestExplanation,
): Readonly<Record<string, unknown>> {
  return {
    manifestId: explanation.manifestId,
    compilerVersion: explanation.compilerVersion,
    model: explanation.model,
    epochId: explanation.epochId,
    createdAt: explanation.createdAt,
    selectedCount: explanation.selectedCount,
    omittedCount: explanation.omittedCount,
    totalEstimatedTokens: explanation.totalEstimatedTokens,
    outputReserveTokens: explanation.outputReserveTokens,
    reasoningReserveTokens: explanation.reasoningReserveTokens,
    toolResultReserveTokens: explanation.toolResultReserveTokens,
    recoveryMarginTokens: explanation.recoveryMarginTokens,
    predictedCachedTokens: explanation.predictedCachedTokens,
    selected: explanation.selected,
    omitted: explanation.omitted,
  };
}
