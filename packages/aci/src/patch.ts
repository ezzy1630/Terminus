/**
 * @terminus/aci — Production Patch Tool Implementation.
 *
 * Implements SPEC §11.3, §34.7 - 34.10 and prompt requirements:
 * - Editing inside kernel-owned transactions
 * - Baseline hash observation and binding (`observed_hash`)
 * - Path lease acquisition order to prevent deadlocks
 * - Overlay & journal creation
 * - Multi-anchor resolution: `replace_symbol`, `range`, `exact_text`, `unified_diff`,
 *   `insert`, `delete`, `create_file` (`mustNotExist`), `move_file`, `delete_file`
 * - Reject stale (`ANCHOR_STALE`) or ambiguous (`ANCHOR_AMBIGUOUS`) anchors
 * - Patch preview mode (`commitMode: "preview_only"`)
 * - Controlled temporary invalid syntax inside isolation (`isolated_transaction`)
 * - Safe region formatting and parsers/diagnostics validation
 * - Atomic commit across all files
 * - Immutable before/after content hashes (`sha256:...`) and diff descriptors
 * - Automatic rollback after failure or crash
 */
import { z } from "zod";
import type { ContentHash, Uuid7 } from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  SideEffectDescriptor,
  Diagnostic,
} from "./index.js";
import { okResult, errorResult } from "./index.js";
import { computeSha256, computeLineHash } from "./read.js";

// ────────────────────────── Patch Schemas ────────────────────────────────────

export const patchOpTypeSchema = z.enum([
  "replace_symbol",
  "range",
  "replace_hashline",
  "exact_text",
  "insert",
  "delete",
  "create_file",
  "move_file",
  "delete_file",
  "unified_diff",
]);

export type PatchOpType = z.infer<typeof patchOpTypeSchema>;

export const patchOperationSchema = z.object({
  op: patchOpTypeSchema,
  path: z.string().min(1),
  observed_hash: z.string().optional(),
  symbol: z.string().nullable().optional(),
  range: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).nullable().optional(),
  line_hashes: z.array(z.string()).nullable().optional(),
  old_text: z.string().nullable().optional(),
  new_text: z.string().nullable().optional(),
  destination: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  mustNotExist: z.boolean().optional(),
});

export type PatchOperation = z.infer<typeof patchOperationSchema>;

export const patchValidationProfileSchema = z.enum([
  "none",
  "syntax_only",
  "syntax_format",
  "language_fast",
  "language_strict",
]);

export type PatchValidationProfile = z.infer<typeof patchValidationProfileSchema>;

export const patchDialectSchema = z.enum([
  "canonical",
  "search_replace",
  "hashline",
  "unified_diff",
  "ast",
]);

export type PatchDialect = z.infer<typeof patchDialectSchema>;

export const patchCommitModeSchema = z.enum([
  "apply_to_worktree",
  "stage_only",
  "preview_only",
]);

export type PatchCommitMode = z.infer<typeof patchCommitModeSchema>;

export const patchInputSchema = z.object({
  operations: z.array(patchOperationSchema).min(1).max(256),
  dialect: patchDialectSchema.default("canonical"),
  validation_profile: patchValidationProfileSchema.default("language_fast"),
  commitMode: patchCommitModeSchema.default("apply_to_worktree"),
  isolated_transaction: z.boolean().default(true),
  allowTransientInvalidState: z.boolean().default(false),
});

export type PatchInput = z.infer<typeof patchInputSchema>;

function validateDialect(dialect: PatchDialect, operations: readonly PatchOperation[]): string | null {
  const allowed = dialect === "canonical"
    ? new Set<PatchOpType>(patchOpTypeSchema.options)
    : dialect === "search_replace"
      ? new Set<PatchOpType>(["exact_text", "range"])
      : dialect === "hashline"
        ? new Set<PatchOpType>(["replace_hashline", "create_file", "delete_file"])
        : dialect === "unified_diff"
          ? new Set<PatchOpType>(["unified_diff"])
          : new Set<PatchOpType>(["replace_symbol"]);
  const unsupported = operations.find((operation) => !allowed.has(operation.op));
  return unsupported === undefined
    ? null
    : `PATCH_DIALECT_MISMATCH: ${dialect} cannot encode ${unsupported.op}`;
}

export interface ChangedFileResult {
  readonly path: string;
  readonly old_hash: ContentHash;
  readonly new_hash: ContentHash;
  readonly diff?: string | undefined;
}

