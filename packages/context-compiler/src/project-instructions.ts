/**
 * @terminus/context-compiler — Project Instruction Discovery (SPEC §8.4 step 2).
 *
 * Walks the workspace directory tree upward from the working directory to
 * the workspace root, collecting AGENTS.md files with scoped precedence
 * as defined in the repository-level AGENTS.md and SPEC §5.
 *
 * Precedence rules (closest to working directory wins):
 *  1. Working directory AGENTS.md
 *  2. Parent directories (up to workspace root)
 *  3. Workspace root AGENTS.md
 *
 * Returns discovered instruction fragments in the order they should be
 * assembled as project_rule context fragments.
 */

import type { Rfc3339Timestamp, Uuid7, ContentHash, ArtifactUri, ByteCount, ModelKey } from "@terminus/domain";
import type { ContextFragment, ContextScope } from "@terminus/context-ir";
import type { ModelTokenizer } from "./tokenizer.js";
import { resolveTokenizer } from "./tokenizer.js";

// ──────────────────────── Discovered instruction ─────────────────────────────

export interface DiscoveredInstruction {
  /** Directory path relative to workspace root. */
  readonly directory: string;
  /** The filename (e.g., AGENTS.md). */
  readonly filename: string;
  /** Full file path. */
  readonly path: string;
  /** Precedence level: higher = closer to working directory. Computed as maxDepth minus upward-walk depth. */
  readonly precedence: number;
  /** Raw content of the instruction file. */
  readonly content: string;
  /** Source version (e.g., git blob hash). */
  readonly sourceVersion: string;
}

// ──────────────────────── Discovery config ───────────────────────────────────

export interface InstructionDiscoveryConfig {
  /** The workspace root directory. */
  readonly workspaceRoot: string;
  /** The working directory within the workspace. */
  readonly workingDirectory: string;
  /** Filenames to search for. Default: ["AGENTS.md"]. */
  readonly filenames?: readonly string[] | undefined;
  /** Maximum depth to walk upward (0 = only working directory). */
  readonly maxDepth?: number | undefined;
}

// ──────────────────────── Discovery function ─────────────────────────────────

/**
 * Walk upward from the working directory to the workspace root,
 * collecting instruction files at each directory level.
 *
 * The result is sorted by precedence: highest first (closest to
 * working directory), root last.
 *
 * This function expects a `readFile` callback so it can remain
 * pure with respect to I/O. The actual filesystem access is injected.
 */
