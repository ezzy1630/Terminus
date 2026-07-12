/**
 * @terminus/aci — tests for ToolRegistry, ProgressiveDisclosure, FakeToolExecutor,
 * default tool definitions, and the ToolResult envelope.
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7, ContentHash } from "@terminus/domain";
import {
  ToolRegistry,
  ProgressiveDisclosure,
  FakeToolExecutor,
  registerDefaultTools,
  okResult,
  errorResult,
  DEFAULT_TOOLS,
  READ,
  SEARCH,
  PATCH,
  EXEC,
  JOB,
  INSPECT,
  CAPABILITY,
  type ToolDefinition,
  type ToolCallContext,
  type ToolResult,
  type CapabilityCard,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function fakeHash(seed: string): ContentHash {
  const hex = (seed + "0".repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, "0");
  return `sha256:${hex}` as ContentHash;
}

function mkCtx(): ToolCallContext {
  return {
    toolCallId: "tc-1",
    traceId: "trace-1",
    sessionId: fakeUuid(1),
    taskId: fakeUuid(2),
    turnId: fakeUuid(3),
    workspaceId: fakeUuid(4),
    actorId: "user:test",
    capabilityToken: null,
    policyDecisionId: null,
    signal: null,
    deadlineMs: null,
  };
}

// ────────────────────────── Default tool definitions ─────────────────────────

describe("Default tool definitions", () => {
  test("DEFAULT_TOOLS has exactly 7 tools with the expected ids", () => {
    expect(DEFAULT_TOOLS.length).toBe(7);
    const ids = DEFAULT_TOOLS.map((t) => t.id).sort();
    expect(ids).toEqual(
      ["capability", "exec", "inspect", "job", "patch", "read", "search"].sort(),
    );
  });

  test("each default tool has a non-empty summary, schemas, and a definitionHash", () => {
    for (const t of DEFAULT_TOOLS) {
      expect(t.summary.length).toBeGreaterThan(0);
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0);
      expect(t.definitionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(t.trustLevel).toBe("builtin");
    }
  });

  test("READ has side_effect_class=read", () => {
    expect(READ.sideEffectClass).toBe("read");
  });
  test("PATCH has side_effect_class=workspace_write", () => {
    expect(PATCH.sideEffectClass).toBe("workspace_write");
  });
  test("EXEC has side_effect_class=process", () => {
    expect(EXEC.sideEffectClass).toBe("process");
  });
  test("JOB has side_effect_class=durable_process", () => {
    expect(JOB.sideEffectClass).toBe("durable_process");
  });
  test("CAPABILITY has side_effect_class=capability_activation", () => {
    expect(CAPABILITY.sideEffectClass).toBe("capability_activation");
  });
  test("INSPECT and SEARCH have side_effect_class=read", () => {
    expect(INSPECT.sideEffectClass).toBe("read");
    expect(SEARCH.sideEffectClass).toBe("read");
  });
});

// ────────────────────────── ToolRegistry ─────────────────────────────────────

describe("ToolRegistry", () => {
  test("register and get", () => {
    const r = new ToolRegistry();
    const ex = new FakeToolExecutor("custom");
    const def: ToolDefinition = {
      id: "custom",
      version: "1.0.0",
      summary: "custom tool",
      useWhen: [],
      doNotUseWhen: [],
      inputSchema: { type: "object" },
      resultSchema: { type: "object" },
      sideEffectClass: "none",
      requiredCapabilities: [],
      trustLevel: "builtin",
      maximumModelResultBytes: 1024,
      maximumArtifactBytes: 1024,
      defaultTimeoutMs: 1000,
      policyTags: [],
      definitionHash: fakeHash("custom"),
    };
    r.register(def, ex);
    expect(r.get("custom")).not.toBeNull();
    expect(r.get("custom")!.executor).toBe(ex);
  });

  test("register duplicates throws", () => {
    const r = new ToolRegistry();
    const ex = new FakeToolExecutor("custom");
    const def: ToolDefinition = {
      id: "custom",
      version: "1.0.0",
      summary: "x",
      useWhen: [],
      doNotUseWhen: [],
      inputSchema: {},
      resultSchema: {},
      sideEffectClass: "none",
      requiredCapabilities: [],
      trustLevel: "builtin",
      maximumModelResultBytes: 1024,
      maximumArtifactBytes: 1024,
      defaultTimeoutMs: 1000,
      policyTags: [],
      definitionHash: fakeHash("custom"),
    };
    r.register(def, ex);
    expect(() => r.register(def, ex)).toThrow();
  });

  test("registerDefaultTools registers all 7 with alwaysVisible", () => {
    const r = new ToolRegistry();
    const executors = DEFAULT_TOOLS.map((t) => new FakeToolExecutor(t.id));
    registerDefaultTools(r, executors);
    expect(r.list().length).toBe(7);
    expect(r.listActive().length).toBe(7);
    // Always-visible tools cannot be deactivated.
    expect(() => r.deactivate("read")).toThrow();
  });

  test("activate / deactivate / disable / enable affect listActive", () => {
    const r = new ToolRegistry();
    const ex = new FakeToolExecutor("pack");
    const def: ToolDefinition = {
      id: "pack",
      version: "1.0.0",
      summary: "pack",
      useWhen: [],
      doNotUseWhen: [],
      inputSchema: {},
      resultSchema: {},
      sideEffectClass: "none",
      requiredCapabilities: [],
      trustLevel: "verified_third_party",
      maximumModelResultBytes: 1024,
      maximumArtifactBytes: 1024,
      defaultTimeoutMs: 1000,
      policyTags: [],
      definitionHash: fakeHash("pack"),
    };
    r.register(def, ex);
    expect(r.listActive().find((t) => t.definition.id === "pack")).toBeUndefined();
    r.activate("pack");
    expect(r.listActive().find((t) => t.definition.id === "pack")).toBeDefined();
    r.deactivate("pack");
    expect(r.listActive().find((t) => t.definition.id === "pack")).toBeUndefined();
    r.disable("pack");
    r.activate("pack");
    expect(r.listActive().find((t) => t.definition.id === "pack")).toBeUndefined();
    r.enable("pack");
    r.activate("pack");
    expect(r.listActive().find((t) => t.definition.id === "pack")).toBeDefined();
  });

  test("activeToolSetHash changes when activating a tool", () => {
    const r = new ToolRegistry();
    const ex = new FakeToolExecutor("pack");
    const def: ToolDefinition = {
      id: "pack",
      version: "1.0.0",
      summary: "pack",
      useWhen: [],
      doNotUseWhen: [],
      inputSchema: {},
      resultSchema: {},
      sideEffectClass: "none",
      requiredCapabilities: [],
      trustLevel: "verified_third_party",
      maximumModelResultBytes: 1024,
      maximumArtifactBytes: 1024,
      defaultTimeoutMs: 1000,
      policyTags: [],
      definitionHash: fakeHash("pack"),
    };
    r.register(def, ex);
    const before = r.activeToolSetHash();
    r.activate("pack");
    const after = r.activeToolSetHash();
    expect(after).not.toBe(before);
  });

  test("get on unknown returns null; require throws", () => {
    const r = new ToolRegistry();
    expect(r.get("unknown")).toBeNull();
    expect(() => r.require("unknown")).toThrow();
  });
});

// ────────────────────────── ProgressiveDisclosure ────────────────────────────

describe("ProgressiveDisclosure", () => {
  function mkCard(id: string, name: string, purpose: string): CapabilityCard {
    return {
      id,
      version: "1.0.0",
      kind: "tool_pack",
      name,
      purpose,
      effects: [],
      trustLevel: "verified_third_party",
      schemaCostTokens: 500,
      useWhen: [],
      doNotUseWhen: [],
      definitionHash: fakeHash(id),
    };
  }

  test("searchCards matches by name and purpose", () => {
    const r = new ToolRegistry();
    const pd = new ProgressiveDisclosure({ registry: r, resolveCard: () => null });
    pd.registerCard(mkCard("github", "GitHub Pack", "GitHub PR / issue operations"));
    pd.registerCard(mkCard("db", "Database Pack", "Postgres / MySQL queries"));
    const results = pd.searchCards("github");
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("github");
  });

  test("activate marks active and activates registry tool", () => {
    const r = new ToolRegistry();
    const ex = new FakeToolExecutor("github");
    r.register(
      {
        id: "github",
        version: "1.0.0",
        summary: "github",
        useWhen: [],
        doNotUseWhen: [],
        inputSchema: {},
        resultSchema: {},
        sideEffectClass: "external",
        requiredCapabilities: [],
        trustLevel: "verified_third_party",
        maximumModelResultBytes: 1024,
        maximumArtifactBytes: 1024,
        defaultTimeoutMs: 1000,
        policyTags: [],
        definitionHash: fakeHash("github"),
      },
      ex,
    );
    const pd = new ProgressiveDisclosure({ registry: r, resolveCard: () => null });
    pd.registerCard(mkCard("github", "GitHub Pack", "GitHub operations"));
    expect(pd.isActive("github")).toBe(false);
    pd.activate("github");
    expect(pd.isActive("github")).toBe(true);
    expect(r.listActive().find((t) => t.definition.id === "github")).toBeDefined();
  });

  test("activate is idempotent", () => {
    const r = new ToolRegistry();
    const pd = new ProgressiveDisclosure({ registry: r, resolveCard: () => null });
    pd.registerCard(mkCard("x", "X", "X"));
    pd.activate("x");
    pd.activate("x");
    expect(pd.isActive("x")).toBe(true);
  });

  test("deactivate removes from active", () => {
    const r = new ToolRegistry();
    const pd = new ProgressiveDisclosure({ registry: r, resolveCard: () => null });
    pd.registerCard(mkCard("x", "X", "X"));
    pd.activate("x");
    pd.deactivate("x");
    expect(pd.isActive("x")).toBe(false);
  });

  test("activate unknown throws", () => {
    const r = new ToolRegistry();
    const pd = new ProgressiveDisclosure({ registry: r, resolveCard: () => null });
    expect(() => pd.activate("unknown")).toThrow();
  });

  test("resolveCard is consulted if card not registered", () => {
    const r = new ToolRegistry();
    const pd = new ProgressiveDisclosure({
      registry: r,
      resolveCard: (id) => id === "ext" ? mkCard("ext", "Ext", "External") : null,
    });
    expect(pd.isActive("ext")).toBe(false);
    pd.activate("ext"); // resolves via resolveCard
    expect(pd.isActive("ext")).toBe(true);
  });
});

// ────────────────────────── FakeToolExecutor ─────────────────────────────────

describe("FakeToolExecutor", () => {
  test("returns default ok result when no script", async () => {
    const ex = new FakeToolExecutor("read");
    const r = await ex.execute({ path: "foo" }, mkCtx());
    expect(r.status).toBe("success");
    expect(r.data).toEqual({ path: "foo" });
  });

  test("scripted result is returned and popped", async () => {
    const ex = new FakeToolExecutor("read");
    ex.script({
      result: okResult({ hits: 42 }, {
        toolCallId: "tc-1",
        traceId: "trace-1",
        summary: "found 42 hits",
      }),
    });
    const r = await ex.execute({ q: "foo" }, mkCtx());
    expect(r.status).toBe("success");
    expect((r.data as { hits: number }).hits).toBe(42);
    // Second call returns default (script was popped).
    const r2 = await ex.execute({ q: "bar" }, mkCtx());
    expect((r2.data as { q: string }).q).toBe("bar");
  });

  test("script with matchArgs only matches matching args", async () => {
    const ex = new FakeToolExecutor("read");
    ex.script({
      matchArgs: { path: "src/a.ts" },
      result: okResult({ content: "abc" }, {
        toolCallId: "tc-1",
        traceId: "trace-1",
        summary: "a.ts content",
      }),
    });
    const r1 = await ex.execute({ path: "src/a.ts" }, mkCtx());
    expect((r1.data as { content: string }).content).toBe("abc");
    // Non-matching args don't pop the script; matching args does.
    const r2 = await ex.execute({ path: "src/b.ts" }, mkCtx());
    expect(r2.status).toBe("success");
    expect((r2.data as { path: string }).path).toBe("src/b.ts");
  });

  test("script with throw rethrows", async () => {
    const ex = new FakeToolExecutor("read");
    ex.script({ throw: new Error("boom") });
    await expect(ex.execute({}, mkCtx())).rejects.toThrow("boom");
  });

  test("records calls", async () => {
    const ex = new FakeToolExecutor("read");
    await ex.execute({ a: 1 }, mkCtx());
    await ex.execute({ a: 2 }, mkCtx());
    expect(ex.calls.length).toBe(2);
    expect((ex.calls[0]!.args as { a: number }).a).toBe(1);
  });

  test("errorResult helper", () => {
    const r = errorResult("permission denied", {
      toolCallId: "tc",
      traceId: "tr",
      status: "denied",
    });
    expect(r.status).toBe("denied");
    expect(r.summary).toBe("permission denied");
    expect(r.data).toBeNull();
  });
});

// ────────────────────────── ToolResult envelope ──────────────────────────────

describe("ToolResult envelope", () => {
  test("okResult produces a well-formed envelope", () => {
    const r = okResult({ x: 1 }, {
      toolCallId: "tc",
      traceId: "tr",
      summary: "ok",
    });
    expect(r.status).toBe("success");
    expect(r.summary).toBe("ok");
    expect((r.data as { x: number }).x).toBe(1);
    expect(r.truncation.occurred).toBe(false);
    expect(r.diagnostics).toEqual([]);
    expect(r.sideEffects).toEqual([]);
    expect(r.trust).toBe("derived");
    expect(r.confidentiality).toBe("workspace");
    expect(r.timing.totalMs).toBe(0);
    expect(r.toolCallId).toBe("tc");
    expect(r.traceId).toBe("tr");
    expect(r.estimatedCostUsd).toBeNull();
    expect(r.policyDecisionId).toBeNull();
    expect(r.resourceUsage.cpuMs).toBeNull();
  });

  test("envelope shape matches §34.4 fields", () => {
    const r: ToolResult<unknown> = okResult(null, {
      toolCallId: "tc",
      traceId: "tr",
      summary: "x",
    });
    // Required fields per §34.4:
    expect(typeof r.status).toBe("string");
    expect(typeof r.summary).toBe("string");
    expect(Array.isArray(r.artifacts)).toBe(true);
    expect(typeof r.sourceVersions).toBe("object");
    expect(r.truncation).toBeDefined();
    expect(Array.isArray(r.diagnostics)).toBe(true);
    expect(Array.isArray(r.sideEffects)).toBe(true);
    expect(typeof r.trust).toBe("string");
    expect(typeof r.confidentiality).toBe("string");
    expect(r.timing).toBeDefined();
    expect(r.resourceUsage).toBeDefined();
    expect(typeof r.toolCallId).toBe("string");
    expect(typeof r.traceId).toBe("string");
  });
});