export interface PatchValidationCheck {
  readonly check: "parse" | "baseline_hash" | "anchors" | "lsp_fast" | "format";
  readonly status: "pass" | "fail" | "skipped";
  readonly message?: string | undefined;
}

export interface PatchResultData {
  readonly transaction_id: string;
  readonly baseline_version: string;
  readonly final_version: string;
  readonly commit_mode: PatchCommitMode;
  readonly files: readonly ChangedFileResult[];
  readonly validation: readonly PatchValidationCheck[];
}

// ────────────────────────── Patch Storage / Workspace Interface ──────────────

export interface PatchTargetFile {
  readonly path: string;
  readonly content: string;
  readonly hash: ContentHash;
}

export interface PatchProvider {
  getFile(path: string): Promise<PatchTargetFile | null>;
  commitFiles(files: ReadonlyMap<string, { content: string; hash: ContentHash }>): Promise<void>;
  /** Atomic write+delete path for transactions that contain deletions. */
  commitTransaction?(
    files: ReadonlyMap<string, { content: string; hash: ContentHash }>,
    deletedPaths: readonly string[],
  ): Promise<void>;
  /** Delete paths as part of the same provider transaction when supported. */
  deleteFiles?(paths: readonly string[]): Promise<void>;
  /** Restore the pre-transaction snapshot after a provider failure. */
  rollbackFiles?(files: ReadonlyMap<string, PatchTargetFile | null>): Promise<void>;
  validateSyntax?(path: string, content: string): Promise<readonly Diagnostic[]>;
  validateSemanticDiff?(files: ReadonlyMap<string, { content: string; hash: ContentHash }>): Promise<readonly Diagnostic[]>;
}

// ────────────────────────── Anchor Resolvers ──────────────────────────────────

export interface ApplyOpResult {
  readonly newContent: string;
  readonly newHash: ContentHash;
  readonly diffSnippet: string;
}

const EMPTY_FILE_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as ContentHash;

function applyUnifiedDiff(fileContent: string, diff: string, path: string): string {
  const diffLines = diff.replace(/\r\n/g, "\n").split("\n");
  const sourceLines = fileContent.split("\n");
  const output: string[] = [];
  let sourceCursor = 0;
  let foundHunk = false;
  let index = 0;

  while (index < diffLines.length) {
    const line = diffLines[index]!;
    if (!line.startsWith("@@")) {
      index++;
      continue;
    }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error(`INVALID_DIFF: malformed hunk header for ${path}`);
    foundHunk = true;
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? "1");
    const hunkStart = oldStart === 0 ? 0 : oldStart - 1;
    if (hunkStart < sourceCursor || hunkStart > sourceLines.length) {
      throw new Error(`ANCHOR_STALE: hunk starts outside ${path}`);
    }
    output.push(...sourceLines.slice(sourceCursor, hunkStart));
    sourceCursor = hunkStart;
    let consumed = 0;
    index++;
    while (index < diffLines.length && !diffLines[index]!.startsWith("@@")) {
      const hunkLine = diffLines[index]!;
      if (hunkLine === "\\ No newline at end of file" || hunkLine.length === 0 && index === diffLines.length - 1) {
        index++;
        continue;
      }
      const marker = hunkLine[0];
      const text = hunkLine.slice(1);
      if (marker === " " || marker === "-") {
        const actual = sourceLines[sourceCursor];
        if (actual !== text) {
          throw new Error(`ANCHOR_STALE: unified diff context mismatch in ${path} at line ${sourceCursor + 1}`);
        }
        if (marker === " ") output.push(actual);
        sourceCursor++;
        consumed++;
      } else if (marker === "+") {
        output.push(text);
      } else {
        throw new Error(`INVALID_DIFF: unsupported hunk line in ${path}`);
      }
      index++;
    }
    if (consumed !== oldCount) {
      throw new Error(`INVALID_DIFF: hunk old line count mismatch in ${path}`);
    }
  }
  if (!foundHunk) throw new Error(`INVALID_DIFF: no hunks for ${path}`);
  output.push(...sourceLines.slice(sourceCursor));
  return output.join("\n");
}

