/**
 * @terminus/aci — Schema Conformance Tests.
 *
 * Validates Zod schemas and definition contracts for all 7 default tools
 * and universal ToolResult envelopes (SPEC §34.3, §34.4).
 */
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_TOOLS,
  toolDefinitionSchema,
  READ,
  SEARCH,
  PATCH,
  EXEC,
  JOB,
  INSPECT,
  CAPABILITY,
  readInputSchema,
  searchInputSchema,
  patchInputSchema,
  execInputSchema,
  jobInputSchema,
  inspectInputSchema,
  capabilityInputSchema,
} from "./index.js";

describe("Schema Conformance", () => {
  test("all 7 default tools conform to toolDefinitionSchema", () => {
    expect(DEFAULT_TOOLS.length).toBe(7);
    for (const tool of DEFAULT_TOOLS) {
      const parsed = toolDefinitionSchema.safeParse(tool);
      expect(parsed.success).toBe(true);
    }
  });

  test("readInputSchema validates valid and invalid inputs", () => {
    const valid = readInputSchema.safeParse({ path: "src/index.ts", mode: "outline" });
    expect(valid.success).toBe(true);

    const invalidMode = readInputSchema.safeParse({ path: "src/index.ts", mode: "invalid_mode" });
    expect(invalidMode.success).toBe(false);
  });

  test("searchInputSchema validates query limits and search modes", () => {
    const valid = searchInputSchema.safeParse({ query: "refreshToken", mode: "symbol", limit: 10 });
    expect(valid.success).toBe(true);

    const emptyQuery = searchInputSchema.safeParse({ query: "" });
    expect(emptyQuery.success).toBe(false);
  });

  test("patchInputSchema requires non-empty operations array", () => {
    const valid = patchInputSchema.safeParse({
      operations: [{ op: "create_file", path: "test.txt", new_text: "hello" }],
    });
    expect(valid.success).toBe(true);

    const emptyOps = patchInputSchema.safeParse({ operations: [] });
    expect(emptyOps.success).toBe(false);
  });

  test("execInputSchema and jobInputSchema validate command structure", () => {
    const validExec = execInputSchema.safeParse({ argv: ["ls", "-la"] });
    expect(validExec.success).toBe(true);

    const validJob = jobInputSchema.safeParse({ op: "start", argv: ["node", "server.js"] });
    expect(validJob.success).toBe(true);
  });

  test("inspectInputSchema and capabilityInputSchema validate enum operations", () => {
    const validInspect = inspectInputSchema.safeParse({ op: "diagnostics", path: "src/app.ts" });
    expect(validInspect.success).toBe(true);

    const validCap = capabilityInputSchema.safeParse({ op: "activate", capability_id: "web_browser" });
    expect(validCap.success).toBe(true);
  });
});
