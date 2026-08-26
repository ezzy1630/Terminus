/**
 * @terminus/permissions — declarative tool permission engine (ADR-0045).
 *
 * Semantics:
 * - Rules are ordered; the LAST matching rule wins.
 * - `*` and `**` match any character sequence including `/` and spaces
 *   (subjects are frequently command lines, not paths).
 * - No matching rule ⇒ the configured default, which is `ask` unless the
 *   caller explicitly loosens it. Fail closed by default.
 * - Interactive approvals are remembered through an injected port:
 *   `always` grants persist until cleared; `once` grants are consumed by
 *   the first evaluation they admit.
 */

import { z } from "zod";

// ────────────────────────────── Types ──────────────────────────────

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** Tool id the rule applies to (exact match, e.g. "exec", "patch"). */
  readonly tool: string;
  /** Glob pattern matched against the subject string. */
  readonly pattern: string;
  readonly action: PermissionAction;
  /** Stable rule origin for audit rendering ("agent" | "session" | ...). */
  readonly origin: string;
}

export type PermissionScope = "agent" | "session";

export interface PermissionEvaluation {
  readonly action: PermissionAction;
  /** The rule that decided the outcome, when one matched. */
  readonly rule: PermissionRule | null;
  /** True when an approval-memory entry decided the outcome. */
  readonly remembered: boolean;
}

export interface PermissionDecisionInput {
  readonly tool: string;
  /**
   * Opaque decision subject: command line for exec-like tools, workspace
   * target path for file tools, server name for MCP tools.
   */
  readonly subject: string;
}

// ─────────────────────────── Zod schemas ───────────────────────────

export const permissionRuleSchema = z.object({
  tool: z.string().min(1).max(128),
  pattern: z.string().min(1).max(4096),
  action: z.enum(["allow", "ask", "deny"]),
  origin: z.string().min(1).max(64),
});

export const permissionConfigSchema = z.object({
  rules: z.array(permissionRuleSchema).max(1024),
  default_action: z.enum(["allow", "ask", "deny"]).default("ask"),
});

export type PermissionConfig = z.infer<typeof permissionConfigSchema>;

/** Decode an unknown permission configuration payload at a trust boundary. */
export function decodePermissionConfig(value: unknown): PermissionConfig {
  return permissionConfigSchema.parse(value);
}

// ────────────────────────── Glob matching ──────────────────────────

/**
 * Compile a permission pattern to a regex.
 *
 * `*` and `**` both match any character sequence (including `/`), because
 * subjects are frequently command lines rather than paths. Everything else
 * is literal.
 */
export function permissionPatternToRegex(pattern: string): RegExp {
  let out = "";
  for (const c of pattern) {
    if (c === "*") {
      out += "[\\s\\S]*";
    } else if (".+?^$(){}[]|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function permissionPatternMatches(pattern: string, subject: string): boolean {
  return permissionPatternToRegex(pattern).test(subject);
}

// ─────────────────────────── Rule merging ──────────────────────────

/**
 * Merge rule sets by concatenation. Later sets win on conflict because
 * evaluation is last-match-wins; callers pass broader scopes first
 * (e.g. agent rules, then session rules).
 */
export function mergePermissionRules(
  ...sets: ReadonlyArray<{
    readonly scope: PermissionScope;
    readonly rules: readonly PermissionRule[];
  }>
): readonly PermissionRule[] {
  return sets.flatMap((set) => set.rules);
}

// ──────────────────────── Approval memory port ─────────────────────

export type ApprovalDurability = "once" | "always";

/**
 * Storage for interactive approval decisions. Implementations must be
 * scoped so that `always` cannot outlive its grant scope (session or task)
 * without an explicit policy decision to persist it.
 */
export interface ApprovalMemory {
  /** Consume a pending one-shot grant for this exact subject. */
  takeOnce(tool: string, subject: string): boolean;
  /** Whether a standing `always` grant exists for this exact subject. */
  hasAlways(tool: string, subject: string): boolean;
  record(tool: string, subject: string, durability: ApprovalDurability): void;
}

export class InMemoryApprovalMemory implements ApprovalMemory {
  private readonly once = new Set<string>();
  private readonly always = new Set<string>();

  private static key(tool: string, subject: string): string {
    return `${tool}\u0000${subject}`;
  }

  takeOnce(tool: string, subject: string): boolean {
    const key = InMemoryApprovalMemory.key(tool, subject);
    if (!this.once.has(key)) return false;
    this.once.delete(key);
    return true;
  }

  hasAlways(tool: string, subject: string): boolean {
    return this.always.has(InMemoryApprovalMemory.key(tool, subject));
  }

  record(tool: string, subject: string, durability: ApprovalDurability): void {
    const key = InMemoryApprovalMemory.key(tool, subject);
    if (durability === "once") {
      this.once.add(key);
      return;
    }
    this.always.add(key);
  }

  clear(): void {
    this.once.clear();
    this.always.clear();
  }
}

// ─────────────────────────── Evaluation ────────────────────────────

/**
 * Evaluate a tool call against the merged rule set.
 *
 * Order of precedence:
 * 1. A pending `once` approval (consumed by this evaluation) ⇒ allow.
 * 2. A standing `always` approval ⇒ allow.
 * 3. The last matching rule, if any.
 * 4. The configured default action.
 */
export function evaluatePermission(
  config: PermissionConfig,
  memory: ApprovalMemory | undefined,
  input: PermissionDecisionInput,
): PermissionEvaluation {
  if (memory !== undefined && input.subject.length > 0) {
    if (memory.takeOnce(input.tool, input.subject)) {
      return { action: "allow", rule: null, remembered: true };
    }
    if (memory.hasAlways(input.tool, input.subject)) {
      return { action: "allow", rule: null, remembered: true };
    }
  }
  for (let i = config.rules.length - 1; i >= 0; i--) {
    const rule = config.rules[i]!;
    if (rule.tool !== input.tool) continue;
    if (!permissionPatternMatches(rule.pattern, input.subject)) continue;
    return { action: rule.action, rule, remembered: false };
  }
  return { action: config.default_action, rule: null, remembered: false };
}

// ───────────────────── Denial envelope rendering ───────────────────

export interface PermissionDenial {
  readonly code: "PERMISSION_DENIED";
  readonly tool: string;
  readonly subject: string;
  /** The deciding rule, or null when the default action denied. */
  readonly rule: PermissionRule | null;
  /** Optional corrected arguments supplied through a deny-with-correction flow. */
  readonly correction: string | null;
}

export function renderDenial(
  input: PermissionDecisionInput,
  rule: PermissionRule | null,
  correction: string | null = null,
): PermissionDenial {
  return {
    code: "PERMISSION_DENIED",
    tool: input.tool,
    subject: input.subject,
    rule,
    correction,
  };
}
