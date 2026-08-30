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
import { computeContentHash, type ContextFragment, type ContextScope } from "@terminus/context-ir";
import type { ModelTokenizer } from "./tokenizer.js";
import { estimateMessageTokens, resolveTokenizer } from "./tokenizer.js";

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

export const DEFAULT_INSTRUCTION_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
] as const;

export const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024; // 64 KB

/**
 * Directory segments that can never contribute an instruction file.
 *
 * A discovered instruction becomes a hard-required `project_rule` fragment at
 * authority 80–95: it outranks skills, retrieved content, and everything the
 * model reads with a tool. An AGENTS.md or CLAUDE.md under `node_modules/`,
 * `vendor/`, or `.git/` is third-party text that nobody in this repository
 * wrote, and promoting it hands a dependency author authority over the agent.
 * The exposure is not hypothetical: a vendored OpenCode checkout in this tree
 * ships a 24,684-byte `packages/llm/AGENTS.md`, more than twice the size of
 * the repository's own root AGENTS.md.
 */
export const EXCLUDED_INSTRUCTION_DIRECTORY_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "vendor",
  ".git",
]);

/**
 * True when a path lies under a vendored or version-control directory, and so
 * must not be searched for instruction files. Accepts absolute or
 * repository-relative paths; `.` and `/` are the workspace root.
 */
export function isExcludedInstructionPath(path: string): boolean {
  if (path === "." || path === "/" || path.length === 0) return false;
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => EXCLUDED_INSTRUCTION_DIRECTORY_SEGMENTS.has(segment));
}

export interface InstructionDiscoveryConfig {
  /** The workspace root directory. */
  readonly workspaceRoot: string;
  /** The working directory within the workspace. */
  readonly workingDirectory: string;
  /** Filenames to search for. Default: DEFAULT_INSTRUCTION_FILENAMES. */
  readonly filenames?: readonly string[] | undefined;
  /** Maximum depth to walk upward (0 = only working directory). */
  readonly maxDepth?: number | undefined;
  /** Maximum bytes per instruction file before explicit truncation. */
  readonly maxBytes?: number | undefined;
  /** Resolve an authoritative source version, such as a git blob hash. */
  readonly sourceVersion?: ((path: string, content: string) => string) | undefined;
}

/**
 * Repository-relative directories worth probing for instruction files, given
 * the paths a task touches (its changed files and its contract scope).
 *
 * Only the literal prefix before the first wildcard is enumerated, so `**`
 * collapses to the workspace root. Vendored directories contribute nothing at
 * any depth — see {@link isExcludedInstructionPath}. Absolute paths and
 * anything containing `..` are ignored: a candidate directory must be inside
 * the workspace by construction, not by a later check.
 *
 * The result is ordered shallowest-first so the caller reads the root before
 * the leaves.
 */
