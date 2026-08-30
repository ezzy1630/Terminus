import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const fixture = resolve(import.meta.dir, "../../scripts/e2e/provider-stdio-fixture.ts");

async function invokeProvider(body: JsonObject): Promise<JsonObject[]> {
  const child = Bun.spawn([process.execPath, fixture], {
    env: {
      ...Bun.env,
      TERMINUS_PROVIDER_PROTOCOL: "terminus.local-provider.v1",
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

describe("deterministic provider fixture", () => {
  test("reads and patches the build-failure task through model-facing tools", async () => {
    const taskMessage = {
      role: "user",
      content: "Task ID: `build-001` Add the missing import.",
    };
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
  });
});