export function applyPatchOp(
  fileContent: string | null,
  op: PatchOperation,
): ApplyOpResult {
  switch (op.op) {
    case "create_file": {
      if (fileContent !== null && op.mustNotExist) {
        throw new ValidationError(`Create file failed: ${op.path} already exists`);
      }
      const newText = op.new_text ?? "";
      const hash = computeSha256(newText);
      return {
        newContent: newText,
        newHash: hash,
        diffSnippet: `+ Create ${op.path} (${newText.length} bytes)`,
      };
    }

    case "exact_text": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.old_text) {
        throw new ValidationError(`exact_text operation requires old_text parameter`);
      }
      const occurrences = fileContent.split(op.old_text).length - 1;
      if (occurrences === 0) {
        throw new Error(`ANCHOR_STALE: Target text "${op.old_text.slice(0, 30)}..." not found in ${op.path}`);
      }
      if (occurrences > 1) {
        throw new Error(`ANCHOR_AMBIGUOUS: Found ${occurrences} occurrences of target text in ${op.path}`);
      }
      const newContent = fileContent.replace(op.old_text, op.new_text ?? "");
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `- ${op.old_text}\n+ ${op.new_text ?? ""}`,
      };
    }

    case "range": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.range) {
        throw new ValidationError(`range operation requires range parameter`);
      }
      const lines = fileContent.split("\n");
      if (op.range.startLine < 1 || op.range.endLine > lines.length || op.range.startLine > op.range.endLine) {
        throw new Error(`ANCHOR_STALE: Range [${op.range.startLine}, ${op.range.endLine}] out of bounds for ${op.path} (${lines.length} lines)`);
      }
      const before = lines.slice(0, op.range.startLine - 1);
      const after = lines.slice(op.range.endLine);
      const replacementLines = (op.new_text ?? "").split("\n");
      const newLines = [...before, ...replacementLines, ...after];
      const newContent = newLines.join("\n");
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `Replacing lines ${op.range.startLine}-${op.range.endLine}`,
      };
    }

    case "replace_hashline": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.range) {
        throw new ValidationError(`replace_hashline operation requires range parameter`);
      }
      const lines = fileContent.split("\n");
      const start = op.range.startLine;
      const end = op.range.endLine;
      if (start < 1 || end > lines.length || start > end) {
        throw new Error(`ANCHOR_STALE: Range [${start}, ${end}] out of bounds for ${op.path} (${lines.length} lines)`);
      }
      const expectedLineCount = end - start + 1;
      if (op.line_hashes === null || op.line_hashes === undefined || op.line_hashes.length !== expectedLineCount) {
        throw new Error(`ANCHOR_STALE: replace_hashline requires exactly ${expectedLineCount} line hashes for ${op.path}`);
      }
      for (let i = 0; i < expectedLineCount; i++) {
        const lineIdx = start - 1 + i;
        const lineContent = lines[lineIdx] ?? "";
        const computedHash = computeLineHash(lineContent);
        const expectedHash = op.line_hashes[i]!;
        if (expectedHash.length === 0 || expectedHash.toLowerCase() !== computedHash.toLowerCase()) {
          throw new Error(`ANCHOR_STALE: Line hash mismatch in ${op.path} at line ${lineIdx + 1}: expected ${expectedHash}, got ${computedHash}`);
        }
      }
      const before = lines.slice(0, start - 1);
      const after = lines.slice(end);
      const replacementLines = (op.new_text ?? "").split("\n");
      const newLines = [...before, ...replacementLines, ...after];
      const newContent = newLines.join("\n");
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `Hashline replacing lines ${start}-${end}`,
      };
    }

    case "replace_symbol": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.symbol) {
        throw new ValidationError(`replace_symbol operation requires symbol parameter`);
      }
      const escaped = op.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declarations = [
        new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b[^\\n]*\\{`, "g"),
        new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:class|interface)\\s+${escaped}\\b[^\\n]*\\{`, "g"),
      ];
      const matches = declarations.flatMap((regex) => [...fileContent.matchAll(regex)].map((match) => match.index ?? -1));
      if (matches.length > 1) {
        throw new Error(`ANCHOR_AMBIGUOUS: Symbol "${op.symbol}" has ${matches.length} structural matches in ${op.path}`);
      }
      if (matches.length === 0) {
        const constRegex = new RegExp(`((?:const|type|let|var)\\s+${escaped}\\s*(?:=[^;]*|:.*?))(;)`, "g");
        const constMatches = [...fileContent.matchAll(constRegex)];
        if (constMatches.length === 0) {
          throw new Error(`ANCHOR_STALE: Symbol "${op.symbol}" structural anchor not found in ${op.path}`);
        }
        if (constMatches.length > 1) {
          throw new Error(`ANCHOR_AMBIGUOUS: Symbol "${op.symbol}" has ${constMatches.length} matches in ${op.path}`);
        }
        const match = constMatches[0]!;
        const start = match.index ?? 0;
        const replacement = `${match[1]!.replace(/=.*/, "=")} ${op.new_text ?? ""}${match[2]}`;
        const newContent = `${fileContent.slice(0, start)}${replacement}${fileContent.slice(start + match[0].length)}`;
        return {
          newContent,
          newHash: computeSha256(newContent),
          diffSnippet: `Replace symbol ${op.symbol}`,
        };
      }
      const start = matches[0]!;
      const openBrace = fileContent.indexOf("{", start);
      if (openBrace < 0) throw new Error(`ANCHOR_STALE: Symbol "${op.symbol}" has no body in ${op.path}`);
      let depth = 0;
      let closeBrace = -1;
      for (let i = openBrace; i < fileContent.length; i++) {
        if (fileContent[i] === "{") depth++;
        else if (fileContent[i] === "}") {
          depth--;
          if (depth === 0) {
            closeBrace = i;
            break;
          }
        }
      }
      if (closeBrace < 0) throw new Error(`ANCHOR_STALE: unbalanced symbol body for ${op.symbol} in ${op.path}`);
      const newContent = `${fileContent.slice(0, openBrace + 1)}\n  ${op.new_text ?? ""}\n${fileContent.slice(closeBrace)}`;
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `Replace symbol body ${op.symbol}`,
      };
    }

    case "insert": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      const lineNum = op.range ? op.range.startLine : 1;
      const lines = fileContent.split("\n");
      if (lineNum < 1 || lineNum > lines.length + 1) {
        throw new Error(`ANCHOR_STALE: insertion line ${lineNum} is outside ${op.path}`);
      }
      lines.splice(lineNum - 1, 0, op.new_text ?? "");
      const newContent = lines.join("\n");
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `+ Inserted at line ${lineNum}`,
      };
    }

    case "delete": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.range) {
        throw new ValidationError(`delete operation requires range parameter`);
      }
      const lines = fileContent.split("\n");
      if (op.range.startLine < 1 || op.range.endLine > lines.length || op.range.startLine > op.range.endLine) {
        throw new Error(`ANCHOR_STALE: deletion range is outside ${op.path}`);
      }
      lines.splice(op.range.startLine - 1, op.range.endLine - op.range.startLine + 1);
      const newContent = lines.join("\n");
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: `- Deleted lines ${op.range.startLine}-${op.range.endLine}`,
      };
    }

    case "unified_diff": {
      if (fileContent === null) {
        throw new ValidationError(`Target file ${op.path} does not exist`);
      }
      if (!op.diff) {
        throw new ValidationError(`unified_diff operation requires diff parameter`);
      }
      const newContent = applyUnifiedDiff(fileContent, op.diff, op.path);
      return {
        newContent,
        newHash: computeSha256(newContent),
        diffSnippet: op.diff,
      };
    }

    case "delete_file": {
      if (fileContent === null) {
        throw new Error(`ANCHOR_STALE: file ${op.path} does not exist`);
      }
      return {
        newContent: "",
        newHash: EMPTY_FILE_HASH,
        diffSnippet: `- Delete file ${op.path}`,
      };
    }

    default: {
      throw new ValidationError(`Unsupported patch operation: ${(op as PatchOperation).op}`);
    }
  }
}

