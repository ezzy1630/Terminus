/**
 * MCP / tool-schema fuzz smoke (SPEC §46.4).
 */
import { describe, expect, test } from "bun:test";
import { mcpServerRegistrationSchema } from "./mcp_admission.js";

describe("MCP tool schema fuzz smoke", () => {
  test("arbitrary JSON never panics the zod decoder", () => {
    const samples: unknown[] = [
      null,
      1,
      "x",
      [],
      {},
      { id: 1 },
      { tools: [{ name: "x" }] },
      {
        id: "mcp.demo",
        version: "1.0.0",
        transport: "stdio",
        commandOrUrl: "demo",
        pinnedPackageOrImageDigest: `sha256:${"aa".repeat(32)}`,
        descriptorHash: `sha256:${"bb".repeat(32)}`,
        protocolVersion: "2024-11-05",
        trustLevel: "untrusted",
        sandboxProfile: "default",
        allowedToolIds: ["t1"],
        filesystemScope: { read: [], write: [] },
        networkScope: [],
        secretCapabilities: [],
        rateLimits: { requestsPerMinute: 10, burst: 2 },
        outputLimits: { maxOutputBytes: 1024, maxArtifactBytes: 1024 },
        approvalPolicy: "always",
        tools: [
          {
            name: "t1",
            description: "d",
            inputSchema: { type: "object" },
            effectClass: "read_only",
          },
        ],
        signature: null,
        publisher: null,
      },
    ];
    for (const sample of samples) {
      const result = mcpServerRegistrationSchema.safeParse(sample);
      expect(typeof result.success).toBe("boolean");
    }
  });
});
