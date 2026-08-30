import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const fixture = resolve(import.meta.dir, "../../scripts/e2e/provider-stdio-fixture.ts");

async function invokeProvider(body: JsonObject, env: Readonly<Record<string, string>> = {}): Promise<JsonObject[]> {
  const child = Bun.spawn([process.execPath, fixture], {
    env: {
      ...Bun.env,
      TERMINUS_PROVIDER_PROTOCOL: "terminus.local-provider.v1",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({
    protocol: "terminus.local-provider.v1",
    provider: "local",
    model: "local/e2e-model",
    body,
  })}\n`);
  child.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

function toolCall(chunks: JsonObject[]): JsonObject {
  const chunk = chunks.find((candidate) => candidate.kind === "tool_call");
  expect(chunk).toBeDefined();
  const call = chunk?.tool_call;
  expect(typeof call).toBe("object");
  expect(call).not.toBeNull();
  expect(Array.isArray(call)).toBe(false);
  return call as JsonObject;
}

function toolCalls(chunks: JsonObject[]): JsonObject[] {
  return chunks
    .filter((candidate) => candidate.kind === "tool_call")
    .map((chunk) => {
      const call = chunk.tool_call;
      expect(typeof call).toBe("object");
      expect(call).not.toBeNull();
      expect(Array.isArray(call)).toBe(false);
      return call as JsonObject;
    });
}

describe("deterministic provider fixture", () => {
  test("reads and patches the build-failure task through model-facing tools", async () => {
    const taskMessage = {
      role: "user",
      content: "Task ID: `build-001` Add the missing import.",
    };
    const minimalStart = await invokeProvider({ messages: [taskMessage] });
    expect(toolCall(minimalStart)).toMatchObject({
      tool_name: "capability",
      arguments: { action: "activate_workspace" },
    });

    const adaptiveStart = await invokeProvider({
      messages: [taskMessage],
      tools: [
        { type: "function", function: { name: "inspect", description: "Inspect code", parameters: {} } },
        { type: "function", function: { name: "read", description: "Read a file", parameters: {} } },
      ],
    });
    expect(toolCalls(adaptiveStart)).toEqual([expect.objectContaining({
      tool_name: "read",
      arguments: { path: "src/main.py", render: "raw" },
    })]);

    const adaptiveInspectStart = await invokeProvider({
      messages: [taskMessage],
      tools: [
        { type: "function", function: { name: "inspect", description: "Inspect code", parameters: {} } },
        { type: "function", function: { name: "read", description: "Read a file", parameters: {} } },
      ],
    }, { TERMINUS_E2E_EXPECT_INSPECT: "1" });
    expect(toolCalls(adaptiveInspectStart)).toEqual([expect.objectContaining({
      tool_name: "inspect",
      arguments: { action: "repository_map", limit: 10 },
    })]);

    const afterActivation = await invokeProvider({
      messages: [
        taskMessage,
        {
          role: "tool",
          name: "capability",
          content: JSON.stringify({ workspace_activated: true }),
        },
      ],
    });
    expect(toolCall(afterActivation)).toMatchObject({
      tool_name: "read",
      arguments: { path: "src/main.py", render: "raw" },
    });

    const source = `"""Small command entry point with an import-time build failure."""

from .runner import run


def main(argv: list[str] | None = None) -> int:
    """Run the command and return its process status."""
    if argv is None:
        argv = []
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
`;
    const afterRead = await invokeProvider({
      messages: [
        taskMessage,
        {
          role: "tool",
          name: "read",
          content: JSON.stringify({
            path: "src/main.py",
            file_sha256: "sha256:fixture",
            content: source,
          }),
        },
      ],
    });
    const patch = toolCall(afterRead);
    expect(patch.tool_name).toBe("patch");
    expect(patch.arguments).toMatchObject({
      path: "src/main.py",
      expected_utf8: source,
      replacement_utf8: source.replace(
        "from .runner import run",
        "import sys\n\nfrom .runner import run",
      ),
    });

    const afterPatch = await invokeProvider({
      messages: [
        taskMessage,
        {
          role: "tool",
          name: "read",
          content: JSON.stringify({
            path: "src/main.py",
            file_sha256: "sha256:fixture",
            content: source,
          }),
        },
        {
          role: "tool",
          name: "patch",
          content: JSON.stringify({
            path: "src/main.py",
            new_sha256: "sha256:patched",
          }),
        },
      ],
    });
    expect(toolCall(afterPatch)).toMatchObject({
      tool_name: "exec",
      arguments: {
        cmd: 'git status --short -- "src/main.py"',
        workdir: ".",
      },
    });
  });
});
