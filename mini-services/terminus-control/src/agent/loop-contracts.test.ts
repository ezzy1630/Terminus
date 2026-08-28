import { describe, expect, test } from "bun:test";
import { ForgeError } from "@terminus/domain";
import { classifyLoopError } from "./loop-contracts.js";

interface CauseLink {
  readonly name: string | null;
  readonly message: string;
  readonly code?: string | number;
  readonly truncated?: true;
}

function causeChain(details: Readonly<Record<string, unknown>>): readonly CauseLink[] {
  const chain = details.cause_chain;
  if (!Array.isArray(chain)) throw new Error("classified error carried no cause chain");
  return chain as readonly CauseLink[];
}

describe("H6 classified errors carry their cause", () => {
  test("an untyped error keeps its name, message, and cause chain", () => {
    const root = new Error("EACCES: permission denied, open '/etc/shadow'");
    root.name = "SystemError";
    const middle = new Error("kernel file read failed", { cause: root });
    const outer = new Error("tool settlement failed", { cause: middle });

    const classified = classifyLoopError(outer);
    expect(classified.envelope.details).not.toEqual({});
    const chain = causeChain(classified.envelope.details);
    expect(chain.map((link) => link.message)).toEqual([
      "tool settlement failed",
      "kernel file read failed",
      "EACCES: permission denied, open '/etc/shadow'",
    ]);
    expect(chain[2]?.name).toBe("SystemError");
  });

  test("a grpc-js numeric code is classified instead of collapsing to INTERNAL", () => {
    const cases: readonly [number, string, string][] = [
      [3, "INVALID_ARGUMENT", "validation"],
      [7, "PERMISSION_DENIED", "policy_denied"],
      [4, "DEADLINE_EXCEEDED", "timeout"],
      [14, "UNAVAILABLE", "transport"],
    ];
    for (const [code, expectedCode, expectedCategory] of cases) {
      const error = Object.assign(new Error("kernel request failed"), {
        code,
        details: "artifact link denied by allowlist",
      });
      const classified = classifyLoopError(error);
      expect(`${code}:${classified.envelope.code}`).toBe(`${code}:${expectedCode}`);
      expect(`${code}:${classified.envelope.category}`).toBe(`${code}:${expectedCategory}`);
      expect(classified.envelope.details.grpc_status).toBe(expectedCode);
      expect(classified.envelope.details.transport_details).toBe("artifact link denied by allowlist");
    }
  });

  test("transport and timeout grpc faults are marked retryable, validation is not", () => {
    const unavailable = classifyLoopError(Object.assign(new Error("no kernel"), { code: 14 }));
    const invalid = classifyLoopError(Object.assign(new Error("bad request"), { code: 3 }));
    expect(unavailable.envelope.retryable).toBe(true);
    expect(unavailable.kind).toBe("provider");
    expect(invalid.envelope.retryable).toBe(false);
  });

  test("PERMISSION_DENIED maps to the policy kind so the loop stops correctly", () => {
    expect(classifyLoopError(Object.assign(new Error("denied"), { code: 7 })).kind).toBe("policy_denied");
    expect(classifyLoopError(Object.assign(new Error("exhausted"), { code: 8 })).kind).toBe("budget_exhausted");
    expect(classifyLoopError(Object.assign(new Error("cancelled"), { code: 1 })).kind).toBe("cancelled");
  });

  test("truncation is announced, never silent", () => {
    const long = "x".repeat(2_000);
    const classified = classifyLoopError(new Error(long));
    const chain = causeChain(classified.envelope.details);
    expect(chain[0]?.truncated).toBe(true);
    expect(chain[0]?.message.length).toBe(512);
    expect(classified.envelope.message.endsWith("…")).toBe(true);
  });

  test("a cause cycle terminates instead of hanging", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b, writable: true });
    const chain = causeChain(classifyLoopError(b).envelope.details);
    expect(chain.length).toBe(2);
  });

  test("a deep chain reports that it was bounded", () => {
    let error = new Error("root");
    for (let depth = 0; depth < 10; depth += 1) {
      error = new Error(`layer-${depth}`, { cause: error });
    }
    const details = classifyLoopError(error).envelope.details;
    expect(causeChain(details).length).toBe(5);
    expect(details.cause_chain_truncated).toBe(true);
  });

  test("a ForgeError keeps its structured details and gains its cause", () => {
    const root = new Error("kernel socket closed");
    const forge = new ForgeError({
      code: "PROVIDER_UNAVAILABLE",
      message: "no kernel-brokered provider transport is configured for 'local'",
      details: { transport: "local" },
      cause: root,
    });
    const classified = classifyLoopError(forge);
    expect(classified.envelope.code).toBe("PROVIDER_UNAVAILABLE");
    expect(classified.envelope.details.transport).toBe("local");
    expect(causeChain(classified.envelope.details).map((link) => link.message))
      .toEqual(["kernel socket closed"]);
  });

  test("a ForgeError without a cause keeps exactly its own details", () => {
    const forge = new ForgeError({
      code: "POLICY_DENIED",
      message: "required context blocked by confidentiality policy",
      details: { authority: "platform-authority" },
    });
    expect(classifyLoopError(forge).envelope.details).toEqual({ authority: "platform-authority" });
  });
});
