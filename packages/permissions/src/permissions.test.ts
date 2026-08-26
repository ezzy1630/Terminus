import { describe, expect, test } from "bun:test";
import {
  decodePermissionConfig,
  evaluatePermission,
  InMemoryApprovalMemory,
  mergePermissionRules,
  permissionPatternMatches,
  renderDenial,
  type PermissionConfig,
  type PermissionDecisionInput,
  type PermissionRule,
} from "./index.js";

function rule(
  tool: string,
  pattern: string,
  action: PermissionRule["action"],
  origin: PermissionRule["origin"] = "agent",
): PermissionRule {
  return { tool, pattern, action, origin };
}

function config(rules: readonly PermissionRule[], defaultAction: PermissionConfig["default_action"] = "ask"): PermissionConfig {
  return { rules: [...rules], default_action: defaultAction };
}

const base: PermissionDecisionInput = { tool: "exec", subject: "rm -rf /tmp/x" };

describe("permissionPatternToRegex / permissionPatternMatches", () => {
  test("* matches across slashes and spaces (command subjects)", () => {
    expect(permissionPatternMatches("git *", "git status --porcelain")).toBe(true);
    expect(permissionPatternMatches("npm run *", "npm run build/all")).toBe(true);
    expect(permissionPatternMatches("**", "anything at all")).toBe(true);
  });

  test("regex metacharacters in patterns are literal", () => {
    expect(permissionPatternMatches("ls -la (all)", "ls -la (all)")).toBe(true);
    expect(permissionPatternMatches("ls -la (all)", "ls -la all")).toBe(false);
    expect(permissionPatternMatches("a+b", "aab")).toBe(false);
    expect(permissionPatternMatches("a.b", "aXb")).toBe(false);
  });

  test("patterns are anchored", () => {
    expect(permissionPatternMatches("git status", "prefix git status")).toBe(false);
    expect(permissionPatternMatches("git status", "git status --short")).toBe(false);
  });
});

describe("evaluatePermission", () => {
  test("no matching rule falls back to ask by default (fail closed)", () => {
    const decision = evaluatePermission(config([rule("patch", "*", "allow")]), undefined, base);
    expect(decision).toEqual({ action: "ask", rule: null, remembered: false });
  });

  test("explicit default_action is honored when no rule matches", () => {
    const decision = evaluatePermission(config([], "deny"), undefined, base);
    expect(decision.action).toBe("deny");
    expect(decision.rule).toBeNull();
  });

  test("last matching rule wins", () => {
    const cfg = config([
      rule("exec", "*", "deny"),
      rule("exec", "git *", "allow"),
      rule("exec", "git push*", "deny"),
    ]);
    expect(evaluatePermission(cfg, undefined, { tool: "exec", subject: "git status" }).action).toBe("allow");
    expect(evaluatePermission(cfg, undefined, { tool: "exec", subject: "git push origin main" }).action).toBe("deny");
    expect(evaluatePermission(cfg, undefined, { tool: "exec", subject: "make test" }).action).toBe("deny");
  });

  test("rules for other tools never match", () => {
    const cfg = config([rule("patch", "*", "deny")]);
    expect(evaluatePermission(cfg, undefined, base).action).toBe("ask");
  });

  test("once approval admits exactly one evaluation", () => {
    const memory = new InMemoryApprovalMemory();
    memory.record(base.tool, base.subject, "once");
    const first = evaluatePermission(config([]), memory, base);
    expect(first).toEqual({ action: "allow", rule: null, remembered: true });
    const second = evaluatePermission(config([]), memory, base);
    expect(second.action).toBe("ask");
  });

  test("always approval persists until cleared", () => {
    const memory = new InMemoryApprovalMemory();
    memory.record(base.tool, base.subject, "always");
    for (let i = 0; i < 3; i++) {
      expect(evaluatePermission(config([]), memory, base).action).toBe("allow");
    }
    memory.clear();
    expect(evaluatePermission(config([]), memory, base).action).toBe("ask");
  });

  test("approvals are exact-subject scoped", () => {
    const memory = new InMemoryApprovalMemory();
    memory.record("exec", "git status", "always");
    expect(evaluatePermission(config([]), memory, { tool: "exec", subject: "git status" }).action).toBe("allow");
    expect(evaluatePermission(config([]), memory, { tool: "exec", subject: "git status -s" }).action).toBe("ask");
    expect(evaluatePermission(config([]), memory, { tool: "patch", subject: "git status" }).action).toBe("ask");
  });

  test("empty subject never consults approval memory", () => {
    const memory = new InMemoryApprovalMemory();
    memory.record("exec", "", "always");
    expect(evaluatePermission(config([]), memory, { tool: "exec", subject: "" }).action).toBe("ask");
  });

  test("mergePermissionRules concatenates so later scopes override earlier ones", () => {
    const merged = mergePermissionRules(
      { scope: "agent", rules: [rule("exec", "curl *", "allow")] },
      { scope: "session", rules: [rule("exec", "curl *", "deny")] },
    );
    const cfg = config(merged);
    expect(evaluatePermission(cfg, undefined, { tool: "exec", subject: "curl example.com" }).action).toBe("deny");
  });
});

describe("decodePermissionConfig", () => {
  test("decodes a valid payload and applies the documented default", () => {
    const decoded = decodePermissionConfig({
      rules: [{ tool: "exec", pattern: "git *", action: "allow", origin: "agent" }],
    });
    expect(decoded.default_action).toBe("ask");
    expect(decoded.rules).toHaveLength(1);
  });

  test("rejects malformed payloads", () => {
    expect(() => decodePermissionConfig({ rules: "all" })).toThrow();
    expect(() => decodePermissionConfig({ rules: [{ tool: "", pattern: "*", action: "allow" }] })).toThrow();
    expect(() =>
      decodePermissionConfig({ rules: [], default_action: "sometimes" }),
    ).toThrow();
  });
});

describe("renderDenial", () => {
  test("carries the deciding rule and optional correction", () => {
    const r = rule("exec", "rm -rf *", "deny");
    const denial = renderDenial(base, r, "use `rm -rf ./build` instead");
    expect(denial.code).toBe("PERMISSION_DENIED");
    expect(denial.rule?.pattern).toBe("rm -rf *");
    expect(denial.correction).toContain("rm -rf ./build");
  });
});