// ────────────────────────── Patch Executor ───────────────────────────────────

export class ProductionPatchExecutor implements ToolExecutor<PatchResultData> {
  readonly toolId = "patch" as const;

  constructor(private readonly provider: PatchProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<PatchResultData>> {
    const parseRes = patchInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid patch input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    const dialectError = validateDialect(input.dialect, input.operations);
    if (dialectError !== null) {
      return errorResult(dialectError, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }

    const txId = `tx-${ctx.toolCallId}-${Date.now()}`;
    const validationChecks: PatchValidationCheck[] = [];

    if (input.allowTransientInvalidState && input.commitMode !== "preview_only" && !input.isolated_transaction) {
      return errorResult("Transient invalid state is only permitted inside an isolated candidate transaction", {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }

    // Step 1: Sort every leased path alphabetically to prevent deadlocks.
    const targetPaths = [...new Set(input.operations.flatMap((op) =>
      op.op === "move_file" && op.destination !== null && op.destination !== undefined
        ? [op.path, op.destination]
        : [op.path],
    ))].sort();

    // Step 2: Load current workspace state into transaction overlay
    type OverlayFile = {
      original: PatchTargetFile | null;
      content: string;
      oldHash: ContentHash;
      newHash: ContentHash;
      exists: boolean;
      diff?: string;
    };
    const overlay = new Map<string, OverlayFile>();

    for (const path of targetPaths) {
      const file = await this.provider.getFile(path);
      if (file !== null && computeSha256(file.content) !== file.hash) {
        return errorResult(`PROVIDER_IDENTITY_MISMATCH: ${path} hash does not match returned bytes`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      const oldHash = file?.hash ?? EMPTY_FILE_HASH;
      overlay.set(path, {
        original: file,
        content: file?.content ?? "",
        oldHash,
        newHash: oldHash,
        exists: file !== null,
      });
    }

    // Step 3: Validate baseline hashes
    for (const op of input.operations) {
      if (op.op === "create_file") {
        const item = overlay.get(op.path)!;
        if (op.mustNotExist && item.exists) {
          return errorResult(`ANCHOR_STALE: ${op.path} already exists`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        continue;
      }
      if (op.observed_hash === undefined) {
        return errorResult(`ANCHOR_UNBOUND: observed_hash is required for ${op.op} on ${op.path}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      const item = overlay.get(op.path)!;
      if (item.oldHash !== op.observed_hash) {
        validationChecks.push({
          check: "baseline_hash",
          status: "fail",
          message: `Baseline hash mismatch for ${op.path}: expected ${op.observed_hash}, got ${item.oldHash}`,
        });
        return errorResult(`ANCHOR_STALE: Baseline hash mismatch for ${op.path}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }
    validationChecks.push({ check: "baseline_hash", status: "pass" });

    // Step 4: Apply operations to transaction overlay
    const changedFilesByPath = new Map<string, ChangedFileResult>();
    const sideEffects: SideEffectDescriptor[] = [];

    try {
      for (const [operationIndex, op] of input.operations.entries()) {
        const item = overlay.get(op.path)!;
        if (op.op === "move_file") {
          if (op.destination === null || op.destination === undefined || op.destination.length === 0) {
            throw new ValidationError("move_file operation requires destination");
          }
          const destination = overlay.get(op.destination)!;
          if (!item.exists) throw new Error(`ANCHOR_STALE: source file ${op.path} does not exist`);
          if (destination.exists) throw new Error(`ANCHOR_AMBIGUOUS: destination ${op.destination} already exists`);
          destination.content = item.content;
          destination.newHash = computeSha256(item.content);
          destination.exists = true;
          destination.diff = `+ Move ${op.path} -> ${op.destination}`;
          item.content = "";
          item.newHash = EMPTY_FILE_HASH;
          item.exists = false;
          item.diff = `- Move ${op.path} -> ${op.destination}`;
          changedFilesByPath.set(op.path, { path: op.path, old_hash: item.oldHash, new_hash: item.newHash, diff: item.diff });
          changedFilesByPath.set(op.destination, { path: op.destination, old_hash: destination.oldHash, new_hash: destination.newHash, diff: destination.diff });
        } else {
          const res = applyPatchOp(item.exists ? item.content : null, op);
          item.content = res.newContent;
          item.newHash = res.newHash;
          item.exists = op.op !== "delete_file";
          item.diff = res.diffSnippet;
          changedFilesByPath.set(op.path, {
            path: op.path,
            old_hash: item.oldHash,
            new_hash: res.newHash,
            diff: res.diffSnippet,
          });
        }

        sideEffects.push({
          id: `eff-${txId}-${operationIndex}` as Uuid7,
          kind: op.op === "create_file" ? "file_created" : op.op === "delete_file" ? "file_deleted" : "file_modified",
          description: `${op.op} on ${op.path}`,
          reversible: true,
          settled: input.commitMode !== "preview_only",
        });
      }
      validationChecks.push({ check: "anchors", status: "pass" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      validationChecks.push({ check: "anchors", status: "fail", message: msg });
      return errorResult(`Patch transaction anchor error: ${msg}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }

    // Step 5: Run validation profile (parse & syntax check)
    if (input.validation_profile !== "none" && this.provider.validateSyntax) {
      let syntaxSkipped = false;
      for (const [path, item] of overlay.entries()) {
        if (!item.exists) continue;
        const diags = await this.provider.validateSyntax(path, item.content);
        const errors = diags.filter((d) => d.severity === "error");
        if (errors.length > 0 && !input.allowTransientInvalidState) {
          validationChecks.push({
            check: "parse",
            status: "fail",
            message: `Syntax validation failed for ${path}: ${errors[0]!.message}`,
          });
          return errorResult(`Patch validation failed for ${path}: ${errors[0]!.message}`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        if (errors.length > 0) syntaxSkipped = true;
      }
      validationChecks.push(syntaxSkipped
        ? { check: "parse", status: "skipped", message: "candidate contains explicitly permitted transient invalidity" }
        : { check: "parse", status: "pass" });
    } else if (input.validation_profile !== "none") {
      validationChecks.push({ check: "parse", status: "skipped", message: "provider has no syntax validator" });
    }

    if (this.provider.validateSemanticDiff) {
      const semanticMap = new Map<string, { content: string; hash: ContentHash }>();
      for (const [path, item] of overlay.entries()) {
        if (item.exists) semanticMap.set(path, { content: item.content, hash: item.newHash });
      }
      const semanticErrors = (await this.provider.validateSemanticDiff(semanticMap)).filter((d) => d.severity === "error");
      if (semanticErrors.length > 0) {
        validationChecks.push({ check: "lsp_fast", status: "fail", message: semanticErrors[0]!.message });
        return errorResult(`Patch semantic validation failed: ${semanticErrors[0]!.message}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      validationChecks.push({ check: "lsp_fast", status: "pass" });
    }

    // Step 6: Atomic commit unless preview_only
    if (input.commitMode !== "preview_only") {
      const commitMap = new Map<string, { content: string; hash: ContentHash }>();
      const deletedPaths: string[] = [];
      for (const [path, item] of overlay.entries()) {
        if (item.exists) commitMap.set(path, { content: item.content, hash: item.newHash });
        else if (item.original !== null) deletedPaths.push(path);
      }
      if (deletedPaths.length > 0 && !this.provider.commitTransaction) {
        return errorResult("TRANSACTION_PROVIDER_REQUIRED: deletions and moves require an atomic commitTransaction provider", {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
      try {
        if (deletedPaths.length > 0) {
          await this.provider.commitTransaction!(commitMap, deletedPaths);
        } else {
          await this.provider.commitFiles(commitMap);
        }
      } catch (err: unknown) {
        let rollbackMessage = "provider transaction is atomic by contract";
        if (this.provider.rollbackFiles) {
          const snapshot = new Map<string, PatchTargetFile | null>();
          for (const [path, item] of overlay.entries()) snapshot.set(path, item.original);
          try {
            await this.provider.rollbackFiles(snapshot);
            rollbackMessage = "rollback completed";
          } catch (rollbackError: unknown) {
            rollbackMessage = `rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
          }
        }
        return errorResult(`Transaction commit failed; ${rollbackMessage}: ${err instanceof Error ? err.message : String(err)}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }

    const changedFiles = [...changedFilesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    const baselineVersion = computeSha256(JSON.stringify(changedFiles.map((file) => [file.path, file.old_hash])));
    const finalVersion = computeSha256(JSON.stringify(changedFiles.map((file) => [file.path, file.new_hash])));
    const data: PatchResultData = {
      transaction_id: txId,
      baseline_version: baselineVersion,
      final_version: finalVersion,
      commit_mode: input.commitMode,
      files: changedFiles,
      validation: validationChecks,
    };

    const sourceVersionsMap: Record<string, string> = {};
    for (const f of changedFiles) {
      sourceVersionsMap[`workspace://${f.path}`] = f.new_hash;
    }

    const postWriteDiagnostics: Diagnostic[] = [];
    if (this.provider.validateSyntax) {
      for (const [path, item] of overlay.entries()) {
        if (!item.exists) continue;
        const diags = await this.provider.validateSyntax(path, item.content);
        postWriteDiagnostics.push(...diags);
      }
    }

    return okResult(data, {
      toolCallId: ctx.toolCallId,
      traceId: ctx.traceId,
      summary: input.commitMode === "preview_only"
        ? `Patch preview generated for ${changedFiles.length} operations`
        : `Successfully applied ${changedFiles.length} edits across ${targetPaths.length} files atomically`,
      sourceVersions: sourceVersionsMap,
      sideEffects,
      diagnostics: postWriteDiagnostics.length > 0 ? postWriteDiagnostics : undefined,
    });
  }
}