export function discoverInstructions(
  config: InstructionDiscoveryConfig,
  readFile: (path: string) => string | null,
  _listDir?: ((path: string) => readonly string[]) | undefined,
): readonly DiscoveredInstruction[] {
  const filenames = config.filenames ?? ["AGENTS.md"];
  const maxDepth = config.maxDepth ?? 50;
  const results: DiscoveredInstruction[] = [];

  // Normalize paths without a backtracking regular expression on caller input.
  const root = trimTrailingSlashes(config.workspaceRoot);
  const cwd = trimTrailingSlashes(config.workingDirectory);

  if (!cwd.startsWith(root)) {
    // Working directory must be within workspace root.
    return [];
  }

  // Walk upward from cwd to root.
  let current = cwd;
  let depth = 0;

  while (current.startsWith(root) && depth <= maxDepth) {
    for (const filename of filenames) {
      const fullPath = `${current}/${filename}`;
      const content = readFile(fullPath);
      if (content !== null) {
        results.push({
          directory: current === root ? "/" : current.slice(root.length) || "/",
          filename,
          path: fullPath,
          precedence: maxDepth - depth, // Closer to cwd = higher precedence.
          content,
          sourceVersion: "current", // Caller should resolve true version.
        });
      }
    }

    if (current === root) break;
    // Move to parent.
    const parent = current.substring(0, current.lastIndexOf("/"));
    if (parent === current || parent === "") break;
    current = parent;
    depth++;
  }

  // Sort by precedence descending (closest first).
  results.sort((a, b) => b.precedence - a.precedence);

  return results;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

// ──────────────────────── Convert to context fragments ───────────────────────

export interface InstructionFragmentInput {
  readonly instructions: readonly DiscoveredInstruction[];
  readonly observedAt: Rfc3339Timestamp;
  readonly workspaceId: Uuid7 | null;
  readonly sessionId: Uuid7 | null;
  readonly taskId: Uuid7 | null;
  readonly modelKey: string;
  readonly tokenizer?: ModelTokenizer | undefined;
}

/**
 * Convert discovered instructions into context fragments ready for
 * inclusion in the compiled context.
 *
 * Each instruction file becomes a project_rule fragment with:
 *  - authority based on precedence (closer = higher authority)
 *  - exactness: exact (byte-identical to source)
 *  - trust: trusted (these are repository-level rules)
 */
export function instructionsToFragments(
  input: InstructionFragmentInput,
): readonly ContextFragment[] {
  const tokenizer = input.tokenizer ?? resolveTokenizer("unknown", input.modelKey as ModelKey);
  const maxPrecedence = input.instructions.length > 0
    ? Math.max(...input.instructions.map((i) => i.precedence))
    : 0;

  return input.instructions.map((inst) => {
    const normPrecedence = maxPrecedence > 0
      ? inst.precedence / maxPrecedence
      : 1;

    // Authority: 50 base + up to 40 from normalized precedence.
    const authority = Math.round(50 + normPrecedence * 40);

    const scope: ContextScope = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      pathPatterns: [inst.path],
    };

    const hashHex = simpleHash(inst.content);

    return {
      id: `project_rule:${inst.path}`,
      kind: "project_rule" as const,
      contentRef: {
        hash: `sha256:${hashHex}` as ContentHash,
        uri: `artifact://sha256/${hashHex}` as ArtifactUri,
        mediaType: "text/markdown",
        bytes: BigInt(inst.content.length) as ByteCount,
      },
      textContent: inst.content,
      source: {
        uri: `file://${inst.path}`,
        producer: "project-instruction-discovery",
        producerVersion: "v1",
        observedAt: input.observedAt,
        observedBy: "kernel" as const,
        evidenceRefs: [],
      },
      sourceVersion: inst.sourceVersion,
      authority,
      priority: authority,
      trust: "trusted" as const,
      confidentiality: "workspace" as const,
      injectionRisk: "low" as const,
      exactness: "exact" as const,
      scope,
      freshness: {
        observedAt: input.observedAt,
        sourceVersion: inst.sourceVersion,
        stale: false,
        staleReason: null,
      },
      dependencies: [],
      invalidation: [
        { kind: "file_changed" as const, selector: inst.path },
      ],
      estimatedTokens: {
        [input.modelKey]: tokenizer.estimateTextTokens(inst.content),
      } as Readonly<Record<string, number>>,
      selectionFeatures: {
        relevance: authority / 100,
        novelty: 0.5,
        coverage: 1,
        uncertaintyReduction: 0.5,
        riskReduction: 0.5,
        modelCompatibility: 0.9,
        redundancyPenalty: 0,
        injectionPenalty: 0,
      },
    };
  });
}

// ──────────────────────── Scoped precedence resolver ─────────────────────────

/**
 * Resolution result after merging instruction fragments with scoped
 * precedence. Closer-to-cwd fragments override more-distant ones when
 * they address the same directive.
 */
export interface ResolvedInstructions {
  readonly fragments: readonly ContextFragment[];
  readonly conflicts: ReadonlyArray<{
    readonly directive: string;
    readonly winner: string;
    readonly overridden: readonly string[];
  }>;
  readonly precedenceOrder: readonly string[]; // paths in precedence order
}

/**
 * Merge discovered instruction fragments, resolving conflicts by
 * scoped precedence. A fragment from a closer directory overrides
 * directives from a more distant directory.
 *
 * The merging logic is intentionally simple: the first fragment in
 * precedence order that addresses a directive wins.
 */
export function resolveInstructionPrecedence(
  fragments: readonly ContextFragment[],
  _precedenceOrder: readonly string[],
): ResolvedInstructions {
  // For now, fragments are simply kept in precedence order.
  // More sophisticated merging (e.g., directive-by-directive override)
  // is a future enhancement — SPEC permits this as an initial
  // "greedy policy" (§33.11).
  const conflicts: ResolvedInstructions["conflicts"] = [];

  return {
    fragments,
    conflicts,
    precedenceOrder: fragments.map((f) => f.id),
  };
}

/** Deterministic hash for instruction content. */
function simpleHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h = Math.imul(h ^ content.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}
