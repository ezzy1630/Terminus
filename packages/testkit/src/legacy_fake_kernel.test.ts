import { describe, expect, test } from "bun:test";
import { FakeKernel, buildCommandSpec } from "./index.js";

describe("legacy FakeKernel", () => {
  test("fails closed unless sandbox settlement is explicitly scripted", async () => {
    const kernel = new FakeKernel();
    const command = buildCommandSpec();

    await expect(kernel.sandboxExec("fixture", command)).rejects.toThrow(
      "no explicit scripted settlement",
    );

    kernel.scriptSandboxResult({ exitCode: 7 });
    await expect(kernel.sandboxExec("fixture", command)).resolves.toEqual({ exitCode: 7 });
    expect(kernel.sandboxCalls).toHaveLength(2);
  });
});