export function instructionCandidateDirectories(
  paths: readonly string[],
): readonly string[] {
  const directories = new Set<string>(["."]);
  for (const rawPath of paths) {
    const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.length === 0 || normalized.startsWith("/")) continue;
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.includes("..")) continue;
    if (isExcludedInstructionPath(normalized)) continue;
    const wildcardIndex = segments.findIndex((segment) => /[*?[\]]/.test(segment));
    const prefix = wildcardIndex >= 0
      ? segments.slice(0, wildcardIndex)
      : segments.slice(0, Math.max(segments.length - 1, 0));
    for (let length = 1; length <= prefix.length; length += 1) {
      const directory = prefix.slice(0, length).join("/");
      if (isExcludedInstructionPath(directory)) break;
      directories.add(directory);
    }
  }
  return [...directories].sort((left, right) => {
    const depth = (value: string): number => value === "." ? 0 : value.split("/").length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
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
  const filenames = config.filenames ?? DEFAULT_INSTRUCTION_FILENAMES;
  const maxDepth = config.maxDepth ?? 50;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
  const results: DiscoveredInstruction[] = [];

  // Normalize paths without a backtracking regular expression on caller input.
  const root = trimTrailingSlashes(config.workspaceRoot);
  const cwd = trimTrailingSlashes(config.workingDirectory);
  const isWithinWorkspace = (path: string): boolean =>
    path === root || (root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`));

  if (!isWithinWorkspace(cwd)) {
    // Working directory must be within workspace root.
    return [];
  }

  // Walk upward from cwd to root.
  let current = cwd;
  let depth = 0;

  while (isWithinWorkspace(current) && depth <= maxDepth) {
    // A vendored directory contributes nothing, at any depth. Checked on the
    // path *below* the workspace root so a workspace that itself lives under
    // e.g. `~/vendor/` still discovers its own instructions.
    if (isExcludedInstructionPath(current.slice(root.length))) {
      if (current === root) break;
      const skipParent = current.substring(0, current.lastIndexOf("/"));
      if (skipParent === current || skipParent === "") break;
      current = skipParent;
      depth++;
      continue;
    }
    for (let fileIndex = 0; fileIndex < filenames.length; fileIndex++) {
      const filename = filenames[fileIndex]!;
      const fullPath = `${current}/${filename}`;
      const rawContent = readFile(fullPath);
      if (rawContent !== null) {
        const sourceVersion = config.sourceVersion?.(fullPath, rawContent)
          ?? computeContentHash(rawContent);
        let content = rawContent;
        if (Buffer.byteLength(content, "utf8") > maxBytes) {
          content =
            content.slice(0, maxBytes) +
            `\n\n[TRUNCATION: Project instruction file exceeded ${maxBytes} bytes; remaining content elided]\n`;
        }
        results.push({
          directory: current === root ? "/" : current.slice(root.length) || "/",
          filename,
          path: fullPath,
          precedence: (maxDepth - depth) * 100 + (filenames.length - fileIndex),
          content,
          sourceVersion,
        });
        if (filename === "AGENTS.override.md") {
          // AGENTS.override.md takes complete precedence at this level
          break;
        }
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

    // Repository instructions are hard-required context, below platform
    // authority but above optional retrieved content. Precedence still keeps
    // closer scopes ahead of parent scopes when the budget is tight.
    const authority = Math.round(80 + normPrecedence * 15);

    const scope: ContextScope = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      pathPatterns: [inst.directory === "/" ? "**" : `${inst.directory.replace(/^\//, "")}/**`],
    };

    const contentHash = computeContentHash(inst.content);

    return {
      id: `project_rule:${inst.path}`,
      kind: "project_rule" as const,
      contentRef: {
        hash: contentHash,
        uri: `artifact://sha256/${contentHash.slice("sha256:".length)}` as ArtifactUri,
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
        [input.modelKey]: estimateMessageTokens(tokenizer, inst.content),
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
  precedenceOrder: readonly string[],
): ResolvedInstructions {
  const order = new Map(precedenceOrder.map((id, index) => [id, index]));
  const rankFor = (fragment: ContextFragment): number => {
    const sourceUri = fragment.source.uri;
    const sourcePath = sourceUri.startsWith("file://") ? sourceUri.slice("file://".length) : sourceUri;
    return Math.min(
      order.get(fragment.id) ?? Number.MAX_SAFE_INTEGER,
      order.get(sourceUri) ?? Number.MAX_SAFE_INTEGER,
      order.get(sourcePath) ?? Number.MAX_SAFE_INTEGER,
    );
  };
  const ordered = [...fragments].sort((a, b) => {
    const aOrder = rankFor(a);
    const bOrder = rankFor(b);
    return aOrder - bOrder || a.id.localeCompare(b.id);
  });
  const winners = new Map<string, { readonly fragment: ContextFragment; readonly line: string }>();
  const overridden = new Map<string, string[]>();
  const linesByFragment = new Map<string, readonly string[]>();
  for (const fragment of ordered) {
    const lines = (fragment.textContent ?? "").split("\n");
    linesByFragment.set(fragment.id, lines);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const key = instructionDirectiveKey(trimmed);
      const previous = winners.get(key);
      if (previous === undefined) {
        winners.set(key, { fragment, line: trimmed });
        continue;
      }
      if (previous.fragment.id === fragment.id && previous.line === trimmed) {
        continue;
      }
      const ids = overridden.get(key) ?? [];
      if (!ids.includes(previous.fragment.id)) ids.push(previous.fragment.id);
      overridden.set(key, ids);
    }
  }

  const conflicts: Array<ResolvedInstructions["conflicts"][number]> = [];
  for (const [directive, overriddenIds] of overridden) {
    const winner = winners.get(directive);
    if (winner !== undefined) {
      conflicts.push({
        directive,
        winner: winner.fragment.id,
        overridden: overriddenIds,
      });
    }
  }
  conflicts.sort((a, b) => a.directive.localeCompare(b.directive));
  const resolved = ordered.map((fragment) => {
    const lines = (linesByFragment.get(fragment.id) ?? []).filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      const winner = winners.get(instructionDirectiveKey(trimmed));
      return winner?.fragment.id === fragment.id && winner.line === trimmed;
    });
    if (lines.length === 0 || lines.every((line) => line.trim().length === 0)) return null;
    const text = lines.join("\n");
    if (text === fragment.textContent) return fragment;
    const contentHash = computeContentHash(text);
    return {
      ...fragment,
      contentRef: {
        ...fragment.contentRef,
        hash: contentHash,
        bytes: BigInt(new TextEncoder().encode(text).byteLength) as typeof fragment.contentRef.bytes,
      },
      textContent: text,
      sourceVersion: fragment.sourceVersion,
      freshness: fragment.freshness,
    };
  }).filter((fragment): fragment is ContextFragment => fragment !== null);

  return {
    fragments: resolved,
    conflicts,
    precedenceOrder: ordered.map((f) => f.id),
  };
}

function instructionDirectiveKey(line: string): string {
  const withoutMarker = line.replace(/^(?:[-*+]\s+|\[[ xX]\]\s+)/, "");
  const colon = withoutMarker.indexOf(":");
  if (colon > 0) return withoutMarker.slice(0, colon).trim().toLowerCase();
  return withoutMarker.toLowerCase();
}
